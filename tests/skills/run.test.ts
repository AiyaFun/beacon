import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import {
  runSkill,
  gateSkillOutput,
  installSkill,
  createCustomSkill,
  preinstallSkillsForPlatforms,
  listInstalledSkills,
} from '@/lib/skills';
import { invalidateDfaCache } from '@/lib/compliance/engine';

// runSkill 全链路：真 SQLite + Mock LLM（清掉平台默认 LLM env，网关必然落到 Mock，零网络）。
// 合规拦截层（gateSkillOutput）单独测：红线口径 = legal+block，与导出硬闸完全同语义。

delete process.env.BEACON_DEFAULT_LLM_BASE_URL;
delete process.env.BEACON_DEFAULT_LLM_API_KEY;

async function mkTenant(name = '租户') {
  return prisma.tenant.create({ data: { name, plan: 'free' } });
}

async function mkInstalledBuiltin(tenantId: string) {
  const skill = await prisma.contentSkill.create({
    data: {
      slug: 'xhs-format',
      name: '小红书图文排版',
      description: '测试用',
      platform: 'xiaohongshu',
      category: 'format',
      outputKind: 'text',
      promptTemplate: '标题：{{title}}\n{{persona}}\n请把下面的内容排版成小红书笔记：\n{{content}}',
      isBuiltin: true,
      tenantId: null,
    },
  });
  await installSkill(tenantId, skill.id);
  return skill;
}

async function seedWord(word: string, tier: string, action: string) {
  await prisma.sensitiveWord.create({
    data: { word, tier, action, category: 'test', version: 'test', enabled: true },
  });
  // 镜像生产写入路径：actAddCustomWord 增词后会 invalidateDfaCache()，
  // 这里同样失效，让「加词后当次检测即生效」的断言反映真实行为。
  invalidateDfaCache();
}

beforeEach(async () => {
  await prisma.llmCallLog.deleteMany();
  await prisma.sensitiveWord.deleteMany();
  await prisma.skillInstall.deleteMany();
  await prisma.contentSkill.deleteMany();
  await prisma.tenant.deleteMany();
});

describe('runSkill · Mock LLM 下的正常链路', () => {
  it('返回 ok:true，mocked=true 必须透传（UI 要标「演示结果」）', async () => {
    const t = await mkTenant();
    const skill = await mkInstalledBuiltin(t.id);
    const r = await runSkill({ tenantId: t.id, skillId: skill.id, content: '今天分享一个好用的方法', title: '标题', persona: '美食博主' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mocked).toBe(true);
    expect(r.output.length).toBeGreaterThan(0);
    expect(r.outputKind).toBe('text');
    expect(r.skillName).toBe('小红书图文排版');
    expect(r.riskLevel).toBe('pass'); // 空词库 → 无命中
    expect(r.hits).toEqual([]);
  });

  it('走的是统一网关：产生一条 fn=generation 的调用账目', async () => {
    const t = await mkTenant();
    const skill = await mkInstalledBuiltin(t.id);
    await runSkill({ tenantId: t.id, skillId: skill.id, content: '内容' });
    const logs = await prisma.llmCallLog.findMany({ where: { tenantId: t.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0].fn).toBe('generation');
    expect(logs[0].mocked).toBe(true);
  });

  it('title/persona 缺省不炸', async () => {
    const t = await mkTenant();
    const skill = await mkInstalledBuiltin(t.id);
    const r = await runSkill({ tenantId: t.id, skillId: skill.id, content: '只有正文' });
    expect(r.ok).toBe(true);
  });
});

describe('runSkill · 拒绝路径', () => {
  it('正文为空 → ok:false', async () => {
    const t = await mkTenant();
    const skill = await mkInstalledBuiltin(t.id);
    const r = await runSkill({ tenantId: t.id, skillId: skill.id, content: '   ' });
    expect(r).toMatchObject({ ok: false });
  });

  it('未安装的技能不能跑', async () => {
    const t = await mkTenant();
    const skill = await prisma.contentSkill.create({
      data: {
        slug: 'wechat-format', name: '公众号排版', description: 'x', platform: 'wechat',
        category: 'format', outputKind: 'html', promptTemplate: '{{content}}', isBuiltin: true, tenantId: null,
      },
    });
    const r = await runSkill({ tenantId: t.id, skillId: skill.id, content: '正文' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('还没安装');
  });

  it('跨租户隔离：A 跑不了 B 的自定义技能（即使拿到了 id）', async () => {
    const a = await mkTenant('A');
    const b = await mkTenant('B');
    const bSkill = await createCustomSkill(b.id, {
      name: 'B的技能', description: 'x', platform: 'generic',
      promptTemplate: '处理{{content}}', outputKind: 'text',
    });
    const r = await runSkill({ tenantId: a.id, skillId: bSkill.id, content: '正文' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('其他团队');
  });

  it('技能不存在 → ok:false', async () => {
    const t = await mkTenant();
    const r = await runSkill({ tenantId: t.id, skillId: 'no-such-id', content: '正文' });
    expect(r).toMatchObject({ ok: false });
  });
});

describe('runSkill · image 技能（AI 封面）', () => {
  async function mkInstalledImageSkill(tenantId: string) {
    const skill = await prisma.contentSkill.create({
      data: {
        slug: 'xhs-cover', name: '小红书封面', description: 'x', platform: 'xiaohongshu',
        category: 'visual', outputKind: 'image',
        promptTemplate: '从下面提炼封面要素\n{{context}}\n{{brief}}\n{{content}}', isBuiltin: true, tenantId: null,
      },
    });
    await installSkill(tenantId, skill.id);
    return skill;
  }

  it('未配置图像渠道 → ok:false，且 fail-fast 不烧任何一次调用', async () => {
    delete process.env.BEACON_IMAGE_LLM_MODEL; // 确保没有平台图像兜底
    const t = await mkTenant();
    const skill = await mkInstalledImageSkill(t.id);
    const r = await runSkill({ tenantId: t.id, skillId: skill.id, content: '内容', title: '标题' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('渠道');
    // 没配就直接失败，连抽标题那次 generation 都不该花
    const logs = await prisma.llmCallLog.findMany({ where: { tenantId: t.id } });
    expect(logs).toHaveLength(0);
  });

  it('自定义技能不许建 image 类型', async () => {
    const t = await mkTenant();
    await expect(
      createCustomSkill(t.id, {
        name: 'x', description: 'd', platform: 'xiaohongshu', promptTemplate: '{{content}}',
        outputKind: 'image' as 'text',
      }),
    ).rejects.toThrow();
  });
});

describe('preinstallSkillsForPlatforms · 视觉技能不进预装', () => {
  it('visual 技能被跳过，只预装文本类', async () => {
    const t = await mkTenant();
    await prisma.contentSkill.create({
      data: {
        slug: 'xhs-format', name: '排版', description: 'x', platform: 'xiaohongshu',
        category: 'format', outputKind: 'text', promptTemplate: '{{content}}', isBuiltin: true, tenantId: null,
      },
    });
    await prisma.contentSkill.create({
      data: {
        slug: 'xhs-cover', name: '封面', description: 'x', platform: 'xiaohongshu',
        category: 'visual', outputKind: 'image', promptTemplate: '{{content}}', isBuiltin: true, tenantId: null,
      },
    });
    const n = await preinstallSkillsForPlatforms(t.id, ['xiaohongshu']);
    expect(n).toBe(1); // 只装了 format，那个 visual 封面被跳过（按需装）
    const installed = await listInstalledSkills(t.id);
    expect(installed.map((s) => s.slug)).toEqual(['xhs-format']);
  });
});

describe('gateSkillOutput · 合规闸（红线=legal+block，与导出硬闸同口径）', () => {
  it('红线命中 → 拒绝，并把命中词写进人话理由', async () => {
    await seedWord('国家级', 'legal', 'block');
    const g = await gateSkillOutput('我们是国家级团队', 'wechat', null);
    expect(g.ok).toBe(false);
    if (g.ok) return;
    expect(g.error).toContain('国家级');
    expect(g.error).toContain('合规红线');
  });

  it('warn 命中不拦：ok:true，hits 原样返回给 UI 展示', async () => {
    await seedWord('最好', 'legal', 'warn');
    const g = await gateSkillOutput('这是最好的做法', 'wechat', null);
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(g.riskLevel).toBe('warn');
    expect(g.hits.map((h) => h.word)).toEqual(['最好']);
  });

  it('industry 级即使 block 也不算红线（与 hasRedline 口径一致）', async () => {
    await seedWord('包治百病', 'industry', 'block');
    const g = await gateSkillOutput('包治百病', 'wechat', null);
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(g.riskLevel).toBe('block'); // 不拦但如实标注风险级别
  });

  it('干净文本 → pass 且无命中', async () => {
    await seedWord('国家级', 'legal', 'block');
    const g = await gateSkillOutput('今天天气不错', 'wechat', null);
    expect(g).toMatchObject({ ok: true, riskLevel: 'pass', hits: [] });
  });
});

describe('runSkill · 红线端到端（Mock 输出确定性构造）', () => {
  it('模型输出命中红线词 → ok:false', async () => {
    const t = await mkTenant();
    const skill = await mkInstalledBuiltin(t.id);
    const args = { tenantId: t.id, skillId: skill.id, content: '同一段内容' };

    // Mock provider 对同一 prompt 输出确定：先拿一次干净输出，
    // 再把输出里真实存在的片段种成红线词重跑——不依赖 Mock 的具体文案。
    const first = await runSkill(args);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await seedWord(first.output.slice(0, 2), 'legal', 'block');

    const second = await runSkill(args);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toContain('合规红线');
  });

  it('warn 词命中时照常返回结果并带回 hits', async () => {
    const t = await mkTenant();
    const skill = await mkInstalledBuiltin(t.id);
    const args = { tenantId: t.id, skillId: skill.id, content: '另一段内容' };
    const first = await runSkill(args);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await seedWord(first.output.slice(0, 2), 'legal', 'warn');

    const second = await runSkill(args);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.riskLevel).toBe('warn');
    expect(second.hits.length).toBeGreaterThan(0);
  });
});
