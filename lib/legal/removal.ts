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

// 申请人类型。account = 被监控账号的权利人；comment = 在别人作品下留言的读者本人。
// 两者执行的动作完全不同，见 isRemovalRequested 与 resolveRemovalRequest 里的分叉。
export const ACCOUNT_KIND = 'account';
export const COMMENT_KIND = 'comment';
/**
 * 站点权利人：「别再抓我这个网站」。
 *
 * 【为什么必须单开一类，而不是塞进 account】前两类的主体都是**平台上的一个账号**
 * （platform + handle）。任意站点采集配方面对的是**一个网站**，它没有平台、没有 handle——
 * 硬塞进 account 会让 `isRemovalRequested('site', 'example.com')` 这种调用看起来合法，
 * 而 account 那条闸是按平台账号写的，两者的执行动作完全不同。
 *
 * 【这一类是 2026-08-29 补的欠账】批二做「配方抓到的数落库」时，我在 PRD 里写了
 * 「移除申请停采闸留给批四」，批四做完却没做它——于是有一段时间里，
 * 任意站点的内容被存进库，而站点权利人**没有任何办法让我们停下来**。
 */
export const SITE_KIND = 'site';
/** 站点类申请占用的 platform 值。它不是内容平台，只是这一类的固定标记。 */
export const SITE_PLATFORM = 'site';

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
    where: {
      platform,
      handle: { in: removalHandleVariants(platform, handle) },
      status: { in: BLOCKING_STATUSES },
      // ⚠️ 只有账号权利人的申请能停采。评论者本人那类（kind='comment'）填的 handle 是
      // **作品作者**的账号，不是他自己的——放进这道闸，就成了「张三删掉自己在李四视频下的
      // 一条评论」→ 全平台停采李四并删光李四的档案。拿一个人的权利去伤害另一个人，
      // 比不执行这个权利更坏。测试：tests/legal/removal-comment.test.ts
      kind: ACCOUNT_KIND,
    },
    select: { id: true },
  });
  return hit !== null;
}

// ── 站点级停采 ──────────────────────────────────────────────────────────
//
// 【与账号级的区别】账号级问的是「这个号的内容还采不采」；站点级问的是
// 「这个域名还去不去」。后者的判据只有一个：**主机名**。

/**
 * 归一到「入库该长什么样」：只留主机名、转小写、去掉开头的 `www.`。
 *
 * 【为什么归到主机名而不是完整 origin】站点权利人说的是「别抓我的站」，
 * 而 `http://` 与 `https://`、带不带 `www.` 是同一个站。按完整 origin 存的话，
 * 他写 `https://www.example.com`，我们照样去抓 `http://example.com`——
 * 这道闸就成了看起来在执行、实际拦不住的那种。
 */
export function canonicalRemovalSite(raw: string): string {
  const t = String(raw ?? '').trim();
  if (!t) return '';
  let host = t;
  try {
    host = new URL(t.includes('://') ? t : `https://${t}`).hostname;
  } catch {
    host = t.replace(/^[a-z]+:\/\//i, '').split('/')[0];
  }
  return host.toLowerCase().replace(/^www\./, '');
}

/**
 * 这个站点被要求停采了吗。
 *
 * 【子域按点分段从右往左比】站点权利人申请 `example.com`，`blog.example.com` 也该停——
 * 那是同一个人的站。但**绝不能用裸 includes/endsWith**：
 * `endsWith('example.com')` 会把 `notexample.com` 也算进去，
 * 那是拿一个人的权利去停掉另一个人的站，比漏拦更坏。
 * 这条判据与 lib/scrape/recipe.ts 的域名黑名单是同一套写法。
 */
export async function isSiteRemovalRequested(origin: string): Promise<boolean> {
  const host = canonicalRemovalSite(origin);
  if (!host) return false;

  const rows = await prisma.dataRemovalRequest.findMany({
    where: { kind: SITE_KIND, status: { in: BLOCKING_STATUSES } },
    select: { handle: true },
  });
  const parts = host.split('.');
  return rows.some((r) => {
    const asked = canonicalRemovalSite(r.handle);
    if (!asked) return false;
    if (asked === host) return true;
    const segs = asked.split('.');
    // 必须落在点分段边界上：notexample.com 的段是 ['notexample','com']，
    // 与 ['example','com'] 的尾段比对不相等 → 不误停
    return parts.length > segs.length && parts.slice(-segs.length).join('.') === asked;
  });
}

/**
 * 站点被确认停采后，移除已经存下来的东西。
 *
 * 删什么：这个站点下的**采集记录**（ScrapeRecord，存的是它页面上的字段值）。
 * 配方本身**不删、改成 stopped**：配方是用户自己写的东西（他要抓哪几个字段），
 * 删掉等于处置了第三方的资产；停掉就已经兑现了「不再采你」。
 * 而**留着一条明确标注「已停采」的配方**，比让它无声消失更好——
 * 用户会知道为什么它不跑了，否则他只会重新建一个一模一样的。
 */
/**
 * 命中这个站点的配方 id。
 *
 * 【为什么单独抽出来】删和「数一数将要删什么」必须用**同一段**匹配逻辑。
 * 各写一份的结局这个文件里就有先例：运营脚本曾经自己抄了一份删除实现，
 * 注释写着「与 lib 同一套语义」，实际差了三处（见 scripts/removal-requests.ts 文件头）。
 * dry-run 报的数与真删的数对不上，比不给 dry-run 更坏。
 *
 * origin 字段存的是完整 origin（https://www.example.com），这里按主机名匹配，
 * 所以先取候选再在内存里按点分段判据过滤——**不用 SQL 的 contains**，
 * 那会让 notexample.com 一起中招。
 */
export async function siteRecipeIdsFor(origin: string): Promise<string[]> {
  const host = canonicalRemovalSite(origin);
  if (!host) return [];
  const all = await prisma.scrapeRecipe.findMany({ select: { id: true, origin: true } });
  return all.filter((r) => sameSiteOrSub(canonicalRemovalSite(r.origin), host)).map((r) => r.id);
}

/** dry-run：数一数站点类会删掉什么。与 purgeRemovedSiteData 共用同一段匹配。 */
export async function countRemovedSiteData(origin: string): Promise<{ records: number; recipes: number; clips: number }> {
  const ids = await siteRecipeIdsFor(origin);
  // 【不能在这里早退】一个站点完全可能「没有配方、但有剪藏」——用户从来没为它建过配方，
  // 只是在群里发过几条它的链接。早退会让 dry-run 报「0 条」，运营据此以为没东西可删。
  const clips = (await siteClippedIds(origin)).length;
  if (ids.length === 0) return { records: 0, recipes: 0, clips };
  return {
    records: await prisma.scrapeRecord.count({ where: { recipeId: { in: ids } } }),
    // 只数还没停的：已经 stopped 的再「停」一次不是这次的效果
    recipes: await prisma.scrapeRecipe.count({ where: { id: { in: ids }, status: { not: 'stopped' } } }),
    // 剪藏正文也要数进来：dry-run 报的数与真正执行时删掉的必须是同一批，
    // 否则运营看着「0 条」按了执行，实际删了一堆——或者反过来
    clips,
  };
}

/** dry-run：数一数 comment 类会删掉几条。与 purgeOneComment 同一条判据（平台 + 正文全等）。 */
export async function countRemovedComment(platform: string, commentText: string): Promise<number> {
  const text = (commentText ?? '').trim();
  if (!text) return 0;
  return prisma.readerComment.count({ where: { platform, text } });
}

/**
 * 从这个站点剪藏来的正文（lib/clip 那条路存进 InspirationItem 的）。
 *
 * 【为什么单独一段】剪藏是**第四条**从站点取内容的路，而它存的是**他人作品的正文全文**——
 * 比配方那几个字段值敏感得多。原来它既没挂停采闸，也不在任何清理路径里：
 * 站点权利人申请之后，我们嘴上说「删除已经从该站取到的数据」，正文却原封不动留着。
 *
 * 【为什么按 url 前缀匹配而不是 platform】剪藏来的条目 platform 可能为空（手动录入），
 * url 才是唯一能定位到站点的字段。子域一并算上，与 sameSiteOrSub 同一条口径。
 */
async function siteClippedIds(origin: string): Promise<string[]> {
  // 与 siteRecipeIdsFor 同一套归一（去 www.、小写、容忍不带协议的写法）——
  // 两处用不同的归一，等于同一个申请在两张表上匹配到不同的范围
  const host = canonicalRemovalSite(origin);
  if (!host) return [];
  // 先按 host 粗筛（数据库能用上索引/少扫），再在内存里按段精确比——
  // 裸 contains 会把 notexample.com 也捞进来，那是拿一个人的权利删另一个人的东西
  const rows = await prisma.inspirationItem.findMany({
    where: { url: { contains: host } },
    select: { id: true, url: true },
  });
  return rows.filter((r) => {
    try { return sameSiteOrSub(canonicalRemovalSite(new URL(r.url!).host), host); } catch { return false; }
  }).map((r) => r.id);
}

export async function purgeRemovedSiteData(origin: string): Promise<{ records: number; recipes: number; clips: number }> {
  const hitIds = await siteRecipeIdsFor(origin);
  const clipIds = await siteClippedIds(origin);
  if (hitIds.length === 0 && clipIds.length === 0) return { records: 0, recipes: 0, clips: 0 };

  const records = hitIds.length
    ? (await prisma.scrapeRecord.deleteMany({ where: { recipeId: { in: hitIds } } })).count
    : 0;
  const recipes = hitIds.length
    ? (await prisma.scrapeRecipe.updateMany({ where: { id: { in: hitIds } }, data: { status: 'stopped' } })).count
    : 0;
  // 剪藏是**删**不是停：配方是用户自己写的东西（停掉就已经不再采了），
  // 而这些是从该站点取回来的正文本身，承诺里写的就是「删除已经从该站取到的数据」。
  const clips = clipIds.length
    ? (await prisma.inspirationItem.deleteMany({ where: { id: { in: clipIds } } })).count
    : 0;
  return { records, recipes, clips };
}

/** host 等于 asked，或者是它的子域（按点分段比，不用 endsWith）。 */
function sameSiteOrSub(host: string, asked: string): boolean {
  if (!host || !asked) return false;
  if (host === asked) return true;
  const parts = host.split('.');
  const segs = asked.split('.');
  return parts.length > segs.length && parts.slice(-segs.length).join('.') === asked;
}

/** 只删申请人自己写的那一条评论正文。返回真实删除行数。 */
export async function purgeOneComment(
  platform: string,
  commentText: string,
): Promise<{ readerComments: number }> {
  const text = commentText.trim();
  // 空串会匹配到**全平台每一条**评论：`{ text: '' }` 在 Prisma 里是精确等于空串没错，
  // 但一旦哪天有人改成 contains，空串就成了「删光」。在入口挡住，不依赖下游写法。
  if (!text) return { readerComments: 0 };
  const { count } = await prisma.readerComment.deleteMany({ where: { platform, text } });
  return { readerComments: count };
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
  /** 站点级停采时删掉的采集记录（ScrapeRecord） */
  scrapeRecords: number;
  /** 站点级停采时停掉的配方（ScrapeRecipe → status='stopped'，**不删**） */
  scrapeRecipes: number;
  /** 随被删作品一并清掉的 AI 引用回执（AiCitation） */
  aiCitations: number;
  /**
   * 站点级停采时删掉的**剪藏正文**（InspirationItem）。
   *
   * 与上面 scrapeRecipes 的处置**刻意不同**：配方是用户自己写的取数规则，停掉就已经不再采了；
   * 而这些是从该站点取回来的**正文全文**，承诺里写的是「删除已经从该站取到的数据」，
   * 所以它是删不是停。
   */
  clips: number;
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
  if (!account) {
    return {
      accounts: 0, posts: 0, watchlistItems: 0, runs: 0, commentQuestions, readerComments,
      scrapeRecords: 0, scrapeRecipes: 0, aiCitations: 0, clips: 0,
    };
  }

  const posts = await prisma.crawledPost.count({ where: { competitorId: account.id } });
  const watchlistItems = await prisma.watchlistItem.count({ where: { competitorId: account.id } });
  // 采集台账指向被删账号：无外键 → 不会级联，删在前面（删完档案就再也查不到 targetId 了）
  const { count: runs } = await prisma.collectionRun.deleteMany({
    where: { scope: 'rival', targetId: account.id },
  });
  // 【AI 引用回执要在删作品**之前**清】它按 (platform, platformItemId) 指向这些作品；
  // 作品一删（级联），就再也查不出「哪些回执指向了它」，那些行会永远留在库里，
  // 而它们存的正是这个账号的作品标题与链接——属于承诺要移除的相关信息。
  const itemIds = (await prisma.crawledPost.findMany({
    where: { competitorId: account.id },
    select: { platformItemId: true },
  })).map((p) => p.platformItemId).filter((x): x is string => !!x);
  const aiCitations = itemIds.length === 0 ? 0 : (await prisma.aiCitation.deleteMany({
    where: { platform, platformItemId: { in: itemIds } },
  })).count;

  // 其余级联由 schema 保证（CrawledPost.competitor / WatchlistItem.competitor 均 onDelete: Cascade）
  await prisma.competitorAccount.delete({ where: { id: account.id } });
  return {
    accounts: 1, posts, watchlistItems, runs, commentQuestions, readerComments,
    scrapeRecords: 0, scrapeRecipes: 0, aiCitations, clips: 0,
  };
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

  // 评论者本人那类：只删他写的那一句，**不碰**作品作者的档案、作品、订阅与台账。
  if (req.kind === COMMENT_KIND) {
    const { readerComments } = await purgeOneComment(req.platform, req.commentText ?? '');
    return {
      ok: true,
      purged: {
        accounts: 0, posts: 0, watchlistItems: 0, runs: 0, commentQuestions: 0, readerComments,
        scrapeRecords: 0, scrapeRecipes: 0, aiCitations: 0, clips: 0,
      },
    };
  }

  // 站点权利人那类：停这个域名、删它下面的采集记录，**不碰**任何平台账号档案。
  if (req.kind === SITE_KIND) {
    const r = await purgeRemovedSiteData(req.handle);
    return {
      ok: true,
      purged: {
        accounts: 0, posts: 0, watchlistItems: 0, runs: 0, commentQuestions: 0, readerComments: 0,
        scrapeRecords: r.records, scrapeRecipes: r.recipes, aiCitations: 0, clips: r.clips,
      },
    };
  }

  const purged = await purgeRemovedAccountData(req.platform, req.handle);
  return { ok: true, purged };
}
