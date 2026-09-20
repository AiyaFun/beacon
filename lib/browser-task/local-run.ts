// 没装插件时，把「本该排给插件的活」交给本机浏览器**当场**跑（2026-09-03）。
//
// 与排队那条路（lib/browser-task/index.ts）的分工：payload 形状、三道闸（vet.ts）、落库函数
// 全都复用，只是执行者从「插件下次醒来」换成「这台机器上的 Chrome 现在就去」。
// 所以 AI 拿到的是**结果**而不是一张回执——用户不用等插件醒。
import { beijingDayKey } from '../beijing';
import { prisma } from '../db';
import { can as editionCan } from '../edition';
import { vetCdpUrl, browseLocal } from '../browser/local';
import {
  collectPlatformPageLocal, collectBackendLocal, collectRecipeLocal,
  type ParsedPagePayload, type PageRead, type BackendPayload, type RecipeOutcome, type RecipeForExecutor, type LoginHelpCtx,
} from '../browser/local-collect';
import { extractPostsFromPage } from '../browser/page-read-extract';
import { competitorHomeUrl } from '../competitor-url';
import { ingestOwnPostData, ownPostIngestSchema } from '../ingest/own-post';
import { ingestOwnAccountData, ownAccountIngestSchema } from '../ingest/own-account';
import { ingestCompetitorData, ingestPayloadSchema } from '../ingest/competitor';
import { learnFromSkeleton, recordScrapeResult, parseOptions } from '../scrape/recipe';
import { saveScrapeRecord } from '../scrape/record';
import { ensurePlatformRecipes } from '../scrape/platform-recipes';
import { ingestPlatformRecipeRows, ingestPlatformRecipeRowsAsOwn } from '../scrape/platform-map';
import { backendEntryFor } from './backend-entries';
import { KIND_LABEL, type BrowserTaskPayload } from './kinds';

/**
 * 这个工作区能不能用本机浏览器：形态允许 **且** 配了合法的本机 CDP 端点。
 * SaaS 在第一道就回 null——那里的服务端够不到用户的浏览器。
 */
export async function localBrowserCdpUrl(workspaceId: string): Promise<string | null> {
  if (!editionCan('localBrowser')) return null;
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { browserCdpUrl: true } });
  const v = vetCdpUrl(ws?.browserCdpUrl);
  return v.ok && v.url ? v.url : null;
}

/**
 * 本机浏览器此刻的三种状态。派活前要分清「配了」和「现在真能用」：
 *   off      形态不允许 / 没开过开关
 *   ready    开了，且调试端点此刻活着 → 采集任务直接用它当场跑
 *   offline  开了，但 Chrome 现在没带端口跑着 → 只能排给插件，并告诉用户怎么把它叫起来
 * 不分的话，「配好了」的用户第一次派活就会撞「连不上」，而那个报错出现在采集那一刻。
 */
export type LocalBrowserState = { state: 'off' } | { state: 'ready'; cdpUrl: string } | { state: 'offline'; cdpUrl: string };

export async function localBrowserState(workspaceId: string): Promise<LocalBrowserState> {
  const cdpUrl = await localBrowserCdpUrl(workspaceId);
  if (!cdpUrl) return { state: 'off' };
  const { cdpLive } = await import('../browser/launch');
  const { live } = await cdpLive(cdpUrl);
  return live ? { state: 'ready', cdpUrl } : { state: 'offline', cdpUrl };
}

/** 用户能怎么把本机浏览器叫起来——三处（工具回执 / 系统提示 / 设置页）说同一句话。 */
export const LOCAL_BROWSER_WAKE_HINT = '到「设置 → 本机权限」点一下「开启浏览器操作」（或客户端托盘的「打开采集浏览器（登录用）」）';

export type LocalRunResult =
  | { ok: true; summary: string; data?: Record<string, unknown> }
  | { ok: false; error: string; summary: string };

/** 逻辑日按北京时间（2026-09-04 审计）：生产容器是 UTC，北京 00:00–08:00 的采集会写进前一天的行并盖掉那天的真值。 */
function todayStr(): string {
  return beijingDayKey();
}

/**
 * 一页平台主页解析出来之后的**落库部分**——本机浏览器（这台机器上的 Node）和桌面执行器
 * （云端账号 + Mac/Win 客户端走 CDP）两条路解析器相同、产物相同，落库只能有这一份。
 * 桌面执行器那条路把解析结果 POST 回 /api/ingest/tasks，服务端在这里收。
 */
export async function ingestParsedPage(input: {
  workspaceId: string;
  payload: Extract<BrowserTaskPayload, { kind: 'collect_self_profile' | 'collect_competitor' }>;
  parsed: ParsedPagePayload;
  channel: 'local_browser' | 'desktop';
  via: string; // 回执里的措辞：「本机浏览器」/「桌面客户端」
}): Promise<LocalRunResult> {
  const { workspaceId, payload, parsed, channel, via } = input;
  if (!parsed?.posts?.length) return { ok: false, error: '主页上一条作品都没读到。最常见的原因是**采集浏览器还没登录这个平台**（很多站点未登录时只给一个登录弹层）——去「烽火台采集浏览器」窗口里登录一次再派；也可能是页面没加载完，或这个号确实没发过内容。', summary: '没读到作品' };

  if (payload.kind === 'collect_self_profile') {
    // 打开的必须是这个账号自己的主页——解析器认出的 handle 对不上就一条都不写
    const norm = (h: string) => String(h ?? '').replace(/^@/, '').toLowerCase();
    if (norm(parsed.handle) !== norm(payload.handle)) {
      return { ok: false, error: `打开的页面是 @${parsed.handle} 的主页，不是 @${payload.handle}，没有回填`, summary: '主页对不上账号' };
    }
    const posts = ownPostIngestSchema.safeParse({
      platform: payload.platform,
      handle: parsed.handle,
      accountId: payload.accountId,
      channel,
      posts: parsed.posts.slice(0, 50),
    });
    if (!posts.success) return { ok: false, error: `采到的数据格式不合法：${posts.error.issues[0]?.message ?? ''}`, summary: '数据格式不合法' };
    const saved = await ingestOwnPostData(workspaceId, posts.data);
    if (!saved.ok) return { ok: false, error: saved.error, summary: '回填没落库' };

    let followers: number | undefined;
    const f = parsed.profile?.followers;
    if (typeof f === 'number' && Number.isFinite(f) && f >= 0) {
      const acc = ownAccountIngestSchema.safeParse({
        platform: payload.platform,
        accountId: payload.accountId,
        dailyStats: [{ date: todayStr(), followers: Math.round(f) }],
        ...(parsed.profile?.followersVia ? { followersVia: parsed.profile.followersVia } : {}),
      });
      if (acc.success) {
        await ingestOwnAccountData(payload.accountId, acc.data).catch(() => { /* 粉丝数写不进不影响作品已入库 */ });
        followers = Math.round(f);
      }
    }
    return {
      ok: true,
      summary: `已用${via}采完自己的 ${payload.platform} 主页：新增 ${saved.created} 条、更新 ${saved.updated} 条${followers != null ? `，粉丝 ${followers}` : ''}（记在账号「${saved.targetAccount?.name ?? payload.accountId}」名下）`,
      data: { accountId: payload.accountId, created: saved.created, updated: saved.updated, skipped: saved.skipped, followers, posts: parsed.posts.length },
    };
  }

  const comp = await prisma.competitorAccount.findUnique({ where: { id: payload.competitorId }, select: { id: true, platform: true } });
  if (!comp) return { ok: false, error: '竞对不存在', summary: '竞对不存在' };
  const parsedIn = ingestPayloadSchema.safeParse({
    platform: comp.platform,
    handle: parsed.handle,
    autoSubscribe: false,
    profile: parsed.profile,
    posts: parsed.posts.slice(0, Math.min(50, payload.limit)),
  });
  if (!parsedIn.success) return { ok: false, error: `采到的数据格式不合法：${parsedIn.error.issues[0]?.message ?? ''}`, summary: '数据格式不合法' };
  const saved = await ingestCompetitorData(workspaceId, parsedIn.data, { channel });
  if (!saved.ok) return { ok: false, error: saved.error, summary: '入库被拒' };
  return {
    ok: true,
    summary: `已用${via}采完竞对「${saved.competitor}」：${saved.posts} 条作品（${saved.withMetrics} 条带指标）`,
    data: { competitorId: comp.id, posts: saved.posts, withMetrics: saved.withMetrics },
  };
}

// ── 创作者后台 / 配方 / 页面直读的落库出口（三条路共用；桌面执行器交回的原料也走这里）──────

type Channel = 'local_browser' | 'desktop';

async function tenantOf(workspaceId: string): Promise<string | null> {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { tenantId: true } });
  return ws?.tenantId ?? null;
}

/** 这个工作区某个配方平台的内置配方（没有就当场播种）。给执行器下发、也给落库时定位 recipeId。 */
export async function platformRecipeFor(workspaceId: string, platform: string): Promise<(RecipeForExecutor & { tenantId: string }) | null> {
  const tenantId = await tenantOf(workspaceId);
  if (!tenantId) return null;
  await ensurePlatformRecipes(tenantId, workspaceId).catch(() => { /* 播种失败就按现有的查 */ });
  const r = await prisma.scrapeRecipe.findFirst({
    where: { workspaceId, platformKey: platform, status: { in: ['learning', 'active', 'broken'] } },
    select: { id: true, origin: true, pathPattern: true, status: true, version: true, rules: true, options: true },
  });
  if (!r) return null;
  let rules: unknown[] = [];
  try { rules = JSON.parse(r.rules); } catch { rules = []; }
  return { id: r.id, origin: r.origin, pathPattern: r.pathPattern, status: r.status, version: r.version, rules, options: parseOptions(r.options) as Record<string, unknown>, tenantId };
}

/** 创作者后台读回来的一份（作品 + 账号级块）落库。与插件 /api/ingest/self 那条路同一份 ownPostIngestSchema。 */
export async function ingestBackendPayload(input: {
  workspaceId: string;
  payload: Extract<BrowserTaskPayload, { kind: 'collect_self_backend' }>;
  backend: BackendPayload;
  channel: Channel;
  via: string;
}): Promise<LocalRunResult> {
  const { workspaceId, payload, backend, channel, via } = input;
  const label = backendEntryFor(payload.platform)?.label ?? `${payload.platform} 创作者后台`;
  let posts: { created: number; updated: number; skipped: number; targetAccount?: { id: string; name: string } } | null = null;
  if (backend.posts?.length) {
    const parsed = ownPostIngestSchema.safeParse({
      platform: payload.platform, handle: 'self', accountId: payload.accountId, channel, posts: backend.posts.slice(0, 50),
    });
    if (!parsed.success) return { ok: false, error: `后台读到的数据格式不合法：${parsed.error.issues[0]?.message ?? ''}`, summary: '数据格式不合法' };
    const saved = await ingestOwnPostData(workspaceId, parsed.data);
    if (!saved.ok) return { ok: false, error: saved.error, summary: '回填没落库' };
    posts = { created: saved.created, updated: saved.updated, skipped: saved.skipped, targetAccount: saved.targetAccount };
  }
  let account: { dailyStats: number; audience: boolean } | null = null;
  if (backend.dailyStats || backend.audience) {
    const acc = ownAccountIngestSchema.safeParse({
      platform: payload.platform, accountId: payload.accountId,
      ...(backend.dailyStats ? { dailyStats: backend.dailyStats } : {}), ...(backend.audience ? { audience: backend.audience } : {}),
    });
    if (acc.success) account = await ingestOwnAccountData(payload.accountId, acc.data).catch(() => null);
  }
  if (!posts && !account) return { ok: false, error: `${label}读回来的东西一样都没能入库`, summary: '没入库' };
  const parts = [
    posts ? `作品新增 ${posts.created} 条、更新 ${posts.updated} 条` : '',
    account?.dailyStats ? `账号日报 ${account.dailyStats} 天` : '',
    account?.audience ? '受众画像已更新' : '',
  ].filter(Boolean).join('，');
  return {
    ok: true,
    summary: `已用${via}进${label}读完：${parts}（记在账号「${posts?.targetAccount?.name ?? payload.accountId}」名下${backend.routes?.length ? `，走了 ${backend.routes.length} 页` : ''}）`,
    data: { accountId: payload.accountId, ...(posts ?? {}), account, routes: backend.routes ?? [] },
  };
}

/**
 * 一次配方采集的三种结局落库：学会了 → 行映射进竞对库/自有作品；还没学会/坏了 → 交骨架去学，
 * 并**当场用模型直读兜底**（页面就在手里，不该让用户等下一轮）；坏了同时记一次失败。
 */
export async function ingestRecipeOutcome(input: {
  workspaceId: string;
  payload: Extract<BrowserTaskPayload, { kind: 'collect_competitor_recipe' | 'collect_self_recipe' }>;
  recipe: RecipeForExecutor & { tenantId: string };
  outcome: RecipeOutcome;
  read?: PageRead;
  url: string;
  channel: Channel;
  via: string;
}): Promise<LocalRunResult> {
  const { workspaceId, payload, recipe, outcome, url, channel, via } = input;
  const platform = recipe.origin ? (await recipePlatform(recipe.id)) : '';
  if (!('mode' in outcome)) return { ok: false, error: outcome.error || '配方执行器没有返回结果', summary: '配方没跑起来' };

  if (outcome.mode === 'learn' || outcome.mode === 'stale') {
    const learned = await learnFromSkeleton({ tenantId: recipe.tenantId, recipeId: recipe.id, skeleton: outcome.skeleton }).catch(() => ({ ok: false, learned: 0 }));
    if (outcome.mode === 'stale') await recordScrapeResult(recipe.id, workspaceId, false).catch(() => null);
    const learnNote = outcome.mode === 'stale'
      ? `站点改版、配方失效，已交回重学（学到 ${learned.learned} 条规则）`
      : `这个站点的配方还在学习，已上传页面结构（学到 ${learned.learned} 条规则）`;
    // 页面在手里：模型直读一次，别让用户等下一轮
    if (input.read) {
      const fb = await ingestPageRead({ workspaceId, payload, read: input.read, channel, via, parserError: learnNote });
      if (fb.ok) return fb;
      return { ok: false, error: `${learnNote}；模型直读也没读出可入库的作品（${fb.error}）。学会规则后再采就有数据`, summary: '配方学习中' };
    }
    return { ok: false, error: `${learnNote}，学会后再采就有数据`, summary: '配方学习中' };
  }

  await saveScrapeRecord({
    tenantId: recipe.tenantId, workspaceId, recipeId: recipe.id, url,
    values: outcome.values, rows: outcome.rows, want: outcome.want ?? 0, channel,
  }).catch(() => null);
  await recordScrapeResult(recipe.id, workspaceId, true).catch(() => null);

  if (payload.kind === 'collect_self_recipe') {
    const r = await ingestPlatformRecipeRowsAsOwn({ workspaceId, platformKey: platform || payload.platform, values: outcome.values, rows: outcome.rows, accountId: payload.accountId, channel });
    if (!r.ok) return { ok: false, error: `按配方读到 ${outcome.rows.length} 行，但没能入库——${r.reason}`, summary: '没入库' };
    return {
      ok: true,
      summary: `已用${via}按配方采完自己的 ${payload.platform} 主页：入库 ${r.posts} 条作品${r.followers != null ? `，粉丝 ${r.followers}` : ''}（记在账号「${r.account.name}」名下）`,
      data: { accountId: payload.accountId, posts: r.posts, skipped: r.skipped, followers: r.followers },
    };
  }
  const r = await ingestPlatformRecipeRows({ workspaceId, platformKey: platform, url, values: outcome.values, rows: outcome.rows, competitorId: payload.competitorId, channel });
  if (!r.ok) return { ok: false, error: `按配方读到 ${outcome.rows.length} 行，但没能入库——${r.reason}`, summary: '没入库' };
  return {
    ok: true,
    summary: `已用${via}按配方采完竞对「${r.competitor}」：入库 ${r.posts} 条作品${r.skipped ? `（${r.skipped} 行抠不出作品 ID，跳过）` : ''}`,
    data: { competitorId: payload.competitorId, posts: r.posts, skipped: r.skipped },
  };
}

async function recipePlatform(recipeId: string): Promise<string> {
  const r = await prisma.scrapeRecipe.findUnique({ where: { id: recipeId }, select: { platformKey: true } });
  return r?.platformKey ?? '';
}

/**
 * 页面直读落库（2026-09-16）：解析器/配方读不到时，模型从页面可见文字里读出作品与数字，过三道机器闸再入库。
 * 回执里必须写明「模型直读」——用户要看得出这份数据是怎么来的；解析器没认出的原因也一并带上。
 */
export async function ingestPageRead(input: {
  workspaceId: string;
  payload: Exclude<BrowserTaskPayload, { kind: 'open_and_read' | 'collect_self_backend' }>;
  read: PageRead;
  channel: Channel;
  via: string;
  parserError?: string;
}): Promise<LocalRunResult> {
  const { workspaceId, payload, read, channel, via } = input;
  const isSelf = payload.kind === 'collect_self_profile' || payload.kind === 'collect_self_recipe';
  let platform = '';
  let handle = '';
  let competitorName = '';
  if (isSelf) {
    platform = payload.platform;
    handle = payload.handle;
  } else {
    const comp = await prisma.competitorAccount.findUnique({ where: { id: payload.competitorId }, select: { platform: true, handle: true, name: true } });
    if (!comp) return { ok: false, error: '竞对不存在', summary: '竞对不存在' };
    platform = comp.platform; handle = comp.handle; competitorName = comp.name;
  }
  const tenantId = await tenantOf(workspaceId);
  const ex = await extractPostsFromPage({ tenantId, platform, read });
  if (!ex.ok) return { ok: false, error: ex.error, summary: '模型直读没读出' };
  if (ex.data.posts.length === 0) {
    return { ok: false, error: `模型直读没读出可入库的作品（页面上认得出作品 ID 的链接 ${ex.data.candidates} 条${ex.data.dropped ? `，${ex.data.dropped} 条因数字对不上页面文字被丢弃` : ''}）`, summary: '模型直读没读出' };
  }
  const why = input.parserError ? `解析器没认出这一页（${input.parserError.slice(0, 80)}），` : '';
  const flag = `⚠️ 这批是**模型直读**页面文字得到的（每个数字都核对过在页面上原样出现），不是解析器读的`;
  const parsed: ParsedPagePayload = {
    platform, handle, posts: ex.data.posts,
    ...(ex.data.profile.name || ex.data.profile.followers !== undefined ? { profile: { ...(ex.data.profile.name ? { name: ex.data.profile.name } : {}), ...(ex.data.profile.followers !== undefined ? { followers: ex.data.profile.followers, followersVia: 'text' as const } : {}) } } : {}),
  };
  if (isSelf) {
    const posts = ownPostIngestSchema.safeParse({ platform, handle, accountId: payload.accountId, channel, posts: parsed.posts.slice(0, 50) });
    if (!posts.success) return { ok: false, error: `模型直读出的数据格式不合法：${posts.error.issues[0]?.message ?? ''}`, summary: '数据格式不合法' };
    const saved = await ingestOwnPostData(workspaceId, posts.data);
    if (!saved.ok) return { ok: false, error: saved.error, summary: '回填没落库' };
    if (parsed.profile?.followers !== undefined) {
      const acc = ownAccountIngestSchema.safeParse({ platform, accountId: payload.accountId, dailyStats: [{ date: todayStr(), followers: parsed.profile.followers }] });
      if (acc.success) await ingestOwnAccountData(payload.accountId, acc.data).catch(() => null);
    }
    return {
      ok: true,
      summary: `${why}已用${via}把自己的 ${platform} 主页交给模型直读：新增 ${saved.created} 条、更新 ${saved.updated} 条${ex.data.dropped ? `（${ex.data.dropped} 条数字对不上页面被丢弃）` : ''}（记在账号「${saved.targetAccount?.name ?? payload.accountId}」名下）。${flag}`,
      data: { accountId: payload.accountId, created: saved.created, updated: saved.updated, skipped: saved.skipped, modelRead: true, dropped: ex.data.dropped },
    };
  }
  const parsedIn = ingestPayloadSchema.safeParse({ platform, handle, autoSubscribe: false, profile: parsed.profile, posts: parsed.posts.slice(0, 50) });
  if (!parsedIn.success) return { ok: false, error: `模型直读出的数据格式不合法：${parsedIn.error.issues[0]?.message ?? ''}`, summary: '数据格式不合法' };
  const saved = await ingestCompetitorData(workspaceId, parsedIn.data, { channel });
  if (!saved.ok) return { ok: false, error: saved.error, summary: '入库被拒' };
  return {
    ok: true,
    summary: `${why}已用${via}把竞对「${competitorName || saved.competitor}」的主页交给模型直读：${saved.posts} 条作品（${saved.withMetrics} 条带指标${ex.data.dropped ? `，${ex.data.dropped} 条数字对不上页面被丢弃` : ''}）。${flag}`,
    data: { competitorId: payload.competitorId, posts: saved.posts, withMetrics: saved.withMetrics, modelRead: true, dropped: ex.data.dropped },
  };
}

/** 桌面执行器交回的原料（parsed）是什么形状。三种：解析器产物 / 后台读数 / 配方结局；都可以附带页面直读。 */
export type ExecutorParsed =
  | (ParsedPagePayload & { read?: PageRead })
  | { backend: BackendPayload }
  | { recipe: RecipeOutcome; read?: PageRead; url?: string }
  | { read: PageRead; parserError?: string };

/**
 * 桌面执行器交回结果的唯一入口（/api/ingest/tasks POST）。按任务 kind 与原料形状分发到上面各出口；
 * 本机浏览器那条路不经这里（它在 runBrowserTaskLocally 里就近落库），但落库函数是同一批。
 */
export async function ingestExecutorResult(input: {
  workspaceId: string;
  payload: BrowserTaskPayload;
  parsed: ExecutorParsed;
  channel: Channel;
  via: string;
}): Promise<LocalRunResult> {
  const { workspaceId, payload, parsed, channel, via } = input;
  if (payload.kind === 'open_and_read') return { ok: false, error: '读网页的任务不该带 parsed 回来', summary: '形状不对' };

  if (payload.kind === 'collect_self_backend') {
    if (!('backend' in parsed) || !parsed.backend) return { ok: false, error: '后台回填的任务交回的不是后台读数', summary: '形状不对' };
    return ingestBackendPayload({ workspaceId, payload, backend: parsed.backend, channel, via });
  }
  if (payload.kind === 'collect_competitor_recipe' || payload.kind === 'collect_self_recipe') {
    if (!('recipe' in parsed) || !parsed.recipe) return { ok: false, error: '配方采集的任务交回的不是配方结局', summary: '形状不对' };
    const target = await executorTarget({ kind: payload.kind, payload });
    const recipe = target ? await platformRecipeFor(workspaceId, target.platform) : null;
    if (!recipe || !target) return { ok: false, error: '找不到这个平台的内置配方', summary: '没有配方' };
    return ingestRecipeOutcome({ workspaceId, payload, recipe, outcome: parsed.recipe, read: parsed.read, url: parsed.url || target.url, channel, via });
  }
  // 主页类：解析器产物优先；没有作品但带了页面直读 → 模型直读兜底
  const page = parsed as ParsedPagePayload & { read?: PageRead; parserError?: string };
  if (Array.isArray(page.posts) && page.posts.length > 0) {
    return ingestParsedPage({ workspaceId, payload, parsed: page, channel, via });
  }
  if (page.read) {
    const fb = await ingestPageRead({ workspaceId, payload, read: page.read, channel, via, parserError: page.parserError });
    if (fb.ok) return fb;
    return { ok: false, error: `${page.parserError ? `${page.parserError}；` : ''}${fb.error}`, summary: fb.summary };
  }
  return ingestParsedPage({ workspaceId, payload, parsed: page, channel, via });
}

/**
 * 一条任务要打开哪一页。领活的执行器（桌面客户端）拿到它就只管「开页 → 注入解析器 → 交回解析结果」，
 * 平台地址怎么拼、竞对 handle 是什么都不用知道——那些只在服务端有一份。
 */
export async function executorTarget(task: { kind: string; payload: BrowserTaskPayload }): Promise<{ url: string; platform: string } | null> {
  const p = task.payload;
  // 创作者后台：入口是裸地址（backend-entries.ts，与插件同一份），站内走哪几页由注入的 self-backend.js 算
  if (p.kind === 'collect_self_backend') {
    const entry = backendEntryFor(p.platform);
    return entry ? { url: entry.url, platform: p.platform } : null;
  }
  if (p.kind === 'collect_self_profile' || p.kind === 'collect_self_recipe') {
    const url = competitorHomeUrl(p.platform, p.handle);
    return url ? { url, platform: p.platform } : null;
  }
  if (p.kind === 'collect_competitor' || p.kind === 'collect_competitor_recipe') {
    const comp = await prisma.competitorAccount.findUnique({ where: { id: p.competitorId }, select: { platform: true, handle: true } });
    const url = comp ? competitorHomeUrl(comp.platform, comp.handle) : null;
    return url && comp ? { url, platform: comp.platform } : null;
  }
  if (p.kind === 'open_and_read') return { url: p.url, platform: '' };
  return null;
}

export async function runBrowserTaskLocally(input: {
  cdpUrl: string;
  workspaceId: string;
  payload: BrowserTaskPayload;
  /**
   * 撞上登录墙时找谁（2026-09-17）。**只有「有人在等」的调用方才传**：
   * 传了就会把登录页私发给他、并等他扫码（最多 LOGIN_WAIT_BUDGET_MS）；
   * 不传就是老行为——如实报「还没登录」，一秒都不等。
   * 定时批量采集那条路一定不要传：本机浏览器是串行锁，一等就把后面的活全堵住。
   */
  help?: Omit<LoginHelpCtx, 'workspaceId' | 'platform'> | null;
}): Promise<LocalRunResult> {
  const { cdpUrl, workspaceId, payload } = input;
  const label = KIND_LABEL[payload.kind];
  const helpFor = (platform: string): LoginHelpCtx | undefined =>
    input.help ? { workspaceId, platform, runId: input.help.runId ?? null, taskId: input.help.taskId ?? null } : undefined;

  // 创作者后台（2026-09-16 起本机浏览器也进）：入口 → 探针 → 逐站读数，脚本是插件那份 self-backend.js
  if (payload.kind === 'collect_self_backend') {
    const r = await collectBackendLocal(cdpUrl, payload.platform, { help: helpFor(payload.platform) });
    if (!r.ok) return { ok: false, error: r.error, summary: `本机浏览器没采到：${label}` };
    return ingestBackendPayload({ workspaceId, payload, backend: r.payload, channel: 'local_browser', via: '本机浏览器' });
  }

  // 配方（竞对 / 自己的主页）：规则由服务端给，页面里跑插件那份 recipe-run.js；学不会时模型直读兜底
  if (payload.kind === 'collect_competitor_recipe' || payload.kind === 'collect_self_recipe') {
    const target = await executorTarget({ kind: payload.kind, payload });
    if (!target) return { ok: false, error: '拼不出这个主页的地址', summary: '没有主页地址' };
    const recipe = await platformRecipeFor(workspaceId, target.platform);
    if (!recipe) return { ok: false, error: `${target.platform} 的内置配方还没播种（服务端太旧？）`, summary: '没有配方' };
    const r = await collectRecipeLocal(cdpUrl, target.url, recipe, { help: helpFor(target.platform) });
    if (!r.ok) return { ok: false, error: r.error, summary: `本机浏览器没采到：${label}` };
    return ingestRecipeOutcome({ workspaceId, payload, recipe, outcome: r.outcome, read: r.read, url: r.finalUrl || target.url, channel: 'local_browser', via: '本机浏览器' });
  }

  if (payload.kind === 'open_and_read') {
    // 白名单与开关在 vet.ts 已判过；这里只读正文
    const r = await browseLocal(cdpUrl, payload.url, undefined, 0, {});
    if (!r.ok) return { ok: false, error: r.error, summary: `本机浏览器没读到：${label}` };
    return {
      ok: true,
      summary: `已用本机浏览器读完：${r.title || payload.url}（${(r.text ?? '').length} 字）`,
      data: { url: payload.url, title: r.title, text: r.text ?? '', meta: r.meta },
    };
  }

  const target = await executorTarget({ kind: payload.kind, payload });
  if (!target) return { ok: false, error: `${payload.kind === 'collect_competitor' ? '竞对' : payload.platform} 没有公开主页可开`, summary: '没有主页地址' };
  const r = await collectPlatformPageLocal(cdpUrl, target.url, target.platform, { deep: true, help: helpFor(target.platform) });
  if (!r.ok) {
    // 解析器认不出但页面读回来了：模型直读兜底（页面直读，2026-09-16）
    if (r.read) {
      const fb = await ingestPageRead({ workspaceId, payload, read: r.read, channel: 'local_browser', via: '本机浏览器', parserError: r.error });
      if (fb.ok) return fb;
    }
    return { ok: false, error: r.error, summary: `本机浏览器没采到：${label}` };
  }
  return ingestParsedPage({ workspaceId, payload, parsed: r.payload, channel: 'local_browser', via: '本机浏览器' });
}
