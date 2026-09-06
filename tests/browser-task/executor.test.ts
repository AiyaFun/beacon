import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';
import { parseKindsHeader, resolveIngestToken, issueIngestToken } from '@/lib/ingest/token';
import { collectorKinds, claimNextTask, enqueueBrowserTask, completeTask, LEGACY_PLUGIN_KINDS } from '@/lib/browser-task';
import { vetBrowserTaskArgs } from '@/lib/browser-task/vet';
import { orderedBefore, between } from '../helpers/anchor';

// 执行器能力自报 + 桌面客户端执行器（2026-09-03）。
//
// 真机事故：服务端新加了 collect_self_profile，派给用户机器上的旧插件，它领了回「不认识」，
// 重试三次判死，AI 执行挂着等了半天。修法不是按版本号判，是按**能力**判：执行器领活时自报会做哪些 kind，
// 服务端记在令牌上、只派它会做的；没自报的按老三种。

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let workspaceId = '';
let memberId = '';
let competitorId = '';
beforeEach(async () => {
  await prisma.tenant.deleteMany();
  await prisma.competitorAccount.deleteMany();
  const t = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const w = await prisma.workspace.create({ data: { tenantId: t.id, name: 'W' } });
  workspaceId = w.id;
  const m = await prisma.member.create({ data: { tenantId: t.id, name: '张三', role: 'owner' } });
  memberId = m.id;
  const c = await prisma.competitorAccount.create({ data: { platform: 'x', handle: 'rival', name: 'R' } });
  competitorId = c.id;
  await prisma.watchlistItem.create({ data: { workspaceId, competitorId } });
});

describe('能力头', () => {
  it('只认白名单里的 kind，去重排序；没带头 = null（老插件）', () => {
    expect(parseKindsHeader('collect_self_profile, collect_competitor,bogus,collect_competitor')).toEqual(['collect_competitor', 'collect_self_profile']);
    expect(parseKindsHeader(null)).toBeNull();
    expect(parseKindsHeader('')).toEqual([]);
  });

  it('领活时自报的能力立刻写到令牌上（不受 lastUsedAt 节流管），下次派活按它判', async () => {
    const { token } = await issueIngestToken({ workspaceId, memberId, label: 'dev' });
    expect(Array.from(await collectorKinds(workspaceId)).sort()).toEqual([...LEGACY_PLUGIN_KINDS].sort());
    await resolveIngestToken(token, { kinds: 'collect_competitor,collect_self_profile' });
    expect(Array.from(await collectorKinds(workspaceId)).sort()).toEqual(['collect_competitor', 'collect_self_profile']);
    // 紧接着又报一次不同的（插件更新了）：节流不能挡住能力变化
    await resolveIngestToken(token, { kinds: 'collect_competitor' });
    expect(Array.from(await collectorKinds(workspaceId))).toEqual(['collect_competitor']);
  });
});

describe('派活按能力过滤', () => {
  it('旧插件（没自报）：回填自己的 X 主页被拒，说清去更新插件或登记桌面客户端；采竞对照派', async () => {
    await issueIngestToken({ workspaceId, memberId, label: 'dev' });
    await prisma.creatorAccount.create({ data: { workspaceId, name: '我的X', platform: 'x', handle: 'me' } });
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toContain('版本旧了'); expect(r.error).toContain('桌面客户端'); }
    expect((await vetBrowserTaskArgs(workspaceId, { kind: 'collect_competitor', competitorId })).ok).toBe(true);
  });

  it('自报了 collect_self_profile 的执行器在：放行', async () => {
    const { token } = await issueIngestToken({ workspaceId, memberId, label: 'dev' });
    await resolveIngestToken(token, { kinds: 'collect_self_profile' });
    await prisma.creatorAccount.create({ data: { workspaceId, name: '我的X', platform: 'x', handle: 'me' } });
    expect((await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'x' })).ok).toBe(true);
  });

  it('本机浏览器就绪时不看插件能力（当场跑，与插件无关）', async () => {
    await issueIngestToken({ workspaceId, memberId, label: 'dev' });
    await prisma.creatorAccount.create({ data: { workspaceId, name: '我的X', platform: 'x', handle: 'me' } });
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'x' }, { localCdpUrl: 'http://127.0.0.1:9222' });
    expect(r.ok).toBe(true);
  });

  it('领活：只给这个执行器会做的 kind；没自报的按老三种', async () => {
    const acc = await prisma.creatorAccount.create({ data: { workspaceId, name: '我的X', platform: 'x', handle: 'me' } });
    await enqueueBrowserTask({ workspaceId, payload: { kind: 'collect_self_profile', platform: 'x', accountId: acc.id, handle: 'me' }, origin: 'agent', createdBy: memberId });
    expect(await claimNextTask(workspaceId, 'old-plugin', null)).toBeNull();
    const t = await claimNextTask(workspaceId, 'desktop', ['collect_self_profile']);
    expect(t?.kind).toBe('collect_self_profile');
  });

  it('「不认识」这种失败不重试，直接判死（再试三次也是同一句）', async () => {
    const r = await enqueueBrowserTask({ workspaceId, payload: { kind: 'collect_competitor', competitorId, limit: 20 }, origin: 'agent', createdBy: memberId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await claimNextTask(workspaceId, 'p', null);
    const done = await completeTask(workspaceId, r.id, { ok: false, error: '这个版本的插件还不认识「collect_competitor」，请更新插件' });
    expect(done.status).toBe('failed');
  });
});

describe('真机暴露的两处（2026-09-04）', () => {
  const ex = read('desktop/src-tauri/src/executor.rs');
  const exCode = strip(ex);

  it('🔒 先等执行上下文，再 evaluate —— 否则报错与真实原因毫不相干', () => {
    // 真机：新开的页头几秒里 Runtime.evaluate 回「Cannot find default execution context」，
    // readyState 那个循环用 unwrap_or_default 吞掉了它，空转到超时后由登录墙那行抛出。
    const i = exCode.indexOf('async fn run_in_page');
    expect(i, '找不到 run_in_page').toBeGreaterThan(-1);
    const body = exCode.slice(i);
    const ctxAt = body.indexOf('ctx_ready');
    // 登录墙判据的**调用点**（不是函数签名里的参数名），所以找 eval 那一行
    const wallAt = body.indexOf('({login_wall})()');
    expect(ctxAt, '没有等执行上下文这一步').toBeGreaterThan(-1);
    expect(wallAt, '等上下文必须在跑登录墙判据之前').toBeGreaterThan(ctxAt);
    expect(body).toMatch(/拿不到执行上下文/);
  });

  it('🔒 登录墙：推到前台的必须是**执行器自己那一页**，且每轮重新导航再判', () => {
    // 2026-09-04 审计查出的致命错：bring_to_front 用 PUT /json/new **另开一个标签**给用户登录，
    // 而等待循环盯的是 Cdp::open 绑的原来那一页——那页在后台永不重载，DOM 一直是登录墙那一版。
    // 用户登完了，循环仍每 3 秒判「还没登上」，空转到超时后告诉他「等了 5 分钟还没登上」——与事实相反。
    const cb = strip(read('desktop/src-tauri/src/collect_browser.rs'));
    expect(cb, 'focus_window 又去开新标签了（必须只提窗口，不开页）').not.toMatch(/json\/new/);
    expect(cb).toMatch(/pub fn focus_window\(\)/);
    const i = exCode.indexOf('wall["kind"] == "login"');
    const seg = exCode.slice(i, i + 2200);
    // 实现已抽成共用的 wait_for_login（两条判据路径共用），这里钉那个例程的内部行为
    const wfl = exCode.slice(exCode.indexOf('async fn wait_for_login('), exCode.indexOf('async fn run_in_page('));
    expect(wfl, '没对自己那一页发 Page.bringToFront').toContain('Page.bringToFront');
    expect(wfl, '等待循环里没有每轮重新导航——登录后站点会把他带走，判的就不是要采的那一页')
      .toMatch(/for _ in 0\.\.LOGIN_WAIT_ROUNDS[\s\S]{0,400}Page\.navigate/);
  });

  it('🔒 判登录墙之前要等重定向落定（整页跳转到 /login 的站点）', () => {
    // 2026-09-04 真机（小红书）：主页整页跳转到 /login?redirectPath=…，跳转发生在第一次
    // readyState=complete 之后。不等就在旧地址上判，什么都判不出来 → 走到「采到 0 条」
    // → 报「这个号可能还没发过内容」，与事实完全不符。
    const i = exCode.indexOf('async fn run_in_page(');
    const seg = exCode.slice(i, exCode.indexOf('({login_wall})()', i));
    expect(seg, '没等地址稳定就去判登录墙').toMatch(/location\.href/);
    expect(seg, '没有「地址不再变化」的判据').toMatch(/stable/);
  });

  it('🔒 要用户登录时绝不把那一页清掉，也不记进停靠页', () => {
    // 2026-09-04 真机（小红书）：错误里写着「窗口停在这一页请登录」，而 close() 已经把页导航回
    // about:blank——用户看到一个空白页和一句让他去登录的话。同一类「报告与事实不符」。
    expect(exCode, 'close 没有 park 开关，会无条件把页导航走').toMatch(/async fn close_keeping\(mut self, app: &AppHandle, park: bool\)/);
    expect(exCode, '要用户登录时没有跳过清页').toMatch(/let needs_login = matches!\(&r, Err\(e\) if e\.contains\("登录"\)\)/);
    expect(exCode).toMatch(/page\.close_keeping\(app, !needs_login\)/);
    // park=false 时必须清掉 parked，否则下次会去复用一个用户正在登录的页
    // 【两种情况都要记住这一页】留着登录页却不记的话，下一个任务另开一页，
    // 登录页越堆越多（2026-09-04 真机堆到 5 个）。
    const i = exCode.indexOf('async fn close_keeping(mut self');
    const body = exCode.slice(i, i + 700);
    expect(body, '没把这一页记下来，下次会另开一页堆登录页').toMatch(/\*g = Some\(self\.target_id\.clone\(\)\)/);
    expect(body, 'park=false 时不该把页导航走').toMatch(/if park \{[\s\S]{0,200}about:blank/);
  });

  it('🔒 硬信号与软信号两条路都走同一套等待（软信号那条不许直接判死）', () => {
    expect(exCode, '没有共用的等待例程').toMatch(/async fn wait_for_login\(/);
    const soft = exCode.slice(exCode.indexOf('v["loggedOut"] == true'), exCode.indexOf('v["loggedOut"] == true') + 900);
    expect(soft, '软信号那条没等用户登录就判死了').toMatch(/wait_for_login\(page, page_url, login_wall\)/);
    expect(soft, '登上之后没重跑解析，用户白登一次还要再派').toMatch(/Outcome::Parsed\(p2\)/);
    const hard = exCode.slice(exCode.indexOf('wall["kind"] == "login"'), exCode.indexOf('wall["kind"] == "login"') + 700);
    expect(hard).toMatch(/wait_for_login\(page, page_url, login_wall\)/);
  });

  it('🔒 采集页上有可见标识，登录时换成「请在这一页登录」', () => {
    expect(exCode).toMatch(/const BADGE_ON/);
    expect(exCode).toMatch(/const BADGE_LOGIN/);
    expect(exCode, '标识挡住了用户操作').toMatch(/pointer-events:none/);
  });

  it('🔒 单任务硬超时必须大于登录等待预算（否则等待被腰斩并报无关理由）', () => {
    const rounds = Number(exCode.match(/const LOGIN_WAIT_ROUNDS: usize = (\d+)/)?.[1]);
    const timeout = Number(exCode.match(/const TASK_TIMEOUT_SECS: u64 = (\d+)/)?.[1]);
    expect(rounds, '找不到 LOGIN_WAIT_ROUNDS').toBeGreaterThan(0);
    expect(timeout, '找不到 TASK_TIMEOUT_SECS').toBeGreaterThan(0);
    const waitBudget = rounds * 4.2;
    expect(timeout, `超时 ${timeout}s 罩不住登录等待 ${Math.round(waitBudget)}s —— 等待会被腰斩`)
      .toBeGreaterThan(waitBudget + 60);
    expect(exCode, '超时值写死在字面量里，会和等待预算各改各的').toMatch(/timeout\(Duration::from_secs\(TASK_TIMEOUT_SECS\)/);
  });

  it('🔒 碰到登录墙要等用户登完再继续，不是当场判死', () => {
    // 用户 2026-09-04：「如果有碰到需要登录的时候，应该等待调试」。
    // 登录窗口就是我们弹的，当场判死等于逼他登完再回来重派一次。
    const i = exCode.indexOf('wall["kind"] == "login"');
    expect(i, '找不到登录墙分支').toBeGreaterThan(-1);
    const seg = exCode.slice(i, i + 1800);
    expect(seg, '登录墙分支里没有等待 —— 又变回当场判死了').toMatch(/wait_for_login\(/);
    const wflA = exCode.slice(exCode.indexOf('async fn wait_for_login('), exCode.indexOf('async fn run_in_page('));
    expect(wflA, '等待例程里没有循环').toMatch(/for _ in 0\.\.LOGIN_WAIT_ROUNDS/);
    // 推到前台/重新导航/等待上限都在共用例程里（原先是行内实现）
    expect(wflA, '没有把窗口摆到用户面前').toContain('Page.bringToFront');
    expect(wflA, '登完之后没回到目标页重新采').toContain('Page.navigate');
    // 红线：等待期间绝不替用户操作
    expect(seg).toMatch(/不会替你输入账号密码/);
  });

  it('🔒 一条都没取到时要分清「没登录」和「没内容」，并把窗口摆到用户面前', () => {
    expect(exCode, '没有在空结果时判「是不是没登录」').toContain('loggedOut');
    const i = exCode.indexOf('let empty =');
    expect(i, '找不到空结果的判据').toBeGreaterThan(-1);
    const seg = exCode.slice(i, i + 1400);
    expect(seg, '判出没登录却没走共用的等待例程（会当场判死）').toContain('wait_for_login(');
    expect(seg, '没说清要在采集浏览器里登（不是日常 Chrome）').toMatch(/采集浏览器还没登录这个平台/);
    expect(seg).toMatch(/不会替你输入账号密码/);
  });

  it('🔒 服务端把这个判据发给执行器（不发的话上面那条永远不触发）', () => {
    const route = strip(read('app/api/ingest/executor/route.ts'));
    expect(route).toMatch(/loggedOut: LOGGED_OUT_FN/);
    const local = strip(read('lib/browser/local.ts'));
    expect(local).toMatch(/export const LOGGED_OUT_FN/);
    // 软信号必须要两个条件（有登录入口 + 在劝你登录），只认链接会误伤
    expect(local).toMatch(/asks \? \{ loggedOut: true/);
  });
});

describe('检测不到插件就立刻用浏览器（2026-09-05 用户拍板）', () => {
  it('早已不活跃的插件令牌不算执行器：只有桌面客户端在线时 executors=desktop', async () => {
    const { DESKTOP_LABEL_PREFIX, EXECUTOR_ALIVE_MINUTES } = await Promise.all([
      import('@/lib/ingest/token'), import('@/lib/browser-task/kinds'),
    ]).then(([t, k]) => ({ DESKTOP_LABEL_PREFIX: t.DESKTOP_LABEL_PREFIX, EXECUTOR_ALIVE_MINUTES: k.EXECUTOR_ALIVE_MINUTES }));
    await prisma.creatorAccount.create({ data: { workspaceId, name: '我的X', platform: 'x', handle: 'me' } });
    // 半个月前装过、早已卸载的插件：令牌没吊销，但 lastUsedAt 很久了
    const stale = await issueIngestToken({ workspaceId, memberId, label: 'Chrome · macOS' });
    await resolveIngestToken(stale.token, { kinds: 'collect_self_profile' });
    await prisma.ingestToken.update({ where: { id: stale.id }, data: { lastUsedAt: new Date(Date.now() - (EXECUTOR_ALIVE_MINUTES + 5) * 60_000) } });
    // 桌面客户端刚领过活
    const d = await issueIngestToken({ workspaceId, memberId, label: `${DESKTOP_LABEL_PREFIX}macOS` });
    await resolveIngestToken(d.token, { kinds: 'collect_self_profile' });
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'x' });
    expect(r.ok && r.executors, '早已不活跃的插件还被算成在线，回执会说「插件/桌面客户端」').toBe('desktop');
    expect(await collectorKinds(workspaceId)).toContain('collect_self_profile');
  });

  it('所有令牌都不活跃时如实说没有执行器（不派一个永远没人领的活）', async () => {
    const { EXECUTOR_ALIVE_MINUTES } = await import('@/lib/browser-task/kinds');
    await prisma.creatorAccount.create({ data: { workspaceId, name: '我的X', platform: 'x', handle: 'me' } });
    const t = await issueIngestToken({ workspaceId, memberId, label: 'Chrome · macOS' });
    await resolveIngestToken(t.token, { kinds: 'collect_self_profile' });
    await prisma.ingestToken.update({ where: { id: t.id }, data: { lastUsedAt: new Date(Date.now() - (EXECUTOR_ALIVE_MINUTES + 1) * 60_000) } });
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/还没有装采集插件|没有可用的采集令牌/);
  });

  it('🔒 派完活网页立刻叫桌面执行器领（executor_kick 四处都接上）', () => {
    expect(strip(read('desktop/src-tauri/src/executor.rs'))).toMatch(/pub fn executor_kick\(/);
    expect(read('desktop/src-tauri/build.rs')).toContain('"executor_kick"');
    expect(read('desktop/src-tauri/capabilities/executor.json')).toContain('allow-executor-kick');
    expect(read('desktop/src-tauri/src/main.rs')).toContain('executor::executor_kick');
    const panel = strip(read('app/(app)/assistant/AgentPanel.tsx'));
    expect(panel, '面板进入 waiting_browser 时没叫执行器领活').toMatch(/invoke\('executor_kick'\)/);
    // 领活间隔不能又改回一分钟
    const secs = Number(strip(read('desktop/src-tauri/src/executor.rs')).match(/const POLL_SECS: u64 = (\d+)/)?.[1]);
    expect(secs, '领活间隔又回到一分钟了').toBeLessThanOrEqual(30);
  });
});

describe('审计修复（2026-09-04 多代理对抗审计）', () => {
  const exCode = strip(read('desktop/src-tauri/src/executor.rs'));

  it('🔒 拼不出公开主页地址的平台，派活闸就拦住并说真话', async () => {
    // 先让工作区有执行器，否则会先撞「还没装采集插件」那道闸
    const { token } = await issueIngestToken({ workspaceId, memberId, label: 'dev' });
    await resolveIngestToken(token, { kinds: 'collect_competitor' });
    // 原先放行 → 客户端白拉起浏览器 → 报「服务端太旧？」→ 重试三次 → 通知说「常见原因是没登录」
    // 三条理由没有一条是真的。
    const wechat = await prisma.competitorAccount.create({ data: { platform: 'wechat', handle: 'someBiz', name: '某公众号' } });
    await prisma.watchlistItem.create({ data: { workspaceId, competitorId: wechat.id } });
    const r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_competitor', competitorId: wechat.id });
    expect(r.ok, '公众号没有可打开的公开主页，却放行了').toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/没有可以直接打开的公开主页/);
      expect(r.error, '没告诉用户该走哪条路').toMatch(/数据源|导入/);
    }
    // 有主页地址的平台照旧放行
    const x = await prisma.competitorAccount.create({ data: { platform: 'x', handle: 'someone', name: 'S' } });
    await prisma.watchlistItem.create({ data: { workspaceId, competitorId: x.id } });
    expect((await vetBrowserTaskArgs(workspaceId, { kind: 'collect_competitor', competitorId: x.id })).ok).toBe(true);
  });

  it('🔒 Page.navigate 的 errorText 不许丢：连不上站点要如实说，不能报成「站点改版了」', () => {
    const i = exCode.indexOf('Page.navigate');
    expect(i, '找不到 Page.navigate').toBeGreaterThan(-1);
    expect(exCode, '导航失败信息被吞掉了（CDP 导航失败仍是成功响应，错误在 result.errorText 里）')
      .toMatch(/errorText/);
    expect(exCode).toMatch(/打不开这个网址/);
  });

  it('🔒 对外 API：冷却命中时不许回「已排队」', () => {
    const route = strip(read('app/api/v1/browser-tasks/route.ts'));
    expect(route, '没处理 recentlyDone —— 会把 30 分钟前的旧结果当成这次采回来的').toMatch(/r\.recentlyDone/);
    expect(route).toMatch(/status: 'done'/);
    expect(route, '取代了排着的任务却不说').toMatch(/r\.superseded/);
  });

  it('🔒 桌面端两处授权文案不许再说「用你自己的 Chrome / 要退出 Chrome」', () => {
    for (const f of ['components/DesktopBrowserUsePrompt.tsx', 'components/DesktopExecutorCard.tsx']) {
      const src = strip(read(f));
      expect(src, `${f} 还在说用你自己的 Chrome（实际是独立采集浏览器）`).not.toMatch(/用你(自己)?的 Chrome/);
      expect(src, `${f} 还在要求用户退出 Chrome`).not.toMatch(/完全退出/);
      expect(src, `${f} 没说破「每个平台各登一次」`).toMatch(/各登录一次|登录一次/);
    }
  });
});

describe('别反复采同一个主页（2026-09-04 真机：采集浏览器反复开关、同一页采了五遍）', () => {
  const selfPayload = async () => {
    const a = await prisma.creatorAccount.upsert({
      where: { id: 'acc_x_me' }, update: {},
      create: { id: 'acc_x_me', workspaceId, name: '我的X', platform: 'x', handle: 'me' },
    });
    return { kind: 'collect_self_profile', platform: 'x', accountId: a.id, handle: 'me' };
  };

  it('重复任务以新为准：旧的（pending/claimed）标 cancelled，等它的运行改等新任务', async () => {
    // 用户 2026-09-04 拍板：「如果是重复任务的时候就关闭之前的任务，用新的任务」
    const payload = await selfPayload();
    const first = await enqueueBrowserTask({ workspaceId, payload, createdBy: memberId });
    expect(first.ok).toBe(true);
    const firstId = first.ok ? first.id : '';
    const { token } = await issueIngestToken({ workspaceId, memberId, label: 'dev' });
    await resolveIngestToken(token, { kinds: 'collect_self_profile' });
    expect((await claimNextTask(workspaceId, 'dev', ['collect_self_profile']))?.id).toBe(firstId);
    const run = await prisma.agentRun.create({
      data: { workspaceId, memberId, goal: '采我的 X', status: 'waiting_browser', waitingOn: `browser:${firstId}`, messages: '[]' },
    });
    const again = await enqueueBrowserTask({ workspaceId, payload, createdBy: memberId });
    expect(again.ok && again.id !== firstId, '再派没有产生新任务').toBe(true);
    expect(again.ok && again.superseded).toEqual([firstId]);
    const old = await prisma.browserTask.findUnique({ where: { id: firstId } });
    expect(old?.status, '旧任务没被取消').toBe('cancelled');
    expect(old?.error).toMatch(/取代/);
    const r = await prisma.agentRun.findUnique({ where: { id: run.id } });
    expect(r?.waitingOn, '等旧任务的运行没改等新任务，会永远醒不来').toBe(`browser:${again.ok ? again.id : ''}`);
    // 旧任务的执行器晚一步交活，要被拒掉（不能盖住新任务的结果）
    const late = await completeTask(workspaceId, firstId, { ok: true, result: '旧的结果' });
    expect(late.ok).toBe(false);
  });

  it('同一账号的自有回填按 accountId 判「同一个活」，payload 键顺序不同也算', async () => {
    const payload = await selfPayload();
    const raw = await prisma.browserTask.create({
      data: { workspaceId, accountId: payload.accountId, kind: 'collect_self_profile', payload: JSON.stringify({ handle: 'me', accountId: payload.accountId, platform: 'x', kind: 'collect_self_profile' }), status: 'pending', origin: 'user', expiresAt: new Date(Date.now() + 3600e3), createdBy: memberId },
    });
    const r = await enqueueBrowserTask({ workspaceId, accountId: payload.accountId, payload, createdBy: memberId });
    expect(r.ok && r.superseded, '键顺序不同的同一个活没被认出来').toEqual([raw.id]);
  });

  it('半小时内刚 done 的活不再排：直接把上次结果给调用方', async () => {
    const payload = await selfPayload();
    const t = await prisma.browserTask.create({
      data: { workspaceId, kind: 'collect_self_profile', payload: JSON.stringify(payload), status: 'done', result: '采完：新增 4 条', origin: 'agent', expiresAt: new Date(Date.now() + 3600e3), createdBy: memberId },
    });
    const r = await enqueueBrowserTask({ workspaceId, payload, createdBy: memberId });
    expect(r.ok && r.id).toBe(t.id);
    expect(r.ok && r.recentlyDone?.result, '没把上次的结果带回来').toBe('采完：新增 4 条');
    expect(await prisma.browserTask.count({ where: { workspaceId, status: 'pending' } }), '还是排了一条新的').toBe(0);
  });

  it('冷却早退时也清掉排着的旧任务，并把等它的运行改指到那条 done', async () => {
    // 2026-09-04 验证时发现：早退在取消之前，卡着的旧任务原样留着，晚点又被领走采一遍
    const payload = await selfPayload();
    const done = await prisma.browserTask.create({
      data: { workspaceId, accountId: payload.accountId, kind: 'collect_self_profile', payload: JSON.stringify(payload), status: 'done', result: '采完：更新 13 条', origin: 'agent', expiresAt: new Date(Date.now() + 3600e3), createdBy: memberId },
    });
    const stuck = await prisma.browserTask.create({
      data: { workspaceId, accountId: payload.accountId, kind: 'collect_self_profile', payload: JSON.stringify(payload), status: 'pending', origin: 'agent', expiresAt: new Date(Date.now() + 3600e3), createdBy: memberId },
    });
    const run = await prisma.agentRun.create({
      data: { workspaceId, memberId, goal: '采我的 X', status: 'waiting_browser', waitingOn: `browser:${stuck.id}`, messages: '[]' },
    });
    const r = await enqueueBrowserTask({ workspaceId, accountId: payload.accountId, payload, createdBy: memberId });
    expect(r.ok && r.recentlyDone?.result).toBe('采完：更新 13 条');
    expect((await prisma.browserTask.findUnique({ where: { id: stuck.id } }))?.status, '卡着的旧任务没被清掉，晚点还会再采一遍').toBe('cancelled');
    expect((await prisma.agentRun.findUnique({ where: { id: run.id } }))?.waitingOn, '等旧任务的运行没改指，会永远醒不来').toBe(`browser:${done.id}`);
    expect(await prisma.browserTask.count({ where: { workspaceId, status: { in: ['pending', 'claimed'] } } })).toBe(0);
  });

  it('失败后退避：第 1 次等 10 分钟，退避期内领不到', async () => {
    const payload = await selfPayload();
    const e = await enqueueBrowserTask({ workspaceId, payload, createdBy: memberId });
    const { token } = await issueIngestToken({ workspaceId, memberId, label: 'dev' });
    await resolveIngestToken(token, { kinds: 'collect_self_profile' });
    const c = await claimNextTask(workspaceId, 'dev', ['collect_self_profile']);
    expect(c?.id).toBe(e.ok ? e.id : '');
    await completeTask(workspaceId, c!.id, { ok: false, error: '页面没加载完' });
    const row = await prisma.browserTask.findUnique({ where: { id: c!.id } });
    expect(row?.status).toBe('pending');
    const wait = (row!.leaseUntil!.getTime() - Date.now()) / 60_000;
    expect(wait, '失败后没有退避，下一分钟又会被领走').toBeGreaterThan(8);
    expect(wait).toBeLessThan(12);
    expect(await claimNextTask(workspaceId, 'dev', ['collect_self_profile']), '退避期内被领走了').toBeNull();
  });

  it('🔒 执行器复用一页：采完导航到 about:blank 留着，不再 /json/close', () => {
    const ex = strip(read('desktop/src-tauri/src/executor.rs'));
    expect(ex, '还在关页 —— 最后一页一关窗口就没了，下次再拉起浏览器').not.toContain('/json/close');
    // 2026-09-04 后：复用改成按自己的 target id 认（不再按 url==about:blank），
    // 因为让用户登录时我们会把那一页留在登录页上，下次正该复用它。
    expect(ex, '复用不按自己那一页的 id 认，会抢用户正在用的标签').toMatch(/t\["id"\] == id/);
    expect(ex).toMatch(/Page\.navigate.*about:blank/);
    const tools = strip(read('lib/agent/tools.ts'));
    expect(tools).toMatch(/r\.recentlyDone/);
  });
});

describe('回执里叫对执行器的名字（2026-09-04 用户原话「但是我没安装插件」）', () => {
  it('只有桌面客户端登记时：executors=desktop；只有插件：plugin；都有：both', async () => {
    const { DESKTOP_LABEL_PREFIX } = await import('@/lib/ingest/token');
    await prisma.creatorAccount.create({ data: { workspaceId, name: '我的X', platform: 'x', handle: 'me' } });
    const d = await issueIngestToken({ workspaceId, memberId, label: `${DESKTOP_LABEL_PREFIX}macOS` });
    await resolveIngestToken(d.token, { kinds: 'collect_self_profile,collect_competitor' });
    let r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'x' });
    expect(r.ok && r.executors, '登记的是桌面客户端，回执却当成插件').toBe('desktop');
    const pl = await issueIngestToken({ workspaceId, memberId, label: 'Chrome · macOS' });
    await resolveIngestToken(pl.token, { kinds: 'collect_self_profile' });
    r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'x' });
    expect(r.ok && r.executors).toBe('both');
    await prisma.ingestToken.update({ where: { id: d.id }, data: { revokedAt: new Date() } });
    r = await vetBrowserTaskArgs(workspaceId, { kind: 'collect_self_profile', platform: 'x' });
    expect(r.ok && r.executors).toBe('plugin');
  });

  it('🔒 派活工具的回执按 executors 措辞；桌面壳签令牌带 agent=desktop 且服务端只用它决定前缀', () => {
    const tools = strip(read('lib/agent/tools.ts'));
    expect(tools).toMatch(/vetted\.executors === 'desktop' \? '你的桌面客户端'/);
    expect(tools).toMatch(/已排给\$\{who\}/);
    expect(tools, '还有写死的「已排给插件」').not.toMatch(/已排给插件：/);
    const actions = strip(read('app/(app)/settings/actions.ts'));
    // 2026-09-05 起标签还带机器名（审计 #29），前缀仍只由 agent=desktop 决定
    expect(actions).toMatch(/const label = opts\.agent === 'desktop'\s*\? `\$\{DESKTOP_LABEL_PREFIX\}/);
    for (const f of ['components/DesktopBrowserUsePrompt.tsx', 'components/DesktopExecutorCard.tsx']) {
      expect(strip(read(f)), `${f} 签令牌没带 agent: 'desktop'`).toMatch(/actIssueIngestToken\(false, \{ agent: 'desktop', host: status\?\.host \}\)/);
    }
  });
});

describe('🔒 接线', () => {
  it('领活路由：能力头传给鉴权与领活；采主页类任务附带 target；交活时 parsed 先落库再 completeTask', () => {
    const r = strip(read('app/api/ingest/tasks/route.ts'));
    expect(r).toContain('resolveIngestToken(req.headers.get(INGEST_TOKEN_HEADER), { kinds: kindsHeader })');
    expect(r).toContain('parseKindsHeader(kindsHeader))');
    expect(r).toContain('executorTarget(task)');
    orderedBefore(r, 'ingestParsedPage({', 'await completeTask(auth.workspace.id, taskId');
    // 解析结果落库失败 = 这次任务失败，不能把回执写成成功
    expect(between(r, 'ingestParsedPage({', 'await completeTask(')).toContain('okFlag = false; errorText = r.error');
  });

  it('执行器脚本端点：同一把令牌鉴权；脚本来自 local-collect（三条路一个解析器）', () => {
    const r = strip(read('app/api/ingest/executor/route.ts'));
    orderedBefore(r, 'resolveIngestToken(', 'loadParserSources(platform)');
    expect(r).toContain("from '@/lib/browser/local-collect'");
    expect(r).toContain('loginWall: LOGIN_WALL_FN');
  });

  it('插件轮询自报能力，且与 runBrowserTask 的分支一一对应', () => {
    const sw = read('extension/sw.js');
    expect(sw).toContain("'x-beacon-ingest-kinds': SUPPORTED_TASK_KINDS.join(',')");
    const listed = sw.match(/const SUPPORTED_TASK_KINDS = \[([^\]]+)\]/)![1].match(/'(\w+)'/g)!.map((s) => s.replace(/'/g, ''));
    const branches = Array.from(sw.matchAll(/task\.kind === '(\w+)'/g)).map((m) => m[1]);
    for (const k of new Set(branches)) expect(listed, `runBrowserTask 会做 ${k} 但没自报`).toContain(k);
    for (const k of listed) expect(branches, `自报了 ${k} 但 runBrowserTask 没这个分支`).toContain(k);
  });

  it('桌面登记卡：只在 Tauri 壳里渲染；令牌签出后直接交给壳，页面不存', () => {
    const c = read('components/DesktopExecutorCard.tsx');
    expect(c).toContain('__TAURI_INTERNALS__');
    expect(c).toContain('if (!inDesktop) return null');
    orderedBefore(c, 'await actIssueIngestToken(false', "invoke('register_executor', { base: location.origin, token })");
    for (const bad of ['localStorage', 'sessionStorage', 'document.cookie']) expect(c).not.toContain(bad);
    expect(read('app/(app)/extension/page.tsx')).toContain('<DesktopExecutorCard />');
  });

  it('本机浏览器与桌面执行器共用同一份落库（ingestParsedPage），runBrowserTaskLocally 不再自己落库', () => {
    const r = strip(read('lib/browser-task/local-run.ts'));
    expect(r).toContain('export async function ingestParsedPage');
    const run = r.slice(r.indexOf('export async function runBrowserTaskLocally'));
    expect(run).toContain("ingestParsedPage({ workspaceId, payload, parsed: r.payload, channel: 'local_browser'");
    expect(run).not.toContain('ingestOwnPostData(');
    expect(run).not.toContain('ingestCompetitorData(');
  });
});
