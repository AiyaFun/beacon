import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import {
  listSkillsForTenant,
  listInstalledSkills,
  installSkill,
  uninstallSkill,
  createCustomSkill,
} from '@/lib/skills';

// 技能安装域：真 SQLite（每文件独立临时库，见 tests/setup/）。
// 要验的正是 DB 语义——@@unique([tenantId, skillId]) 保证的幂等、跨租户可见性隔离。

async function mkTenant(name = '租户') {
  return prisma.tenant.create({ data: { name, plan: 'free' } });
}

async function mkBuiltin(slug = 'wechat-format') {
  return prisma.contentSkill.create({
    data: {
      slug,
      name: `内置技能 ${slug}`,
      description: '测试用内置技能',
      platform: 'wechat',
      category: 'format',
      outputKind: 'html',
      promptTemplate: '排版这段内容：{{content}}',
      isBuiltin: true,
      tenantId: null,
    },
  });
}

const CUSTOM_INPUT = {
  name: '我的技能',
  description: '把正文变成三条评论',
  platform: 'douyin',
  promptTemplate: '把{{content}}变成三条评论',
  outputKind: 'text' as const,
};

beforeEach(async () => {
  await prisma.skillInstall.deleteMany();
  await prisma.contentSkill.deleteMany();
  await prisma.tenant.deleteMany();
});

describe('listSkillsForTenant · 可见性', () => {
  it('内置技能全租户可见，未安装时 installed=false enabled=false', async () => {
    const t = await mkTenant();
    await mkBuiltin();
    const list = await listSkillsForTenant(t.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ slug: 'wechat-format', isBuiltin: true, installed: false, enabled: false });
  });

  it('本租户自定义可见，别家租户的自定义不可见', async () => {
    const a = await mkTenant('A');
    const b = await mkTenant('B');
    await createCustomSkill(a.id, CUSTOM_INPUT);
    expect((await listSkillsForTenant(a.id)).map((s) => s.name)).toEqual(['我的技能']);
    expect(await listSkillsForTenant(b.id)).toEqual([]);
  });

  it('skill.enabled=false（下架）的技能不出现', async () => {
    const t = await mkTenant();
    const skl = await mkBuiltin();
    await prisma.contentSkill.update({ where: { id: skl.id }, data: { enabled: false } });
    expect(await listSkillsForTenant(t.id)).toEqual([]);
  });

  it('安装后 installed=true enabled=true', async () => {
    const t = await mkTenant();
    const skl = await mkBuiltin();
    await installSkill(t.id, skl.id);
    const [row] = await listSkillsForTenant(t.id);
    expect(row.installed).toBe(true);
    expect(row.enabled).toBe(true);
  });
});

describe('installSkill · 幂等与隔离', () => {
  it('重复安装幂等：只留一条安装关系', async () => {
    const t = await mkTenant();
    const skl = await mkBuiltin();
    await installSkill(t.id, skl.id);
    await installSkill(t.id, skl.id);
    expect(await prisma.skillInstall.count({ where: { tenantId: t.id, skillId: skl.id } })).toBe(1);
  });

  it('A 租户装不了 B 租户的自定义技能', async () => {
    const a = await mkTenant('A');
    const b = await mkTenant('B');
    const bSkill = await createCustomSkill(b.id, CUSTOM_INPUT);
    await expect(installSkill(a.id, bSkill.id)).rejects.toThrow('不能安装其他团队的自定义技能');
    expect(await prisma.skillInstall.count({ where: { tenantId: a.id } })).toBe(0);
  });

  it('技能不存在 / 已下架 → 拒绝', async () => {
    const t = await mkTenant();
    await expect(installSkill(t.id, 'no-such-id')).rejects.toThrow('不存在或已下架');
    const skl = await mkBuiltin();
    await prisma.contentSkill.update({ where: { id: skl.id }, data: { enabled: false } });
    await expect(installSkill(t.id, skl.id)).rejects.toThrow('不存在或已下架');
  });

  it('两个租户安装同一内置技能互不影响', async () => {
    const a = await mkTenant('A');
    const b = await mkTenant('B');
    const skl = await mkBuiltin();
    await installSkill(a.id, skl.id);
    await installSkill(b.id, skl.id);
    await uninstallSkill(a.id, skl.id);
    expect((await listSkillsForTenant(a.id))[0].installed).toBe(false);
    expect((await listSkillsForTenant(b.id))[0].installed).toBe(true);
  });
});

describe('uninstallSkill · 幂等', () => {
  it('卸载后安装关系删除；重复卸载不炸', async () => {
    const t = await mkTenant();
    const skl = await mkBuiltin();
    await installSkill(t.id, skl.id);
    await uninstallSkill(t.id, skl.id);
    expect(await prisma.skillInstall.count()).toBe(0);
    await expect(uninstallSkill(t.id, skl.id)).resolves.toBeUndefined();
    await expect(uninstallSkill(t.id, 'no-such-id')).resolves.toBeUndefined();
  });
});

describe('createCustomSkill · 创建即自动安装', () => {
  it('slug 为 custom- 前缀，创建后立即出现在已安装列表', async () => {
    const t = await mkTenant();
    const skl = await createCustomSkill(t.id, CUSTOM_INPUT);
    expect(skl.slug).toMatch(/^custom-c/);
    expect(skl.installed).toBe(true);
    expect(skl.enabled).toBe(true);
    expect(skl.isBuiltin).toBe(false);
    const installed = await listInstalledSkills(t.id);
    expect(installed.map((x) => x.id)).toEqual([skl.id]);
  });

  it('两次创建 slug 不冲突', async () => {
    const t = await mkTenant();
    const s1 = await createCustomSkill(t.id, CUSTOM_INPUT);
    const s2 = await createCustomSkill(t.id, { ...CUSTOM_INPUT, name: '技能二' });
    expect(s1.slug).not.toBe(s2.slug);
  });

  it('校验：名称/描述/模板为空、模板缺 {{content}}、非法输出形态一律拒', async () => {
    const t = await mkTenant();
    await expect(createCustomSkill(t.id, { ...CUSTOM_INPUT, name: ' ' })).rejects.toThrow('起个名字');
    await expect(createCustomSkill(t.id, { ...CUSTOM_INPUT, description: '' })).rejects.toThrow('一句话描述');
    await expect(createCustomSkill(t.id, { ...CUSTOM_INPUT, promptTemplate: '' })).rejects.toThrow('不能为空');
    await expect(createCustomSkill(t.id, { ...CUSTOM_INPUT, promptTemplate: '没有占位符的模板' })).rejects.toThrow('{{content}}');
    await expect(
      createCustomSkill(t.id, { ...CUSTOM_INPUT, outputKind: 'pdf' as never }),
    ).rejects.toThrow('输出形态');
  });

  it('emoji 缺省为 ✨，platform 空串回落 generic', async () => {
    const t = await mkTenant();
    const skl = await createCustomSkill(t.id, { ...CUSTOM_INPUT, platform: ' ' });
    expect(skl.emoji).toBe('✨');
    expect(skl.platform).toBe('generic');
  });
});

describe('listInstalledSkills · 只给已安装且启用', () => {
  it('未安装的内置技能不出现', async () => {
    const t = await mkTenant();
    await mkBuiltin();
    expect(await listInstalledSkills(t.id)).toEqual([]);
  });

  it('install.enabled=false 的不出现', async () => {
    const t = await mkTenant();
    const skl = await mkBuiltin();
    await installSkill(t.id, skl.id);
    await prisma.skillInstall.updateMany({ where: { tenantId: t.id, skillId: skl.id }, data: { enabled: false } });
    expect(await listInstalledSkills(t.id)).toEqual([]);
  });

  it('跨租户隔离：只看到自己的安装', async () => {
    const a = await mkTenant('A');
    const b = await mkTenant('B');
    const skl = await mkBuiltin();
    await installSkill(b.id, skl.id);
    expect(await listInstalledSkills(a.id)).toEqual([]);
    expect((await listInstalledSkills(b.id)).map((x) => x.slug)).toEqual(['wechat-format']);
  });
});
