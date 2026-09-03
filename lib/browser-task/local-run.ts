// 没装插件时，把「本该排给插件的活」交给本机浏览器**当场**跑（2026-09-03）。
//
// 与排队那条路（lib/browser-task/index.ts）的分工：payload 形状、三道闸（vet.ts）、落库函数
// 全都复用，只是执行者从「插件下次醒来」换成「这台机器上的 Chrome 现在就去」。
// 所以 AI 拿到的是**结果**而不是一张回执——用户不用等插件醒。
import { prisma } from '../db';
import { can as editionCan } from '../edition';
import { vetCdpUrl, browseLocal } from '../browser/local';
import { collectPlatformPageLocal, type ParsedPagePayload } from '../browser/local-collect';
import { competitorHomeUrl } from '../competitor-url';
import { ingestOwnPostData, ownPostIngestSchema } from '../ingest/own-post';
import { ingestOwnAccountData, ownAccountIngestSchema } from '../ingest/own-account';
import { ingestCompetitorData, ingestPayloadSchema } from '../ingest/competitor';
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
export const LOCAL_BROWSER_WAKE_HINT = '到「设置 → 本机权限」点一下「开启浏览器操作」（或客户端托盘的「启动采集浏览器」）';

export type LocalRunResult =
  | { ok: true; summary: string; data?: Record<string, unknown> }
  | { ok: false; error: string; summary: string };

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
  if (!parsed?.posts?.length) return { ok: false, error: '主页上没读到作品（可能没加载完，或这个号还没发过内容）', summary: '没读到作品' };

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

/**
 * 一条任务要打开哪一页。领活的执行器（桌面客户端）拿到它就只管「开页 → 注入解析器 → 交回解析结果」，
 * 平台地址怎么拼、竞对 handle 是什么都不用知道——那些只在服务端有一份。
 */
export async function executorTarget(task: { kind: string; payload: BrowserTaskPayload }): Promise<{ url: string; platform: string } | null> {
  const p = task.payload;
  if (p.kind === 'collect_self_profile') {
    const url = competitorHomeUrl(p.platform, p.handle);
    return url ? { url, platform: p.platform } : null;
  }
  if (p.kind === 'collect_competitor') {
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
}): Promise<LocalRunResult> {
  const { cdpUrl, workspaceId, payload } = input;
  const label = KIND_LABEL[payload.kind];

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
  const r = await collectPlatformPageLocal(cdpUrl, target.url, target.platform, { deep: true });
  if (!r.ok) return { ok: false, error: r.error, summary: `本机浏览器没采到：${label}` };
  return ingestParsedPage({ workspaceId, payload, parsed: r.payload, channel: 'local_browser', via: '本机浏览器' });
}
