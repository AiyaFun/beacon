import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';
import { vetBrowserTaskArgs, resolveCompetitorRef } from '@/lib/browser-task/vet';
import { BROWSER_TASK_KINDS, RECIPE_PLATFORMS } from '@/lib/browser-task/kinds';
import { DESKTOP_LABEL_PREFIX } from '@/lib/ingest/token';
import { AGENT_TOOLS } from '@/lib/agent/tools';
import { between, orderedBefore } from '../helpers/anchor';

// 【配方平台的主页地址】lib/competitor-url.ts 正在由另一条线补微博/快手/知乎/头条/百家号的主页拼法。
// 这里只在**真模块拼不出**时给配方平台补一个地址——真模块一旦能拼，用的就是真的；非配方平台一律原样透传
// （公众号那条「没有可采的公开主页」用例仍在测真行为）。本文件测的是 vet 的分流，不是 competitor-url 的拼法。
vi.mock('@/lib/competitor-url', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/competitor-url')>();
  const RECIPE = ['weibo', 'kuaishou', 'zhihu', 'toutiao', 'baijiahao'];
  return {
    ...mod,
    competitorHomeUrl: (platform: string, handle: string) =>
      mod.competitorHomeUrl(platform, handle) ?? (RECIPE.includes(platform) ? `https://${platform}.test/${encodeURIComponent(handle)}` : null),
  };
});

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
    data: { lastUsedAt: new Date(),  workspaceId, token: `bcn_${Math.random().toString(36).slice(2)}`, label: '测试设备', memberId, kinds: JSON.stringify([...BROWSER_TASK_KINDS]) },
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

  it('三张平台表之外的平台（PLATFORMS 里没有的）：说清三类各能派哪些，不编一条路', async () => {
    // 2026-09-16 起 PLATFORMS 里的每个平台都有路（微博走配方），只有表外的键才会到这里
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'threads' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.summary).toContain('没有可派的自有回填路');
      expect(r.error).toContain('自己的公开主页');
      expect(r.error).toContain('创作者后台');
      expect(r.error).toContain('按配方');
    }
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

  it('YouTube：频道页是公开的，与 X/TikTok 同走 collect_self_profile（带 handle）', async () => {
    const a = await mkAccount({ name: '我的频道', platform: 'youtube', handle: '@mychannel' });
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'youtube' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload).toEqual({ kind: 'collect_self_profile', platform: 'youtube', accountId: a.id, handle: 'mychannel' });
  });
});

// ── 创作者后台回填与配方采集：两种只有插件会做的活（2026-09-15）─────────────────
//
// 抖音/小红书/B站/视频号/公众号的自有数据在创作者后台里，微博/快手/知乎/头条/百家号的竞对没有手写解析器。
// 此前这两类服务端根本派不出去（前者让用户去后台页手点侧栏，后者直接说「没有可采的主页」）。
// 2026-09-15 各有一个 kind 但只有插件会做；2026-09-16 起（用户原话「每一个平台都可以通过插件或者调用浏览器
// 的方式采集」）桌面客户端与本机浏览器也会做：本机就绪就标 local，排队时按「谁会做这种活」说回执，
// 没有会做的执行器时指路更新插件**或**桌面客户端；抖音/小红书/B站多一条退路——改采公开主页。
describe('创作者后台回填（collect_self_backend）：三条路都会做，退路是公开主页', () => {
  beforeEach(async () => {
    await prisma.creatorAccount.deleteMany();
  });
  const mkAccount = (data: { name: string; platform: string; handle?: string | null }) =>
    prisma.creatorAccount.create({ data: { workspaceId, ...data } });
  const oldPluginToken = async () => {
    await prisma.ingestToken.deleteMany();
    await prisma.ingestToken.create({
      data: { lastUsedAt: new Date(), workspaceId, token: `bcn_${Math.random().toString(36).slice(2)}`, label: '旧插件', memberId, kinds: JSON.stringify(['collect_competitor', 'collect_self_profile', 'open_and_read']) },
    });
  };

  /** 再登记一台桌面客户端执行器：让 queuedExecutors 会回 both，才验得出「插件专属的活回执只说插件」 */
  const alsoDesktop = () => prisma.ingestToken.create({
    data: { lastUsedAt: new Date(), workspaceId, token: `bcn_${Math.random().toString(36).slice(2)}`, label: `${DESKTOP_LABEL_PREFIX}macOS`, memberId, kinds: JSON.stringify(['collect_competitor', 'collect_self_profile', 'open_and_read']) },
  });

  it('抖音 + 新插件：派 collect_self_backend，带 accountId、不带 handle，记在这个账号名下', async () => {
    await alsoDesktop();
    const a = await mkAccount({ name: '抖音号', platform: 'douyin', handle: 'dy' });
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'douyin' });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (r.ok) {
      expect(r.payload).toEqual({ kind: 'collect_self_backend', platform: 'douyin', accountId: a.id });
      expect(r.accountId).toBe(a.id);
      expect(r.local).toBeUndefined();
      // 工作区里插件和桌面客户端都在，但只有插件会领这种活——回执不该说「插件/桌面客户端」
      expect(r.executors, '只有插件会领这种活，回执不该说「桌面客户端」').toBe('plugin');
    }
  });

  it('账号没填 handle 也照派：后台页认的是登录态，不靠 handle 拼地址', async () => {
    const a = await mkAccount({ name: '没handle的B站号', platform: 'bilibili', handle: null });
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'bilibili' });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (r.ok) expect(r.payload).toEqual({ kind: 'collect_self_backend', platform: 'bilibili', accountId: a.id });
  });

  it('旧插件（能力里没有 collect_self_backend）+ 抖音有 handle：退到公开主页，回执说破只有公开数字、升级后自动走后台', async () => {
    await oldPluginToken();
    const a = await mkAccount({ name: '抖音号', platform: 'douyin', handle: 'dy' });
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'douyin' });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (r.ok) {
      expect(r.payload).toEqual({ kind: 'collect_self_profile', platform: 'douyin', accountId: a.id, handle: 'dy' });
      expect(r.note).toContain('公开主页');
      expect(r.note).toContain('完播率');
      expect(r.note).toContain('1.2.19');
    }
  });

  it('旧插件 + 抖音没填 handle：退不了主页，拒绝并同时指路「更新插件或桌面客户端」', async () => {
    await oldPluginToken();
    await mkAccount({ name: '抖音号', platform: 'douyin', handle: null });
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'douyin' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('更新插件');
      expect(r.error).toContain('1.2.19');
      expect(r.error, '桌面客户端也会做后台回填了，要一并指路').toContain('桌面客户端');
    }
  });

  it('旧插件 + 视频号（没有公开主页可退）：拒绝，指路更新插件或桌面客户端', async () => {
    await oldPluginToken();
    await mkAccount({ name: '视频号', platform: 'shipinhao', handle: null });
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'shipinhao' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.summary).toBe('执行器太旧');
      expect(r.error).toContain('1.2.19');
      expect(r.error).toContain('桌面客户端');
      expect(r.error, '视频号没有公开主页，不该说成退到主页').not.toContain('公开主页');
    }
  });

  it('新桌面客户端（自报 collect_self_backend）+ 旧插件：派后台，回执只说桌面客户端', async () => {
    await oldPluginToken();
    await prisma.ingestToken.create({
      data: { lastUsedAt: new Date(), workspaceId, token: `bcn_${Math.random().toString(36).slice(2)}`, label: `${DESKTOP_LABEL_PREFIX}macOS`, memberId, kinds: JSON.stringify([...BROWSER_TASK_KINDS]) },
    });
    const a = await mkAccount({ name: '抖音号', platform: 'douyin', handle: 'dy' });
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'douyin' });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (r.ok) {
      expect(r.payload).toEqual({ kind: 'collect_self_backend', platform: 'douyin', accountId: a.id });
      expect(r.executors, '只有桌面客户端会做这种活，回执不该说「插件」').toBe('desktop');
    }
  });

  it('本机浏览器就绪：**走 local** 当场进后台（2026-09-16 起本机也会做）', async () => {
    const a = await mkAccount({ name: '小红书号', platform: 'xiaohongshu', handle: 'xhs' });
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'xiaohongshu' }, { localCdpUrl: 'http://127.0.0.1:9222' });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (r.ok) {
      expect(r.local).toEqual({ cdpUrl: 'http://127.0.0.1:9222' });
      expect(r.payload).toEqual({ kind: 'collect_self_backend', platform: 'xiaohongshu', accountId: a.id });
      expect(r.accountId).toBe(a.id);
    }
  });

  it('本机就绪 + 没插件：照样当场进后台（本机浏览器不需要插件）', async () => {
    await prisma.ingestToken.deleteMany();
    const a = await mkAccount({ name: '视频号', platform: 'shipinhao', handle: null });
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'shipinhao' }, { localCdpUrl: 'http://127.0.0.1:9222' });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (r.ok) {
      expect(r.local).toBeDefined();
      expect(r.payload).toEqual({ kind: 'collect_self_backend', platform: 'shipinhao', accountId: a.id });
    }
  });

  it('公众号：派得出去，但回执要预先说破「要先在插件设置里授权 mp.weixin.qq.com」（服务端不知道授没授）', async () => {
    await mkAccount({ name: '我的公众号', platform: 'wechat', handle: null });
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'wechat' });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (r.ok) {
      expect(r.payload.kind).toBe('collect_self_backend');
      expect(r.note).toContain('mp.weixin.qq.com');
    }
    await oldPluginToken();
    const rejected = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'wechat' });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error, '拒绝时也要带上授权那句').toContain('mp.weixin.qq.com');
  });

  it('对外路由直接写内部 kind（collect_self_backend）也走同一条闸', async () => {
    const a = await mkAccount({ name: '抖音号', platform: 'douyin', handle: 'dy' });
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_backend', platform: 'douyin' });
    expect(r.ok && r.payload).toEqual({ kind: 'collect_self_backend', platform: 'douyin', accountId: a.id });
  });
});

describe('配方采集竞对（collect_competitor_recipe）：三条路都会做', () => {
  const mkWatched = async (platform: string, handle: string) => {
    const c = await prisma.competitorAccount.create({ data: { platform, handle, name: `${platform}-${handle}` } });
    await prisma.watchlistItem.create({ data: { workspaceId, competitorId: c.id } });
    return c.id;
  };

  it('微博竞对 + 新插件 + 旧桌面客户端：payload 的 kind 是 collect_competitor_recipe，limit 收进 1..50，回执只说插件', async () => {
    // 旧桌面客户端（只自报最初三种）也在线：它不会做配方采集，回执只能说「插件」
    await prisma.ingestToken.create({
      data: { lastUsedAt: new Date(), workspaceId, token: `bcn_${Math.random().toString(36).slice(2)}`, label: `${DESKTOP_LABEL_PREFIX}macOS`, memberId, kinds: JSON.stringify(['collect_competitor', 'collect_self_profile', 'open_and_read']) },
    });
    const id = await mkWatched('weibo', 'someone');
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_competitor', competitorId: id, limit: 500 });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (r.ok) {
      expect(r.payload).toEqual({ kind: 'collect_competitor_recipe', competitorId: id, limit: 50 });
      expect(r.local).toBeUndefined();
      expect(r.executors, '旧桌面客户端不会做配方采集，回执不该说「插件/桌面客户端」').toBe('plugin');
      expect(r.note, '要提醒用户先在侧边栏对站点授权').toContain('授权');
    }
  });

  it('微博竞对 + 本机浏览器就绪：标 local 当场按配方采（2026-09-16 起本机也会做）', async () => {
    const id = await mkWatched('weibo', 'someone');
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_competitor', competitorId: id, limit: 500 }, { localCdpUrl: 'http://127.0.0.1:9222' });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (r.ok) {
      expect(r.payload).toEqual({ kind: 'collect_competitor_recipe', competitorId: id, limit: 50 });
      expect(r.local).toEqual({ cdpUrl: 'http://127.0.0.1:9222' });
    }
  });

  it('五个配方平台都走这条；抖音这类有手写解析器的照旧是 collect_competitor', async () => {
    for (const p of RECIPE_PLATFORMS) {
      const id = await mkWatched(p, `h_${p}`);
      const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_competitor', competitorId: id });
      expect(r.ok && r.payload.kind, `${p} 该走配方`).toBe('collect_competitor_recipe');
    }
    const dy = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_competitor', competitorId });
    expect(dy.ok && dy.payload.kind).toBe('collect_competitor');
  });

  it('旧插件（能力里没有 collect_competitor_recipe）：拒绝并让用户更新插件 + 在侧边栏对站点授权；能力闸在主页地址闸之前', async () => {
    await prisma.ingestToken.deleteMany();
    await prisma.ingestToken.create({
      data: { lastUsedAt: new Date(), workspaceId, token: `bcn_${Math.random().toString(36).slice(2)}`, label: '旧插件', memberId, kinds: JSON.stringify(['collect_competitor', 'collect_self_profile', 'open_and_read']) },
    });
    const id = await mkWatched('zhihu', 'someone');
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_competitor', competitorId: id });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.summary).toBe('执行器太旧');
      expect(r.error).toContain('1.2.19');
      expect(r.error).toContain('授权');
      expect(r.error, '桌面客户端也会按配方采了，要一并指路').toContain('桌面客户端');
      expect(r.error, '该说的是更新插件，不是「没有主页」').not.toContain('没有可以直接打开的公开主页');
    }
    // 本机浏览器就绪就能救：当场按配方采
    const local = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_competitor', competitorId: id }, { localCdpUrl: 'http://127.0.0.1:9222' });
    expect(local.ok).toBe(true);
    if (local.ok) expect(local.local).toBeDefined();
  });

  it('对外路由直接写内部 kind（collect_competitor_recipe）也走同一条闸', async () => {
    const id = await mkWatched('kuaishou', 'ks1');
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_competitor_recipe', competitorId: id, limit: 5 });
    expect(r.ok && r.payload).toEqual({ kind: 'collect_competitor_recipe', competitorId: id, limit: 5 });
  });

  it('🔒 配方平台的能力闸在主页地址闸之前（插件太旧时该说「更新插件」，不是「没有主页」）', () => {
    // 上面那条用例里主页地址是补出来的，验不出顺序；这里直接钉源码
    const vet = read('lib/browser-task/vet.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const seg = between(vet, "if (kind === 'collect_competitor') {", "if (kind === 'collect_self_profile') {");
    orderedBefore(seg, "caps.has('collect_competitor_recipe')", 'competitorHomeUrl(comp.platform, comp.handle)');
  });

  it('🔒 本机那条路对后台 / 配方两种 kind 各有自己的执行函数（不是拿主页解析器去开后台页）', () => {
    const run = read('lib/browser-task/local-run.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const fn = between(run, 'export async function runBrowserTaskLocally', 'ingestParsedPage({');
    const backend = fn.indexOf("payload.kind === 'collect_self_backend'");
    const recipe = fn.indexOf("payload.kind === 'collect_competitor_recipe' || payload.kind === 'collect_self_recipe'");
    expect(backend, 'runBrowserTaskLocally 没有后台分支').toBeGreaterThan(-1);
    expect(recipe, 'runBrowserTaskLocally 没有配方分支').toBeGreaterThan(-1);
    expect(fn.slice(backend, recipe)).toContain('collectBackendLocal(');
    expect(fn.slice(recipe)).toContain('collectRecipeLocal(');
    expect(fn.slice(recipe)).toContain('ingestRecipeOutcome(');
    expect(backend, '后台/配方分支要在主页解析器那条之前').toBeLessThan(fn.indexOf('collectPlatformPageLocal('));
    // 后台入口来自服务端那张与插件同源的表，不由模型/调用方给
    const target = between(run, 'export async function executorTarget', 'export async function runBrowserTaskLocally');
    expect(target).toContain("p.kind === 'collect_self_backend'");
    expect(target).toContain('backendEntryFor(p.platform)');
  });

  it('🔒 自有回填三种 kind 都按 accountId 去重（同一账号同一 kind 就是同一个活）', () => {
    const idx = read('lib/browser-task/index.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(idx).toContain("parsed.data.kind === 'collect_self_profile' || parsed.data.kind === 'collect_self_backend' || parsed.data.kind === 'collect_self_recipe'");
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
    await prisma.ingestToken.create({ data: { lastUsedAt: new Date(),  workspaceId, token: `bcn_${Math.random().toString(36).slice(2)}`, label: 'dev', memberId } });
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_competitor', competitorId }, { localCdpUrl: 'http://127.0.0.1:9222' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.local).toEqual({ cdpUrl: 'http://127.0.0.1:9222' });
  });

  it('有令牌 + 本机没传（没开或没在跑）：不标 local，照旧排队', async () => {
    await prisma.ingestToken.create({ data: { lastUsedAt: new Date(),  workspaceId, token: `bcn_${Math.random().toString(36).slice(2)}`, label: 'dev', memberId } });
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_competitor', competitorId });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.local).toBeUndefined();
  });

  it('本机浏览器那条路也过 open_and_read 的开关与白名单（读哪一页仍是服务端说了算）', async () => {
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'open_and_read', url: 'https://mp.weixin.qq.com/s/abc' }, { localCdpUrl: 'http://127.0.0.1:9222' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.summary).toContain('开关');
  });

  it('公众号后台 + 本机浏览器就绪：当场进后台（不需要插件），回执仍带上公众号那句提醒', async () => {
    const a = await prisma.creatorAccount.create({ data: { workspaceId, name: '我的公众号', platform: 'wechat', handle: null } });
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'wechat' }, { localCdpUrl: 'http://127.0.0.1:9222' });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (r.ok) {
      expect(r.local).toBeDefined();
      expect(r.payload).toEqual({ kind: 'collect_self_backend', platform: 'wechat', accountId: a.id });
      expect(r.note).toContain('mp.weixin.qq.com');
    }
  });

  it('配方平台的自己主页（collect_self_recipe）：要 handle；本机就绪当场跑；没有会做的执行器就指路更新', async () => {
    const a = await prisma.creatorAccount.create({ data: { workspaceId, name: '我的微博', platform: 'weibo', handle: '123456789' } });
    const local = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'weibo' }, { localCdpUrl: 'http://127.0.0.1:9222' });
    expect(local.ok, local.ok ? '' : local.error).toBe(true);
    if (local.ok) {
      expect(local.payload).toEqual({ kind: 'collect_self_recipe', platform: 'weibo', accountId: a.id, handle: '123456789' });
      expect(local.local).toBeDefined();
      expect(local.note).toContain('配方');
    }
    // 旧插件在线、本机没开：拒绝并指路
    await prisma.ingestToken.create({
      data: { lastUsedAt: new Date(), workspaceId, token: `bcn_${Math.random().toString(36).slice(2)}`, label: '旧插件', memberId, kinds: JSON.stringify(['collect_competitor', 'collect_self_profile', 'open_and_read']) },
    });
    const old = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'weibo' });
    expect(old.ok).toBe(false);
    if (!old.ok) { expect(old.summary).toBe('执行器太旧'); expect(old.error).toContain('1.2.19'); }
    // 新插件在线：排队，回执说插件
    await prisma.ingestToken.deleteMany();
    await prisma.ingestToken.create({
      data: { lastUsedAt: new Date(), workspaceId, token: `bcn_${Math.random().toString(36).slice(2)}`, label: '新插件', memberId, kinds: JSON.stringify([...BROWSER_TASK_KINDS]) },
    });
    const queued = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'weibo' });
    expect(queued.ok, queued.ok ? '' : queued.error).toBe(true);
    if (queued.ok) { expect(queued.payload.kind).toBe('collect_self_recipe'); expect(queued.executors).toBe('plugin'); }
    // 没填 handle：拼不出主页地址，如实说
    await prisma.creatorAccount.deleteMany();
    await prisma.creatorAccount.create({ data: { workspaceId, name: '我的快手', platform: 'kuaishou', handle: null } });
    const noHandle = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'kuaishou' });
    expect(noHandle.ok).toBe(false);
    if (!noHandle.ok) expect(noHandle.summary).toBe('账号没填 handle');
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
