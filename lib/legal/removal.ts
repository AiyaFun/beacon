import { prisma } from '../db';
import { parseCompetitorUrl } from '../competitor-url';

// 数据移除申请（《个人信息保护法》处理已公开个人信息时的拒绝权）的**执行闸**。
//
// 此前这张表只有写入、没有执行：公开页收下了退出申请，采集链路却从不查它——
// 等于对外承诺了一个代码兑现不了的权利。这是法律承诺缺口，不是普通功能缺口，
// 所以两条采集通道（定时抓取 + 插件回传）都必须过这道闸。
//
// 状态口径：
//   · pending  —— 待核验也**先停采**。宁可少采几天，也不在核验期间继续采集被投诉的账号。
//   · verified / removed —— 已确认，停采。
//   · rejected —— 核验为无效申请（如冒用他人身份主张他人账号），恢复采集。
const BLOCKING_STATUSES = ['pending', 'verified', 'removed'];

// ── handle 的「同一个号」口径 ──────────────────────────────────────────────
//
// 申请页写的是「主页链接**或标识**」。贴链接那条路早就归一了，**手打标识**那条路却是原样存的，
// 而 @ 平台上的人写自己的名字天然带 @：X/TikTok 的人写 `@AiyaFun`，库里存的是 `AiyaFun`；
// YouTube 反过来，库里存的是带 @ 的 `@handle`，而人可能只写 `handle`。两边永远对不上，
// 于是这道闸「看起来在执行、实际一条都拦不住」——正是本文件头要防的那件事，只是换了个入口。
// 大小写同理：这些平台的用户名不区分大小写，人打字时也不会照抄注册时的大小写。
//
// 口径按平台分，**不能一刀切**：
//   · x / tiktok        —— 库里不带 @；用户名不区分大小写 → 去 @ + 转小写
//   · youtube           —— 库里 @handle 带 @（见 lib/competitor-url.ts 文件头）→ 补 @ + 转小写；
//                          但 `UC…` 是频道 ID，大小写有意义，原样不动
//   · douyin / xiaohongshu —— sec_user_id / user_id 是不透明 ID，**大小写有意义**，
//                          转小写会把两个不同的号判成同一个，那是比漏拦更坏的错误 → 原样
const AT_PLATFORMS = new Set(['x', 'tiktok', 'youtube']);
const isYoutubeChannelId = (h: string) => /^UC[\w-]{20,}$/.test(h);

/** 该平台的 handle 是否「@ 与大小写不敏感」——只有这几个平台才允许做变体匹配 */
function loose(platform: string, handle: string): boolean {
  if (!AT_PLATFORMS.has(platform)) return false;
  return !(platform === 'youtube' && isYoutubeChannelId(handle.replace(/^@+/, '')));
}

/** 归一到「入库该长什么样」。存申请时用这个，两边才落在同一个形状上。 */
export function canonicalRemovalHandle(platform: string, rawHandle: string): string {
  const h = (rawHandle ?? '').trim();
  if (!h || !loose(platform, h)) return h;
  const bare = h.replace(/^@+/, '').toLowerCase();
  return platform === 'youtube' ? `@${bare}` : bare;
}

/**
 * 一个 handle 的全部等价写法。查询用 `in` 精确匹配这一组，而不是 `mode: 'insensitive'`——
 * 后者 SQLite 不支持（dev/测试用 sqlite、生产用 postgres，见 prisma/schema*.prisma），
 * 会出现「本地测试全绿、生产才是另一套行为」这种最难查的分歧。
 */
export function removalHandleVariants(platform: string, rawHandle: string): string[] {
  const h = (rawHandle ?? '').trim();
  if (!h) return [];
  const out = new Set<string>([h]);
  if (loose(platform, h)) {
    const bare = h.replace(/^@+/, '');
    for (const v of [bare, `@${bare}`, bare.toLowerCase(), `@${bare.toLowerCase()}`]) out.add(v);
  }
  return [...out].filter(Boolean);
}

/**
 * 把用户填的「主页链接或标识」规范化成与 CompetitorAccount.handle 同口径的值。
 * 必须规范化后再存：申请人填的通常是整条主页 URL，而采集侧存的是纯 handle，
 * 不归一的话这道闸永远匹配不上——看起来在执行，实际一条都拦不住。
 */
export function normalizeRemovalTarget(platform: string, rawHandle: string): { platform: string; handle: string } {
  const raw = rawHandle.trim();
  if (/https?:\/\//i.test(raw) || /\.(com|cn|tv)\//.test(raw)) {
    const parsed = parseCompetitorUrl(raw);
    if (parsed) return { platform: parsed.platform, handle: canonicalRemovalHandle(parsed.platform, parsed.handle) };
  }
  return { platform, handle: canonicalRemovalHandle(platform, raw) };
}

/** 该账号是否已被申请移除（生效中）→ true 表示**不得再采集**。 */
export async function isRemovalRequested(platform: string, handle: string): Promise<boolean> {
  if (!handle) return false;
  // 变体匹配同时兜住两件事：申请人写法不同，以及**本次修复之前**存进去的历史申请行
  // （那些行没归一过，形状就是申请人当时敲的样子）。
  const hit = await prisma.dataRemovalRequest.findFirst({
    where: { platform, handle: { in: removalHandleVariants(platform, handle) }, status: { in: BLOCKING_STATUSES } },
    select: { id: true },
  });
  return hit !== null;
}

/**
 * 真正**移除已采集的数据**。
 *
 * 停采只兑现了申请页承诺的一半——页面写的是「停止采集**并移除已收集的**相关公开信息」。
 * 只挡住新数据、库里旧数据照留，那句承诺仍然是假的。
 *
 * 删什么：竞对档案 + 其作品 + 作品快照（CrawledPost/PostMetricSnapshot 走 onDelete: Cascade）
 *        + 各工作区的关注项（WatchlistItem 同样级联）
 *        + 采集台账里指向它的行（CollectionRun 无外键、不会级联，必须手删——
 *          那些行留着账号名与"哪几天采过它"，同属承诺要移除的相关信息）。
 * 不删什么：**别人基于该账号做出的选题/草稿/记忆**——那是用户自己的创作产物，
 *          不属于被申请人的个人信息，删它属于越权处置第三方数据。
 *
 * 返回真实删除量，供运营核对与审计留痕（"说删了"与"删了什么"必须对得上）。
 */
export type PurgeResult = {
  accounts: number;
  posts: number;
  watchlistItems: number;
  runs: number;
  commentQuestions: number;
  /** 该账号作品评论区留存的读者原声正文（ReaderComment，scope='rival'） */
  readerComments: number;
};

export async function purgeRemovedAccountData(
  platform: string,
  handle: string,
): Promise<PurgeResult> {
  // 从**这一个**账号作品评论区提取的读者提问（source='rival-comment'）。
  // InspirationItem 没有 competitorId 外键、不会级联，只能手删——两条都要点住：
  // ⚠️ ① **必须按 handle 定位**。只按 `{ source, platform }` 删会把同平台**所有**账号、
  //      且是**所有工作区**的读者提问一起清空：一个人申请移除，全站抖音提问归零，
  //      不可恢复、也没人会发现。定位靠 InspirationItem.author（入库写的是作品作者 handle，
  //      见 lib/ingest/comment-questions.ts）。
  // ⚠️ ② **删在 account 存在性检查之前**。评论提问可以从**任何**公开作品页提取，
  //      被提取的账号未必在竞对库里有档案；早退会让「档案不存在」的账号删不掉它名下的提问。
  const variants = removalHandleVariants(platform, handle);
  let commentQuestions = (await prisma.inspirationItem.deleteMany({
    where: { source: 'rival-comment', platform, author: { in: variants } },
  })).count;

  // 读者原声正文（ReaderComment）。上面两条 ⚠️ 一字不差地适用于它：同样按 handle 定位、
  // 同样删在存在性检查之前。它比提问更要紧——存的是评论原文，
  // 「已经不采你了」却把你作品下的读者原话留着，这句承诺就是假的。
  let readerComments = (await prisma.readerComment.deleteMany({
    where: { scope: 'rival', platform, author: { in: variants } },
  })).count;

  // findUnique 要求 handle **逐字**相等，而申请人写的与采集侧存的往往只差 @ 或大小写
  // （见上方 loose 平台的说明）。先按等价写法精确找，找不到再在该平台内做一次大小写无关的比对：
  // 这是运营手动流转申请时才走的路径，不在采集热路径上，扫一次可以接受；
  // 而「档案明明在库里、却因为大小写没删掉」等于对被申请人的承诺没兑现。
  let account = await prisma.competitorAccount.findFirst({
    where: { platform, handle: { in: variants } },
    select: { id: true, handle: true },
  });
  if (!account && loose(platform, handle)) {
    const key = handle.replace(/^@+/, '').toLowerCase();
    const rows = await prisma.competitorAccount.findMany({ where: { platform }, select: { id: true, handle: true } });
    account = rows.find((r) => r.handle.replace(/^@+/, '').toLowerCase() === key) ?? null;
    // 用真实存进去的那个写法再清一次提问：上面那次用的是申请人的写法，可能一条都没删到
    if (account && !variants.includes(account.handle)) {
      commentQuestions += (await prisma.inspirationItem.deleteMany({
        where: { source: 'rival-comment', platform, author: account.handle },
      })).count;
      readerComments += (await prisma.readerComment.deleteMany({
        where: { scope: 'rival', platform, author: account.handle },
      })).count;
    }
  }
  if (!account) return { accounts: 0, posts: 0, watchlistItems: 0, runs: 0, commentQuestions, readerComments };

  const posts = await prisma.crawledPost.count({ where: { competitorId: account.id } });
  const watchlistItems = await prisma.watchlistItem.count({ where: { competitorId: account.id } });
  // 采集台账指向被删账号：无外键 → 不会级联，删在前面（删完档案就再也查不到 targetId 了）
  const { count: runs } = await prisma.collectionRun.deleteMany({
    where: { scope: 'rival', targetId: account.id },
  });
  // 其余级联由 schema 保证（CrawledPost.competitor / WatchlistItem.competitor 均 onDelete: Cascade）
  await prisma.competitorAccount.delete({ where: { id: account.id } });
  return { accounts: 1, posts, watchlistItems, runs, commentQuestions, readerComments };
}

/**
 * 流转一条申请的状态，并在「确认成立」时顺手执行移除。
 * verified/removed 都视为成立——两者的差别只在运营口径（已核验 / 已执行），
 * 对被申请人的结果是同一件事：数据没了、以后也不采。
 */
export async function resolveRemovalRequest(
  id: string,
  status: 'verified' | 'removed' | 'rejected',
  // 返回类型必须是完整的 PurgeResult：少列一项（台账行数、读者提问数），
  // 运营在回执里就看不到它删了什么，「说删了」与「删了什么」就对不上了。
): Promise<{ ok: boolean; purged?: PurgeResult; error?: string }> {
  const req = await prisma.dataRemovalRequest.findUnique({ where: { id } });
  if (!req) return { ok: false, error: '申请不存在' };

  await prisma.dataRemovalRequest.update({
    where: { id },
    data: { status, resolvedAt: new Date() },
  });
  if (status === 'rejected') return { ok: true };

  const purged = await purgeRemovedAccountData(req.platform, req.handle);
  return { ok: true, purged };
}
