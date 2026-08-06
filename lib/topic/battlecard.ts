import { prisma } from '../db';
import { parseJson, type Metrics } from '../json';
import { platformName, PLATFORMS } from '../constants';
import { readPersona } from '../persona';
import { analyzePublishTiming } from '../insight/timing';
import { textShingles } from './scoring';

// 选题作战卡：把一条推荐从「标题 + 分数」变成「拿了就能开工」。
//
// 【一条硬纪律：作战卡里只放事实，不放预测】
// 最初想做的是「预期播放区间」——拿账号均播乘以 LLM 给的流量潜力分，估一个数出来。
// 那个数会给人很强的精确感，但它没有任何统计依据：均播是实测的，流量分是模型的主观判断，
// 两者相乘得到的是**一个看起来像数据的猜测**。这正是本项目反复要避掉的东西。
// 所以改成给**锚点**：你在这个平台的真实均播是多少、最好的一条跑到多少。
// 用户看着自己的真实水位自己判断，比看一个编出来的区间有用得多。
//
// 四块，全部来自查库：
//   references 参考样本  —— 订阅竞对里做过同题的作品（别人怎么做的）
//   bestSlot   发布时机  —— 你自己的历史最佳时段（analyzePublishTiming，样本不足就不说）
//   rivals     竞争密度  —— 近 72h 有几条同题竞对作品
//   benchmark  表现锚点  —— 你在主力平台的真实均播与最好成绩
// 任何一块拿不到数据就整块缺席，绝不填占位值。

// 参考样本回溯窗口：比饱和度的 72h 长得多——「谁做过这个题」是找参照，
// 一个月前的爆款照样有参考价值；而「这题现在挤不挤」才需要看最近三天。
const REFERENCE_WINDOW_DAYS = 30;
const RIVAL_WINDOW_HOURS = 72;
const MAX_REFERENCES = 3;
// 与全站一致的「同题」判据：共享 ≥2 个中文 2-gram
const MIN_OVERLAP = 2;

export type BattleReference = { title: string; url: string | null; views: number; platform: string };
export type BattleSlot = { label: string; avgViews: number; sample: number };
export type BattleBenchmark = { platform: string; avgViews: number; bestViews: number; sample: number };

export type BattleCard = {
  references: BattleReference[];
  bestSlot: BattleSlot | null;
  rivals: number;
  benchmark: BattleBenchmark | null;
  // 小成本验证建议（P2）。只在「这条贵 + 你有做不完的历史」同时成立时才给，否则为 null。
  lightTrial: string | null;
};

// ─────────────────── 小成本验证建议 ───────────────────
//
// 想法很朴素：重形态内容（长视频）一旦开工就是几小时起步，做到一半放弃的沉没成本最高。
// 与其赌一把，不如先用图文/短文出一版试水，数据达标再上重形态。
//
// 但**这条建议不能见人就给**——对一个执行力很强的账号说「你可能做不完」是冒犯且没用。
// 所以要求两个信号同时成立：
//   1) 这条选题**确实贵**：六维里的制作成本分低于占位分（LLM 失败时的默认分是 55，
//      门槛卡在 50 以下天然把「没判断」的占位分排除在外，不会拿默认值劝退用户）；
//   2) 这个账号**确实有做不完的历史**：≥2 次「起了初稿长期未完成」（W-4 已在记录，
//      见 lib/insight/learn.ts learnFromAbandonedDrafts）。一次可能是偶然，两次才是模式。
// 任一不成立就闭嘴。

const EXPENSIVE_COST_SCORE = 50;
const MIN_ABANDONED = 2;

// 轻形态平台：图文/文章/短文本。重形态（长短视频）不算。
const LIGHT_KINDS = new Set(['image_text', 'article', 'short_text']);

export function lightPlatformsOf(targetPlatforms: string[]): string[] {
  return targetPlatforms.filter((p) => {
    const kind = (PLATFORMS as Record<string, { kind: string } | undefined>)[p]?.kind;
    return kind !== undefined && LIGHT_KINDS.has(kind);
  });
}

export function lightTrialAdvice(input: {
  costScore: number | null;
  abandonedCount: number;
  lightPlatforms: string[];
}): string | null {
  if (input.costScore === null || input.costScore >= EXPENSIVE_COST_SCORE) return null;
  if (input.abandonedCount < MIN_ABANDONED) return null;
  // 有轻形态平台就说得具体（去哪儿发），没有就只说形态——不编一个他没经营的平台出来
  const where = input.lightPlatforms.length
    ? `先在${input.lightPlatforms.map(platformName).join(' / ')}发一版图文试水`
    : '先用图文或短文形态出一版试水';
  return (
    `这条的制作成本评分只有 ${Math.round(input.costScore)}，而你有 ${input.abandonedCount} 次「起了初稿没做完」的记录。` +
    `建议${where}，数据达标再上重形态——把一次大投入拆成一次小下注。`
  );
}

function related(aGrams: Set<string>, bGrams: Set<string>): boolean {
  let overlap = 0;
  for (const g of aGrams) {
    if (bGrams.has(g)) {
      overlap++;
      if (overlap >= MIN_OVERLAP) return true;
    }
  }
  return false;
}

type RivalPost = { title: string; url: string | null; platform: string; views: number; recent: boolean };

// 纯函数核心：候选标题 × 竞对作品 → 参考样本 + 竞争密度。
// 抽成纯函数是为了让「什么算同题、参考样本怎么排」能被单测钉死，不必造一堆库数据。
export function matchReferences(title: string, posts: RivalPost[]): { references: BattleReference[]; rivals: number } {
  const grams = textShingles(title);
  const hits = posts.filter((p) => related(grams, textShingles(p.title)));
  return {
    // 参考样本按播放降序：要看就看做得最好的那几条
    references: [...hits]
      .sort((a, b) => b.views - a.views)
      .slice(0, MAX_REFERENCES)
      .map(({ title: t, url, views, platform }) => ({ title: t, url, views, platform })),
    // 竞争密度只数近 72h 的：一个月前有人做过不代表现在挤
    rivals: hits.filter((p) => p.recent).length,
  };
}

// 账号主力平台的真实表现锚点：取发布记录最多的那个平台（那才是他真正在经营的）。
// 无任何带播放的发布记录 → null（新账号不该看到一个凭空的对标数字）。
export function pickBenchmark(records: { platform: string; metrics: string }[]): BattleBenchmark | null {
  const byPlatform = new Map<string, number[]>();
  for (const r of records) {
    const v = parseJson<Metrics>(r.metrics, {}).views ?? 0;
    if (v <= 0) continue;
    const list = byPlatform.get(r.platform);
    if (list) list.push(v);
    else byPlatform.set(r.platform, [v]);
  }
  let best: BattleBenchmark | null = null;
  for (const [platform, views] of byPlatform) {
    const card: BattleBenchmark = {
      platform,
      avgViews: Math.round(views.reduce((a, b) => a + b, 0) / views.length),
      bestViews: Math.max(...views),
      sample: views.length,
    };
    if (!best || card.sample > best.sample) best = card;
  }
  return best;
}

// 批量构造：一次取数、内存里分给每条选题，避免 N 条选题打 N 轮库。
export async function buildBattleCards(
  workspaceId: string,
  accountId: string,
  topics: { id: string; title: string; scores?: string }[],
): Promise<Map<string, BattleCard>> {
  const out = new Map<string, BattleCard>();
  if (topics.length === 0) return out;

  const now = Date.now();
  const refSince = new Date(now - REFERENCE_WINDOW_DAYS * 86_400_000);
  const rivalSince = now - RIVAL_WINDOW_HOURS * 3_600_000;

  const [watch, records, abandonedCount, account] = await Promise.all([
    prisma.watchlistItem.findMany({ where: { workspaceId }, select: { competitorId: true } }),
    prisma.publishRecord.findMany({
      where: { accountId },
      orderBy: { publishedAt: 'desc' },
      take: 100,
      select: { platform: true, metrics: true, publishedAt: true },
    }),
    // W-4 已把「起了初稿长期未完成」标成 abandoned，直接数它，不再另立信号
    prisma.draft.count({ where: { accountId, status: 'abandoned' } }),
    prisma.creatorAccount.findUnique({ where: { id: accountId }, select: { personaCard: true } }),
  ]);
  const lightPlatforms = lightPlatformsOf(readPersona(account?.personaCard ?? '{}').platforms ?? []);

  const rawPosts = watch.length
    ? await prisma.crawledPost.findMany({
        where: {
          competitorId: { in: watch.map((w) => w.competitorId) },
          OR: [{ publishedAt: { gte: refSince } }, { publishedAt: null, crawledAt: { gte: refSince } }],
        },
        select: { title: true, url: true, platform: true, metrics: true, publishedAt: true, crawledAt: true },
        take: 400,
      })
    : [];

  const posts: RivalPost[] = rawPosts.map((p) => ({
    title: p.title,
    url: p.url,
    platform: p.platform,
    views: parseJson<Metrics>(p.metrics, {}).views ?? 0,
    recent: (p.publishedAt ?? p.crawledAt).getTime() >= rivalSince,
  }));

  // 发布时段与表现锚点是账号级的，对所有选题相同——算一次复用。
  const timing = analyzePublishTiming(records.map((r) => ({ publishedAt: r.publishedAt, metrics: r.metrics })));
  const bestSlot: BattleSlot | null = timing.best
    ? { label: timing.best.label, avgViews: timing.best.avgViews, sample: timing.best.sample }
    : null;
  const benchmark = pickBenchmark(records);

  for (const t of topics) {
    const { references, rivals } = matchReferences(t.title, posts);
    const cost = t.scores ? parseJson<Record<string, number>>(t.scores, {}).cost : undefined;
    out.set(t.id, {
      references,
      bestSlot,
      rivals,
      benchmark,
      lightTrial: lightTrialAdvice({
        costScore: typeof cost === 'number' ? cost : null,
        abandonedCount,
        lightPlatforms,
      }),
    });
  }
  return out;
}

// 作战卡是否有任何可展示内容——四块全空时页面直接不渲染这一节，
// 不给用户一个点开发现空空如也的折叠块。
export function hasBattleContent(c: BattleCard | undefined): boolean {
  if (!c) return false;
  return (
    c.references.length > 0 || c.bestSlot !== null || c.rivals > 0 || c.benchmark !== null || c.lightTrial !== null
  );
}

export function formatViews(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(Math.round(n));
}
