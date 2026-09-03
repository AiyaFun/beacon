import { z } from 'zod';
import { prisma } from '../db';
import { toJson, parseJson, type Metrics } from '../json';
import { learnFromPerformance } from '../insight/learn';
import { evaluateAndAlert } from '../insight/alert';
import { PLATFORMS } from '../constants';
import { recordCollectionRun } from './collection-run';
// 复用竞对回传的同一套令牌鉴权（同一个 Workspace.ingestToken、同一个 header）
export { INGEST_TOKEN_HEADER, workspaceByIngestToken } from './competitor';

// 插件回传「**自有作品**」表现数据 → 写进数据看板域（PublishRecord / PerformanceSnapshot）。
// 与竞对回传（lib/ingest/competitor.ts → CrawledPost）并行的另一条 authorized 通道：
// 同一个采集令牌鉴权，但落到账号维度的自有发布记录，让效果追踪不必只靠手动回填。
//
// 单篇采集器（extension/content/bili-video.js 等）已产出 {platformItemId, url, metrics}，
// 与 lib/publish/parse-url.ts 的 platformItemId 同口径，天然可按 platformItemId 对齐已登记的发布记录。

// 计数型指标（整数）。completion 是**率**，不在此列——见下方 readRate。
const METRIC_KEYS = ['views', 'likes', 'comments', 'shares', 'collects', 'danmaku', 'coins', 'impressions'] as const;

// 完播/完读率：0-1 的比率，绝不能走 Math.floor（0.42 会被抹成 0，等于静默丢数据）。
// 也接受 0-100 的百分数并自动折算——各家创作者后台给的形态不一（有的 "42.3%"、有的 0.423），
// 插件那边已尽量归一，这里再兜一层：>1 一律当百分数。
//
// 这条通道此前**根本不收 completion**：METRIC_KEYS 里没有它，插件就算读到也被静默丢掉。
// 而 completion 恰恰是 lib/algorithm/coach.ts 里抖音/公众号/B站/YouTube/视频号的**第一信号**，
// 公开作品页又拿不到它——这正是「诊断永远说样本不足」的根因。
function readRate(raw: unknown): number | undefined {
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return undefined;
  if (v > 100) return undefined; // 既不是比率也不是百分数，判为脏数据，宁可不要
  const rate = v > 1 ? v / 100 : v;
  return Math.min(1, Math.round(rate * 10000) / 10000);
}

// 流量来源分布：{来源名: 占比}。只有创作者后台给得到，是小红书「搜索流量占比」这类
// 「无法从播放数反推」的结论的唯一数据来源。
// 归一化到 0-1；键名做长度与数量上限（后台改版可能冒出奇怪的键，不能让它无限撑大 JSON）。
const MAX_SOURCE_KEYS = 12;
function readSources(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const name = String(k).trim().slice(0, 20);
    if (!name) continue;
    const rate = readRate(v);
    if (rate === undefined) continue;
    out[name] = rate;
    if (Object.keys(out).length >= MAX_SOURCE_KEYS) break;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// 严格计数读取：只认真正的数字或非空数字字符串。
// ⚠️ 不能直接 Number(raw[k])——Number(null)/Number('')/Number([])/Number(false) 全是 0，
// 且 0 能通过 isFinite && >=0，于是 {"views": null} 会被当成「本次采到 0 播放」，
// 再经 applyMetrics 的 {...prev, ...metrics} 合并，把库里真实的播放量**覆盖成 0**。
// /api/ingest/self 是公开的 token 鉴权端点，收到任意 JSON 都要挡住这条路。
function readCount(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return undefined;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
  }
  return undefined; // null / undefined / boolean / array / object 一律不接受
}

const metricsSchema = z.record(z.string(), z.unknown()).transform((raw) => {
  const out: Record<string, unknown> = {};
  for (const k of METRIC_KEYS) {
    const n = readCount(raw[k]);
    if (n !== undefined) out[k] = n;
  }
  const completion = readRate(raw.completion);
  if (completion !== undefined) out.completion = completion;
  const sources = readSources(raw.sources);
  if (sources !== undefined) out.sources = sources;
  return out as Metrics;
});

const toDate = (v: string | number | undefined): Date | undefined => {
  if (v === undefined) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isFinite(n) && String(v).trim() !== '') {
    const ms = n > 1e12 ? n : n * 1000; // 允许秒或毫秒
    const d = new Date(ms);
    return isNaN(d.getTime()) ? undefined : d;
  }
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? undefined : d;
};

const postSchema = z.object({
  platformItemId: z.string().min(1).max(128),
  title: z.string().max(300).optional(),
  url: z.string().url().max(500).optional(),
  publishedAt: z.union([z.string(), z.number()]).optional().transform(toDate),
  metrics: metricsSchema.optional(),
});

export const ownPostIngestSchema = z.object({
  platform: z.string().refine((p) => p in PLATFORMS, { message: '未知平台' }),
  handle: z.string().max(128).optional(), // 可选：作者主页标识，仅记日志，不参与归属
  // 插件里绑定的账号。给了就**只认它**，不再按平台猜（见 pickAccountFor 上方那段）。
  accountId: z.string().max(64).optional(),
  // 这批数据从哪采的，只进采集台账（lib/ingest/collection-run.ts），不参与任何归属判断。
  // 老版本插件不带这个字段 → 按「作品页单篇采集」计，那是它当时唯一的能力。
  channel: z.enum(['plugin_home', 'plugin_backend', 'local_browser', 'desktop']).optional(),
  posts: z.array(postSchema).min(1).max(50),
});

export type OwnPostIngestPayload = z.infer<typeof ownPostIngestSchema>;

export type OwnIngestResult =
  // targetAccount：这一批数据**记在了谁名下**。必须回给插件——数据看板每一页都按 accountId
  // 过滤，挂到哪个号上决定了用户能不能看见它。只报一句「已回填 N 条」而不说去向，
  // 用户在看板上找不到时就完全无从判断（2026-07-25 / 07-27 两次真机事故都卡在这儿）。
  | { ok: true; updated: number; created: number; skipped: number; moved?: number; targetAccount?: { id: string; name: string } }
  | { ok: false; error: string; code: 'no_account' | 'no_account_for_platform' };

// 采集器写进来过的**页面噪音标题**。真机 2026-07-25 入库的 9 条公众号记录，标题全是同一句
// 「已开启通知，内容已在公众号列表和公众号主页展示已通知3人失败0人…」——那是群发的通知状态块。
// 采集端已经修好不再抓它了（见 self-backend.js beaconPickTitle），但**存量那几条永远修不回来**：
// 下面的规则是「只在标题空着时才补」，而它们并不空，只是空得更难看。
// 所以这里开一个窄口子：既有标题命中这些特征时，允许用新采到的标题覆盖。
// 只列真实见过的噪音形态，不做「看起来不像标题」这种泛化判断——那会误伤用户手写的短标题。
const NOISE_TITLE = /已通知\s*\d+\s*人|通知范围|已开启通知|查看历史版本|^\s*(?:阅读|在看|点赞|分享|评论|留言|送达)\s*\d/;

/** 更新一条已登记发布记录：合并 metrics（不丢采集器没抓到的字段）+ 落 plugin 来源快照 + 触发学习。 */
async function applyMetrics(
  accountId: string, workspaceId: string, recordId: string, prevRaw: string, metrics: Metrics,
  fix?: { title?: string; existingTitle?: string | null; publishedAt?: Date; existingPublishedAt?: Date },
): Promise<void> {
  const merged: Metrics = { ...parseJson<Metrics>(prevRaw, {}), ...metrics };
  // 标题只在库里**本来就空着**、或存的是已知页面噪音时才写。
  // 采集器抓到的标题不一定比用户手写的准，所以绝不覆盖一个正常的既有标题。
  const title = fix?.title?.trim();
  const existingTitle = fix?.existingTitle?.trim();
  const fillTitle = title && (!existingTitle || NOISE_TITLE.test(existingTitle)) ? { title } : {};
  // 发布时间只往**更早**改，绝不改晚。插件此前从不回传 publishedAt，于是每条自动建的记录
  // 都被填成「回填当天」——发布时段分析（analyzePublishTiming）按小时分组，全是回填那一刻的时辰；
  // 趋势图的「发布后第 N 天」也跟着全错。现在采集端能从后台页读到真实发表时间了，
  // 就用它把这些记录纠回去。单向（只前移）保证收敛，也不会被某次误读推到未来。
  //
  // 【2026-08-30 补：库里本来就没有时也要补上】原来的条件要求 existingPublishedAt 为真，
  // 而自从「采不到就存 null」之后，**最该补的那种情形反而不满足条件**——
  // 库里没有发布时间、这次回传学到了，正是自愈要做的事。
  // 判据变成：这次带了时间，且（库里没有 ‖ 这次的更早）。仍然只前移，不改晚。
  const fillDate =
    fix?.publishedAt && (!fix.existingPublishedAt || fix.publishedAt < fix.existingPublishedAt)
      ? { publishedAt: fix.publishedAt }
      : {};
  await prisma.publishRecord.update({ where: { id: recordId }, data: { metrics: toJson(merged), ...fillTitle, ...fillDate } });
  await prisma.performanceSnapshot.create({ data: { publishId: recordId, metrics: toJson(merged), source: 'plugin' } });
  await learnFromPerformance(accountId, workspaceId, recordId).catch(() => {});
  await evaluateAndAlert(accountId, workspaceId, recordId); // 爆款/异常预警（默认关，自兜底）
}

/**
 * 入库自有作品数据。按 platformItemId 在**本工作区各账号**内对齐已登记记录：
 *   命中 → 合并更新 metrics + plugin 快照 + 学习；
 *   未命中 → 归属**同平台**账号建档再回填
 *            （插件回填是用户在自己作品页显式点击，允许建档；不像自动抓取那样怕误建）。
 * 无任何 metrics 的 post 直接跳过（采集器没抓到数，不建空记录污染基线）。
 *
 * ⚠️ 归属必须按平台选账号，绝不能「取第一个活跃账号」了事。
 * 真机 2026-07-25：用户从公众号后台回填成功，但数据看板上什么都看不到——
 * 因为记录被挂到了工作区里最早创建的那个账号（抖音）上，而每个数据页都是
 * `where: { accountId: 当前选中账号 }`，于是 wechat 的数据落在 douyin 账号名下，
 * 哪个页面都不显示；更糟的是它还会带着另一个平台的数字去污染那个账号的基线与学习信号。
 * 找不到同平台账号时**宁可报错让用户先建账号**，也不挂到不相干的账号上。
 */
function pickAccountFor(
  platform: string,
  accounts: { id: string; status: string; platform: string }[],
): string | null {
  const active = accounts.filter((a) => a.status === 'active');
  // 顺序即优先级：同平台活跃 → 同平台任意 → multi 活跃 → multi 任意
  return (
    active.find((a) => a.platform === platform)?.id ??
    accounts.find((a) => a.platform === platform)?.id ??
    active.find((a) => a.platform === 'multi')?.id ??
    accounts.find((a) => a.platform === 'multi')?.id ??
    null
  );
}

const platformLabel = (p: string) => PLATFORMS[p as keyof typeof PLATFORMS]?.name ?? p;

/**
 * 插件里绑定的账号优先。
 *
 * pickAccountFor 是**猜**：同平台第一个活跃账号。一个工作区经营两个抖音号时，它必然猜错一半——
 * 而挂错账号的后果不是「显示得不对」，是数据看板上彻底看不见 + 污染另一个号的基线与学习信号
 * （2026-07-25 真机事故，见上方注释）。所以插件侧提供了账号绑定：绑了就**只认绑的那个**。
 *
 * 平台对不上时**报错，不回退去猜**：用户绑的是「抖音·A号」却在 X 上点了回填，
 * 这时任何一种自动选择都可能是错的，而错了要到数据看板上才发现。宁可让他先切换账号。
 */
export function resolveTargetAccount(
  payload: { platform: string; accountId?: string },
  accounts: { id: string; status: string; platform: string; name: string }[],
): { ok: true; id: string } | { ok: false; error: string; code: 'no_account' | 'no_account_for_platform' } {
  if (payload.accountId) {
    const bound = accounts.find((a) => a.id === payload.accountId);
    if (!bound) {
      return {
        ok: false,
        error: '插件里绑定的账号不在这个工作区（可能已被删除或换了工作区）——请到插件里重新选择要回填的账号',
        code: 'no_account',
      };
    }
    // multi 账号是「一人多平台」的合法归属，不算对不上
    if (bound.platform !== payload.platform && bound.platform !== 'multi') {
      return {
        ok: false,
        error:
          `插件里绑定的是「${platformLabel(bound.platform)} · ${bound.name}」，`
          + `但这一页是「${platformLabel(payload.platform)}」的数据。`
          + '数据看板按账号分开看，挂错账号你在页面上就再也找不到它了——请先在插件里切到对应账号再回填。',
        code: 'no_account_for_platform',
      };
    }
    return { ok: true, id: bound.id };
  }
  const guessed = pickAccountFor(payload.platform, accounts);
  if (!guessed) {
    return {
      ok: false,
      error: `工作区里还没有「${platformLabel(payload.platform)}」账号，先建一个再回填（数据看板按账号分开看，挂到别的平台账号上你就看不到了）`,
      code: 'no_account_for_platform',
    };
  }
  return { ok: true, id: guessed };
}

export async function ingestOwnPostData(workspaceId: string, payload: OwnPostIngestPayload): Promise<OwnIngestResult> {
  const accounts = await prisma.creatorAccount.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, status: true, platform: true, name: true },
  });
  if (accounts.length === 0) return { ok: false, error: '工作区还没有创作账号，无法回填', code: 'no_account' };
  const accountIds = accounts.map((a) => a.id);
  const target = resolveTargetAccount(payload, accounts);
  if (!target.ok) return { ok: false, error: target.error, code: target.code };
  const targetAccountId = target.id;
  const byId = new Map(accounts.map((a) => [a.id, a]));

  let updated = 0;
  let created = 0;
  let skipped = 0;
  let moved = 0;

  // ── 一次查回这一批已登记的作品（2026-08-29）──
  // 与竞对回传那条同一个改法：原来每条作品 findFirst 一次，而这条路同样**在用户请求路径上**。
  // 查一次拿齐，写的部分保持原样（每条的 metrics 合并逻辑都不同，合不成一条语句）。
  const existingRecords = await prisma.publishRecord.findMany({
    where: {
      platformItemId: { in: payload.posts.map((p) => p.platformItemId) },
      accountId: { in: accountIds },
    },
    select: { id: true, accountId: true, metrics: true, platform: true, title: true, publishedAt: true, platformItemId: true },
  });
  // 同一个 platformItemId 在本工作区理论上只有一条；真有多条时取第一条，
  // 与原来的 findFirst 行为一致（不换语义，只换查法）
  const existingByItemId = new Map<string, (typeof existingRecords)[number]>();
  for (const r of existingRecords) {
    if (r.platformItemId && !existingByItemId.has(r.platformItemId)) existingByItemId.set(r.platformItemId, r);
  }

  for (const post of payload.posts) {
    const metrics: Metrics = post.metrics ?? {};
    if (Object.keys(metrics).length === 0) {
      skipped++;
      continue;
    }
    // 已登记？（跨本工作区账号，按 platformItemId 唯一对齐）
    const existing = existingByItemId.get(post.platformItemId) ?? null;
    if (existing) {
      // 修正历史误挂：之前的版本会把记录挂到「第一个活跃账号」上，平台可能完全对不上。
      // 只有在**记录自己的 platform 与本次回传一致、而它所在账号的平台不一致**时才搬——
      // 这是纠正明确的错归属，不是猜。搬完用户在对应账号下立刻就能看到历史数据。
      const holder = byId.get(existing.accountId);
      let ownerId = existing.accountId;
      if (existing.platform === payload.platform && holder && holder.platform !== payload.platform
        && byId.get(targetAccountId)?.platform === payload.platform) {
        await prisma.publishRecord.update({ where: { id: existing.id }, data: { accountId: targetAccountId } });
        ownerId = targetAccountId;
        moved++;
      }
      await applyMetrics(ownerId, workspaceId, existing.id, existing.metrics, metrics, {
        title: post.title,
        existingTitle: existing.title,
        publishedAt: post.publishedAt,
        // existing.publishedAt 可空（采不到就如实留空）。applyMetrics 用 undefined 表示
        // 「这次没带」，两者语义一致，都表示「没有可用来前移的时间」
        existingPublishedAt: existing.publishedAt ?? undefined,
      });
      updated++;
    } else {
      const rec = await prisma.publishRecord.create({
        data: {
          accountId: targetAccountId,
          platform: payload.platform,
          platformItemId: post.platformItemId,
          title: post.title ?? null,
          needsBackfill: false,
          fromRecommend: false,
          // 【采不到就存 null，绝不拿回填时间冒充】小红书笔记页、B站视频页、
          // YouTube 播放页的解析器结构上就不产出这个字段，而「这是我的作品」按钮
          // 在这几个页面上都是露出的——这是常态不是边角。
          // 原来这里是 `?? new Date()`，与 12 行之下台账那句
          //「回填时间不能冒充发布时间，那正是 0.4.7 之前所犯的错」直接矛盾。
          publishedAt: post.publishedAt ?? null,
          metrics: toJson(metrics),
        },
      });
      await prisma.performanceSnapshot.create({ data: { publishId: rec.id, metrics: toJson(metrics), source: 'plugin' } });
      await learnFromPerformance(targetAccountId, workspaceId, rec.id).catch(() => {});
      created++;
    }
  }

  const landed = byId.get(targetAccountId);

  // 台账：这批回填覆盖到哪几天的作品。
  // 覆盖区间按**发布时间**算，取不到发布时间的条目不参与——回填时间不能冒充发布时间，
  // 那正是 0.4.7 之前把发布时间写成回填当天所犯的错。
  await recordCollectionRun({
    workspaceId,
    scope: 'self',
    platform: payload.platform,
    targetId: targetAccountId,
    targetName: landed?.name ?? '(已删除账号)',
    channel: payload.channel ?? 'plugin_home',
    dates: payload.posts.map((p) => p.publishedAt ?? null),
    items: payload.posts.length,
    created,
    updated,
    note: skipped > 0 ? `${skipped} 条没有任何指标，已跳过` : null,
  });

  return {
    ok: true, updated, created, skipped,
    ...(moved > 0 ? { moved } : {}),
    ...(landed ? { targetAccount: { id: landed.id, name: landed.name } } : {}),
  };
}
