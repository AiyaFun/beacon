import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';
import { vetBrowserTaskArgs, resolveCompetitorRef } from '@/lib/browser-task/vet';

// 浏览器任务的三道闸收口（2026-08-26）。
//
// 【守的核心】排任务前的闸（有没有插件 / 读网页开关+白名单 / 竞对必须在监控列表）
// 只有 lib/browser-task/vet.ts 一份实现——AI 工具（dispatch_browser_task）与
// 对外调用面（/api/v1/browser-tasks，MCP 走它）都必须 import 它。
// 闸各写一份的下场是确定的：两边迟早对不上，而出事的一定是宽的那一边。

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

let workspaceId: string;
let memberId: string;
let competitorId: string;

beforeEach(async () => {
  await prisma.browserTask.deleteMany();
  await prisma.ingestToken.deleteMany();
  await prisma.watchlistItem.deleteMany();
  await prisma.competitorAccount.deleteMany();
  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  workspaceId = ws.id;
  const m = await prisma.member.create({ data: { tenantId: tenant.id, name: '张三', role: 'owner' } });
  memberId = m.id;
  await prisma.ingestToken.create({
    data: { workspaceId, token: `bcn_${Math.random().toString(36).slice(2)}`, label: '测试设备', memberId },
  });
  const c = await prisma.competitorAccount.create({
    data: { platform: 'douyin', handle: 'wang_talks', name: '学习博主小王' },
  });
  competitorId = c.id;
  await prisma.watchlistItem.create({ data: { workspaceId, competitorId } });
});

describe('三道闸', () => {
  it('没装插件（没有采集令牌）：三种任务全拒，并指路装插件', async () => {
    await prisma.ingestToken.deleteMany();
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self', platform: 'wechat' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('采集插件');
  });

  it('竞对不在监控列表：拒绝（不校验的话调用方可以拿任意 id 让插件去访问）', async () => {
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_competitor', competitorId: 'cmxxfake' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('监控列表');
  });

  it('在监控列表里的竞对：放行，limit 越界收进 1..50', async () => {
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_competitor', competitorId, limit: 500 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload).toEqual({ kind: 'collect_competitor', competitorId, limit: 50 });
  });

  it('open_and_read：开关默认关时拒绝；开了但域不在白名单也拒绝', async () => {
    const off = await vetBrowserTaskArgs(workspaceId, { kind: 'open_and_read', url: 'https://www.douyin.com/video/1' });
    expect(off.ok).toBe(false);
    if (!off.ok) expect(off.error).toContain('开关');

    await prisma.workspace.update({ where: { id: workspaceId }, data: { browserReadEnabled: true } });
    const bad = await vetBrowserTaskArgs(workspaceId, { kind: 'open_and_read', url: 'https://evil.example.com/x' });
    expect(bad.ok).toBe(false);

    const good = await vetBrowserTaskArgs(workspaceId, { kind: 'open_and_read', url: 'https://www.douyin.com/video/1' });
    expect(good.ok).toBe(true);
  });
});

describe('竞对指代解析（对外调用面用）：精确匹配，不替调用方猜', () => {
  it('按 id / handle / 名字都能精确找到', async () => {
    for (const ref of [competitorId, 'wang_talks', '学习博主小王']) {
      const r = await resolveCompetitorRef(workspaceId, ref);
      expect(r.ok, `按「${ref}」应该找到`).toBe(true);
      if (r.ok) expect(r.competitorId).toBe(competitorId);
    }
  });

  it('同名多个：不猜，把候选连 id 一起列出来让调用方带 id 重来', async () => {
    const c2 = await prisma.competitorAccount.create({
      data: { platform: 'xiaohongshu', handle: 'wang2', name: '学习博主小王' },
    });
    await prisma.watchlistItem.create({ data: { workspaceId, competitorId: c2.id } });
    const r = await resolveCompetitorRef(workspaceId, '学习博主小王');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('2 个');
      expect(r.error, '要带 id，调用方才有办法精确重来').toContain(competitorId);
    }
  });

  it('不在监控列表：如实说没有并指路订阅（不做模糊匹配，handle 是不透明 ID 不归一大小写）', async () => {
    const r = await resolveCompetitorRef(workspaceId, 'WANG_TALKS');
    expect(r.ok, '大小写不同就是不同——不透明 ID 不许转小写').toBe(false);
  });
});

describe('闸只有一份：两个入口都必须走 vet.ts', () => {
  it('AI 工具与 /api/v1/browser-tasks 都 import vetBrowserTaskArgs', () => {
    expect(read('lib/agent/tools.ts')).toMatch(/import \{ vetBrowserTaskArgs \} from '\.\.\/browser-task\/vet'/);
    expect(read('app/api/v1/browser-tasks/route.ts')).toMatch(/vetBrowserTaskArgs, resolveCompetitorRef \} from '@\/lib\/browser-task\/vet'/);
  });

  it('工具文件里不再有自己的那份闸（防止有人改回去，两边分叉）', () => {
    const tools = read('lib/agent/tools.ts');
    // 这两句闸文案如今只住在 vet.ts；工具文件里再出现，就是有人把闸复制回去了
    expect(tools).not.toContain('这个竞对不在你的监控列表里');
    expect(tools).not.toContain('browserReadEnabled');
  });

  it('对外路由白名单动作之外一律拒绝，且 MCP 暴露的就是这四个浏览器工具', () => {
    const route = read('app/api/v1/browser-tasks/route.ts');
    expect(route).toMatch(/BROWSER_TASK_KINDS as readonly string\[\]\)\.includes\(kind\)/);

    const mcp = read('mcp-server.ts');
    for (const tool of ['beacon_collect_competitor', 'beacon_collect_self', 'beacon_read_page', 'beacon_browser_task_status']) {
      expect(mcp, `MCP 工具清单要有 ${tool}`).toContain(`name: '${tool}'`);
    }
    // 「不是远程驱动浏览器」不能只写在文档里——MCP 面上不许出现自由驱动类动词
    for (const banned of ['beacon_click', 'beacon_fill', 'beacon_execute_script', 'beacon_open_url']) {
      expect(mcp).not.toContain(`name: '${banned}'`);
    }
  });
});
