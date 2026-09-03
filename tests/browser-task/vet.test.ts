import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';
import { vetBrowserTaskArgs, resolveCompetitorRef } from '@/lib/browser-task/vet';
import { AGENT_TOOLS } from '@/lib/agent/tools';
import { between, orderedBefore } from '../helpers/anchor';

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
    // 这枚令牌模拟的是**当前版本**的插件：自报过全部能力（老插件那种没自报的在 executor.test.ts 单独测）
    data: { workspaceId, token: `bcn_${Math.random().toString(36).slice(2)}`, label: '测试设备', memberId, kinds: JSON.stringify(['collect_competitor', 'collect_self_profile', 'open_and_read']) },
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
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'x' });
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

// ── 对外调用面也要过角色闸与工具开关（2026-08-30 补）─────────────────────────
//
// 派浏览器任务在 AI 工具表里标的是 `action: 'competitor.manage'`，executeCall 会按
// 发起人角色判一次；网页那条路走 requireRole。而 /api/v1/browser-tasks 此前
// **一道角色闸都没有**——同一件事，网页会被拦下、API 不会。
//
// 【为什么「今天够不着」不是不挂闸的理由】这条路由只在 appliance/private 存在，
// 而那两个形态里 viewer 目前不可被授予（assignableRoles）——所以今天大概率触发不了。
// 但那是**两道无关约束恰好互相收口**的结果：哪天 assignableRoles 放开、
// 或者库里留着一个切换形态之前建的 viewer，这个口子就开了，
// 而那时没有任何东西会提醒我们。本项目的既有做法是「闸挂每一条路」。
describe('🔒 /api/v1/browser-tasks 的闸与网页/AI 那两条路一致', () => {
  const route = fs.readFileSync(path.join(process.cwd(), 'app/api/v1/browser-tasks/route.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('挂了角色闸，且用的是与 AI 工具表同一个动作', () => {
    const tool = AGENT_TOOLS.find((t) => t.name === 'dispatch_browser_task');
    expect(tool, 'dispatch_browser_task 不在工具表里了，这条守卫要跟着改').toBeTruthy();
    expect(route, 'API 这条路没有角色闸').toContain('can(auth.ctx.role,');
    expect(
      route,
      `AI 那条路判的是 ${tool!.action}，API 这条判的必须是同一个——` +
      '两条路对同一件事用不同的权限判据，等于其中一条是漏的',
    ).toContain(`can(auth.ctx.role, '${tool!.action}')`);
  });

  it('工作区关掉这个能力时 API 也不派（只在界面上关等于摆设）', () => {
    expect(route).toContain('disabledTools(');
    expect(route).toContain("off.includes('dispatch_browser_task')");
  });

  it('闸在真正入队之前（判完再派等于已经派了）', () => {
    orderedBefore(route, "can(auth.ctx.role, 'competitor.manage')", 'enqueueBrowserTask(');
    orderedBefore(route, "off.includes('dispatch_browser_task')", 'enqueueBrowserTask(');
  });

  it('拒绝时回 403 并说清原因（静默 200 会让调用方以为派成功了）', () => {
    const seg = between(route, "can(auth.ctx.role, 'competitor.manage')", 'const body =');
    expect(seg).toContain('403');
    expect(seg).toContain('没有派发采集任务的权限');
  });
});

// ── 「回填我的 X 账号」：账号与 handle 由服务端对上（2026-09-03）────────────────
//
// 用户原话：「我们都有 x 账号的信息和插件的信息，应该要有所关联」。
// 关联落在 vet.ts：collect_self_profile + platform=x → 找到工作区里那条 X 账号、取它的 handle，
// 连 accountId 一起派下去（插件那头不再猜归属）。
describe('collect_self_profile：把「我的 X 账号」落到具体账号', () => {
  beforeEach(async () => {
    await prisma.creatorAccount.deleteMany();
  });
  const mkAccount = (data: { name: string; platform: string; handle?: string | null }) =>
    prisma.creatorAccount.create({ data: { workspaceId, ...data } });

  it('X：唯一账号且有 handle → 派 collect_self_profile，带上 accountId 与 handle', async () => {
    const a = await mkAccount({ name: '我的X', platform: 'x', handle: '@aiyafun' });
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'x' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload).toEqual({ kind: 'collect_self_profile', platform: 'x', accountId: a.id, handle: 'aiyafun' });
      expect(r.accountId).toBe(a.id);
      expect(r.local).toBeUndefined();
    }
  });

  it('公众号：整条通道已删，如实拒绝而不是排一个没人做的活', async () => {
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'wechat' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('手动回填');
  });

  it('没填 handle：如实说去账号页填，不编一个', async () => {
    await mkAccount({ name: '没handle', platform: 'x', handle: null });
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('handle');
  });

  it('工作区没有这个平台的账号：指路去加，不去猜别的平台', async () => {
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'tiktok' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('账号');
  });

  it('同平台多个账号：当前账号同平台就用它；否则要点名，候选连 id 列出来', async () => {
    const a = await mkAccount({ name: '主号', platform: 'x', handle: 'main' });
    const b = await mkAccount({ name: '小号', platform: 'x', handle: 'alt' });
    const byCurrent = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'x' }, { preferAccountId: b.id });
    expect(byCurrent.ok && byCurrent.payload.handle).toBe('alt');

    const ambiguous = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'x' });
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) { expect(ambiguous.error).toContain(a.id); expect(ambiguous.error).toContain(b.id); }

    const byName = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'x' }, { accountRef: '小号' });
    expect(byName.ok && byName.payload.accountId).toBe(b.id);
    const byHandle = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'x' }, { accountRef: '@main' });
    expect(byHandle.ok && byHandle.payload.accountId).toBe(a.id);
  });

  it('当前账号是别的平台时不算数（抖音账号不能替 X 账号回填）', async () => {
    const dy = await mkAccount({ name: '抖音号', platform: 'douyin', handle: 'dy' });
    const x = await mkAccount({ name: 'X号', platform: 'x', handle: 'xx' });
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'x' }, { preferAccountId: dy.id });
    expect(r.ok && r.payload.accountId).toBe(x.id);
  });

  it('抖音/小红书这类没有服务端可派的自有回填路：说清支持哪些、该去哪手动回填', async () => {
    await mkAccount({ name: '抖音号', platform: 'douyin', handle: 'dy' });
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'douyin' });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toContain('主页'); expect(r.error).toContain('手动回填'); }
  });
});

// ── 没装插件的退路：本机浏览器（2026-09-03）───────────────────────────────────
//
// 用户原话：「如果没有安装插件，客户端应该自己操作电脑的浏览器，自行去采集」。
// 退路的判定权在调用方（opts.localCdpUrl）：SaaS 永远传不进来，因为那里的服务端够不到用户的浏览器。
describe('没装插件：配了本机浏览器就当场跑，没配就指路', () => {
  beforeEach(async () => {
    await prisma.ingestToken.deleteMany();
    await prisma.creatorAccount.deleteMany();
  });

  it('没令牌 + 没本机浏览器：拒绝，且指路两条（装插件 / 开本机浏览器）', async () => {
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_competitor', competitorId });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toContain('采集插件'); expect(r.error).toContain('本机浏览器'); }
  });

  it('没令牌 + 有本机浏览器：放行并标 local，调用方据此当场跑而不是排队', async () => {
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_competitor', competitorId }, { localCdpUrl: 'http://127.0.0.1:9222' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.local).toEqual({ cdpUrl: 'http://127.0.0.1:9222' });
  });

  it('有令牌 + 本机就绪：**本机优先**，照样标 local（当场出结果，不排「以后」）', async () => {
    // 2026-09-03 真机：装了插件的用户派「采我的 X」，得到「已排给插件等它醒」——而 Chrome 就在眼前开着
    await prisma.ingestToken.create({ data: { workspaceId, token: `bcn_${Math.random().toString(36).slice(2)}`, label: 'dev', memberId } });
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_competitor', competitorId }, { localCdpUrl: 'http://127.0.0.1:9222' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.local).toEqual({ cdpUrl: 'http://127.0.0.1:9222' });
  });

  it('有令牌 + 本机没传（没开或没在跑）：不标 local，照旧排队', async () => {
    await prisma.ingestToken.create({ data: { workspaceId, token: `bcn_${Math.random().toString(36).slice(2)}`, label: 'dev', memberId } });
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_competitor', competitorId });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.local).toBeUndefined();
  });

  it('本机浏览器那条路也过 open_and_read 的开关与白名单（读哪一页仍是服务端说了算）', async () => {
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'open_and_read', url: 'https://mp.weixin.qq.com/s/abc' }, { localCdpUrl: 'http://127.0.0.1:9222' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.summary).toContain('开关');
  });

  it('公众号：本机浏览器也不做（整条通道已删），如实拒绝', async () => {
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'wechat' }, { localCdpUrl: 'http://127.0.0.1:9222' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('手动回填');
  });

  it('X 主页回填走本机浏览器：payload 与排队那条路一字不差，只多一个 local', async () => {
    const a = await prisma.creatorAccount.create({ data: { workspaceId, name: '我的X', platform: 'x', handle: 'aiyafun' } });
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'x' }, { localCdpUrl: 'http://127.0.0.1:9222' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload).toEqual({ kind: 'collect_self_profile', platform: 'x', accountId: a.id, handle: 'aiyafun' });
      expect(r.local?.cdpUrl).toBe('http://127.0.0.1:9222');
    }
  });

  it('🔒 AI 工具真的接了退路：先问本机浏览器，vet 标了 local 就当场跑，不入队', () => {
    const tools = read('lib/agent/tools.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const fn = between(tools, "name: 'dispatch_browser_task'", "name: 'list_browser_tasks'");
    // 只把「此刻活着」的端点传下去：配了但没开着的照旧排队，回执里说破怎么叫起来
    expect(fn).toContain('await localBrowserState(ctx.workspaceId)');
    expect(fn).toContain("localState.state === 'ready' ? localState.cdpUrl : null");
    expect(fn).toContain('localCdpUrl }');
    expect(fn).toContain("localState.state === 'offline'");
    expect(fn).toContain('LOCAL_BROWSER_WAKE_HINT');
    orderedBefore(fn, 'if (vetted.local) {', 'await enqueueBrowserTask(');
    expect(between(fn, 'if (vetted.local) {', 'await enqueueBrowserTask(')).toContain('runBrowserTaskLocally(');
    // 解析出来的账号要带进任务行：这批数据记在「我的 X 账号」名下，不是当前选中的那个
    expect(fn).toContain('accountId: vetted.accountId ?? ctx.accountId');
  });

  it('🔒 对外调用面（MCP 那头是另一个模型）不走本机浏览器：只排队', () => {
    const route = read('app/api/v1/browser-tasks/route.ts');
    expect(route).not.toContain('localCdpUrl');
    expect(route).not.toContain('runBrowserTaskLocally');
  });
});
