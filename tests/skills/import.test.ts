import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { importSkillFromUrl, assertPublicUrl, isPrivateIp, type FetchPage } from '@/lib/skills/import';

// 从网址导入技能：真 SQLite + Mock LLM（清掉平台默认 LLM env → HTML 路径必然走确定性兜底，零网络）。
// 抓取注入假实现（fetchPage），只验「识别来源类型 + 落成技能 + SSRF 护栏」。

delete process.env.BEACON_DEFAULT_LLM_BASE_URL;
delete process.env.BEACON_DEFAULT_LLM_API_KEY;

async function mkTenant() {
  return prisma.tenant.create({ data: { name: '租户', plan: 'free' } });
}

function fakeFetch(contentType: string, text: string, finalUrl = 'https://example.com/x'): FetchPage {
  return async () => ({ finalUrl: new URL(finalUrl), contentType, text });
}

beforeEach(async () => {
  await prisma.skillInstall.deleteMany();
  await prisma.contentSkill.deleteMany();
  await prisma.llmCallLog.deleteMany();
  await prisma.tenant.deleteMany();
});

describe('skills/import · SSRF 护栏', () => {
  it('内网/回环 IP 字面量与 localhost 一律拒', async () => {
    for (const u of [
      'http://127.0.0.1/skill.json',
      'http://10.0.0.5/x',
      'http://192.168.1.1/x',
      'http://169.254.169.254/latest/meta-data', // 云元数据
      'http://localhost:3000/x',
    ]) {
      await expect(assertPublicUrl(u)).rejects.toThrow(/内网|本机/);
    }
  });

  it('非 http/https 协议拒', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/http/);
    await expect(assertPublicUrl('ftp://example.com/x')).rejects.toThrow(/http/);
  });

  it('isPrivateIp 判定', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('10.1.2.3')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.32.0.1')).toBe(false); // 172.32 不在私有段
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('::1')).toBe(true);
  });
});

describe('skills/import · 来源①：技能定义', () => {
  it('JSON 技能定义 → 直接解析导入并安装', async () => {
    const t = await mkTenant();
    const json = JSON.stringify({
      name: '知乎高赞回答体',
      description: '把正文改写成知乎高赞回答风格',
      platform: 'zhihu',
      outputKind: 'markdown',
      emoji: '🎯',
      promptTemplate: '把 {{content}} 改写成知乎高赞回答的风格。',
    });
    const r = await importSkillFromUrl(t.id, 'https://raw.githubusercontent.com/a/b/main/skill.json', fakeFetch('application/json', json));
    expect(r.ok).toBe(true);
    expect(r.ok && r.via).toBe('definition');
    const skill = await prisma.contentSkill.findFirst({ where: { tenantId: t.id } });
    expect(skill?.name).toBe('知乎高赞回答体');
    expect(skill?.platform).toBe('zhihu');
    // 创建即安装
    expect(await prisma.skillInstall.count({ where: { tenantId: t.id } })).toBe(1);
  });

  it('缺 {{content}} 的定义 → 自动补占位符后导入', async () => {
    const t = await mkTenant();
    const json = JSON.stringify({ name: '标题党生成', promptTemplate: '生成 5 个吸引点击的标题。' });
    const r = await importSkillFromUrl(t.id, 'https://raw.githubusercontent.com/a/b/main/s.json', fakeFetch('application/json', json));
    expect(r.ok).toBe(true);
    const skill = await prisma.contentSkill.findFirst({ where: { tenantId: t.id } });
    expect(skill?.promptTemplate).toMatch(/\{\{content\}\}/);
  });

  it('frontmatter Markdown（SKILL.md 式）→ 解析导入', async () => {
    const t = await mkTenant();
    const md = `---\nname: 公众号排版助手\ndescription: 排版成公众号成品\nplatform: wechat\noutputKind: html\n---\n请把正文排版成公众号图文，分小标题、加引导语。`;
    const r = await importSkillFromUrl(t.id, 'https://raw.githubusercontent.com/a/b/main/SKILL.md', fakeFetch('text/markdown', md));
    expect(r.ok).toBe(true);
    expect(r.ok && r.via).toBe('definition');
    const skill = await prisma.contentSkill.findFirst({ where: { tenantId: t.id } });
    expect(skill?.name).toBe('公众号排版助手');
    expect(skill?.platform).toBe('wechat');
    expect(skill?.promptTemplate).toMatch(/\{\{content\}\}/); // body 无占位符，自动补
  });
});

describe('skills/import · 来源②：内容作品 → 生成', () => {
  it('HTML 文章 → LLM（Mock 兜底）生成技能并安装', async () => {
    const t = await mkTenant();
    const html = `<html><head><title>三分钟学会咖啡拉花</title></head><body><h1>三分钟学会咖啡拉花</h1><p>第一步，打好奶泡……第二步，稳住手腕……第三步，收尾提拉。</p></body></html>`;
    const r = await importSkillFromUrl(t.id, 'https://mp.weixin.qq.com/s/abc', fakeFetch('text/html', html));
    expect(r.ok).toBe(true);
    expect(r.ok && r.via).toBe('generated');
    const skill = await prisma.contentSkill.findFirst({ where: { tenantId: t.id } });
    expect(skill).toBeTruthy();
    expect(skill?.promptTemplate).toMatch(/\{\{content\}\}/);
    expect(await prisma.skillInstall.count({ where: { tenantId: t.id } })).toBe(1);
  });

  it('正文太短 → 明确报错，不建技能', async () => {
    const t = await mkTenant();
    const r = await importSkillFromUrl(t.id, 'https://example.com/empty', fakeFetch('text/html', '<html><body>  </body></html>'));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/正文/);
    expect(await prisma.contentSkill.count({ where: { tenantId: t.id } })).toBe(0);
  });
});
