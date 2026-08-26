import { prisma } from '../db';
import { parseJson, type Metrics } from '../json';
import { readPersona, type PersonaCard } from '../persona';
import { TOPIC_SOURCE_LABEL, platformName } from '../constants';
import { isHotlistObservable, MIN_COMPETITOR_SAMPLE } from './sources/gap';
import { RECYCLE_MIN_AGE_DAYS, MIN_BASELINE_SAMPLE } from './sources/recycle';
import { nicheWord } from './sources/evergreen';

// 候选源就绪度：告诉用户「八个来源里现在有几个真的在为你工作，剩下的为什么沉默、怎么解锁」。
//
// ─────────────────── 为什么需要这个东西 ───────────────────
// 冷启动实测（2026-07-22）：一个填好人设、但没订阅竞对 / 没历史作品 / 没素材 / 没灵感的新用户，
// 跑完整推荐后**八个候选源只有三个出货**（热榜 + 节点日历 + 常青储备），十条推荐里只有五条带证据链。
// 原因不是 bug，是结构性事实——抢跑窗口、旧文翻新、跨平台补发、竞对、灵感箱**全都依赖用户自己的数据**。
//
// 后果很致命：整个「为什么是你、为什么是现在」的差异化**在第一天完全不可见**，
// 新用户看到的近似一个「热榜 + 万年历」，而那是市面上一抓一大把的东西。
// 他很可能在产生任何数据之前就走了——产品的价值根本没机会自证。
//
// 所以要把「补数据」从一件用户得自己悟出来的事，变成一张明确的、算得出来的解锁清单。
//
// ─────────────────── 一条硬纪律：判定口径必须与候选源本身完全一致 ───────────────────
// 阈值全部从各源**导出的常量**引进来（MIN_COMPETITOR_SAMPLE / RECYCLE_MIN_AGE_DAYS / …），
// 绝不在这里重写一遍数字。原因很实在：一旦两边漂移，这张清单就会告诉用户「已解锁」而实际仍然沉默，
// 那比没有清单更糟——**一个会撒谎的进度条会摧毁用户对整个推荐的信任**。

export type SourceState = 'active' | 'dormant';

export type SourceReadiness = {
  key: string;
  name: string; // 用户看到的来源名（与选题卡上的徽标同名）
  state: SourceState;
  // active：这个源现在能为你产出什么；dormant：为什么沉默
  reason: string;
  // dormant 时的解锁动作（一句人话 + 去哪儿做）
  action?: { text: string; href: string };
};

export type ReadinessReport = {
  sources: SourceReadiness[];
  active: number;
  total: number;
  // 是否处于冷启动（沉默的源多到差异化已经不可见）
  cold: boolean;
};

// 沉默的源多于这个数就算「冷」，页面上把引导展开。
// 定 3 是因为八源里沉默三个以内，用户至少还能同时看到「抢跑/翻新/竞对」中的一类差异化。
const COLD_THRESHOLD = 3;

function label(key: string): string {
  return TOPIC_SOURCE_LABEL[key]?.name ?? key;
}

export type ReadinessInput = {
  persona: PersonaCard;
  competitorCount: number;
  // 各平台近期竞对作品数（gap 口径 B 要看它够不够样本）
  competitorPostsByPlatform: Record<string, number>;
  crossPlatformClusters: number;
  ownWorks: { platform: string; publishedAt: Date; views: number }[];
  materialCount: number;
  inspirationCount: number;
  hotItemCount: number;
};

// 纯函数：把一组事实算成就绪度。抽出来是为了让「什么时候算解锁」能被单测钉死，
// 也让它与候选源的门槛可以放在同一个测试里对拍。
export function computeReadiness(input: ReadinessInput, now: Date = new Date()): ReadinessReport {
  const { persona } = input;
  const platforms = (persona.platforms ?? []).filter(Boolean);
  const niche = nicheWord(persona);
  const sources: SourceReadiness[] = [];

  // 1) 热榜：广播型，全租户共享，唯一会沉默的情况是采集还没跑过
  sources.push(
    input.hotItemCount > 0
      ? { key: 'hot', name: label('hot'), state: 'active', reason: `当前榜上 ${input.hotItemCount} 条词条正在参与筛选` }
      : {
          key: 'hot', name: label('hot'), state: 'dormant',
          reason: '热榜还没采过一轮',
          action: { text: '去热点聚合中心刷新一次', href: '/hotlists' },
        },
  );

  // 2) 竞对
  sources.push(
    input.competitorCount > 0
      ? { key: 'competitor', name: label('competitor'), state: 'active', reason: `已订阅 ${input.competitorCount} 个同行，他们的高热作品会进候选池` }
      : {
          key: 'competitor', name: label('competitor'), state: 'dormant',
          reason: '还没订阅任何同行',
          action: { text: '贴一个同行主页链接就能建档', href: '/competitors' },
        },
  );

  // 3) 抢跑窗口：口径与 gap.ts 完全一致——要有主战平台、要有跨源簇、且该平台可观测
  //    （本身有热榜源，或订阅了足够多的该平台竞对）
  const observable = platforms.filter(
    (p) => isHotlistObservable(p) || (input.competitorPostsByPlatform[p] ?? 0) >= MIN_COMPETITOR_SAMPLE,
  );
  if (platforms.length === 0) {
    sources.push({
      key: 'gap', name: label('gap'), state: 'dormant',
      reason: '人设里还没填主战平台，无从判断「话题还没到你这」',
      action: { text: '去人设卡填上你主要经营的平台', href: '/persona' },
    });
  } else if (observable.length === 0) {
    const names = platforms.map(platformName).join('、');
    sources.push({
      key: 'gap', name: label('gap'), state: 'dormant',
      reason: `${names}没有公开热榜可查，得靠同行样本代替；目前该平台的同行作品不足 ${MIN_COMPETITOR_SAMPLE} 条`,
      action: { text: `多订阅几个${names}同行`, href: '/competitors' },
    });
  } else if (input.crossPlatformClusters === 0) {
    sources.push({
      key: 'gap', name: label('gap'), state: 'dormant',
      reason: '当前没有跨平台扩散中的话题——这个源只在「同一件事在多个平台同时上榜」时才有话说',
      action: { text: '不用做什么，等下一波热点即可', href: '/hotlists' },
    });
  } else {
    sources.push({
      key: 'gap', name: label('gap'), state: 'active',
      reason: `正在盯 ${input.crossPlatformClusters} 个跨平台话题，看哪个还没到${observable.map(platformName).join('、')}`,
    });
  }

  // 4) 旧文翻新：口径与 enrichWithRecycle 一致——要有够老的自有作品
  const agedWorks = input.ownWorks.filter(
    (w) => (now.getTime() - w.publishedAt.getTime()) / 86_400_000 >= RECYCLE_MIN_AGE_DAYS,
  );
  sources.push(
    agedWorks.length > 0
      ? { key: 'recycle', name: label('recycle'), state: 'active', reason: `${agedWorks.length} 条旧作在等话题回温` }
      : {
          key: 'recycle', name: label('recycle'), state: 'dormant',
          reason: `还没有满 ${RECYCLE_MIN_AGE_DAYS} 天的历史作品可供翻新`,
          action: { text: '把你过去发过的内容导入进来', href: '/data' },
        },
  );

  // 5) 跨平台补发：口径与 crossPlatformFindings 一致——≥2 个主战平台 + 某平台样本够算基线
  const byPlatform = new Map<string, number>();
  for (const w of input.ownWorks) {
    if (w.views <= 0) continue;
    byPlatform.set(w.platform, (byPlatform.get(w.platform) ?? 0) + 1);
  }
  const withBaseline = [...byPlatform.entries()].filter(([, n]) => n >= MIN_BASELINE_SAMPLE);
  if (platforms.length < 2) {
    sources.push({
      key: 'crossplat', name: label('crossplat'), state: 'dormant',
      reason: '只经营一个平台，没有可搬运的去处',
      action: { text: '人设里补上你的第二个平台', href: '/persona' },
    });
  } else if (withBaseline.length === 0) {
    sources.push({
      key: 'crossplat', name: label('crossplat'), state: 'dormant',
      reason: `任一平台都还不足 ${MIN_BASELINE_SAMPLE} 条带播放的作品，算不出「哪条跑赢了你自己」`,
      action: { text: '导入历史作品或登记已发布内容', href: '/data' },
    });
  } else {
    sources.push({
      key: 'crossplat', name: label('crossplat'), state: 'active',
      reason: `${withBaseline.map(([p]) => platformName(p)).join('、')}已有基线，能挑出跑赢自己的那几条`,
    });
  }

  // 6) 节点日历：只要有赛道词就能贴身；没有也能出，但退化成通用表述
  sources.push(
    niche
      ? { key: 'calendar', name: label('calendar'), state: 'active', reason: `按「${niche}」代入节点选题` }
      : {
          key: 'calendar', name: label('calendar'), state: 'dormant',
          reason: '人设里没填赛道，节点选题只能给通用表述',
          action: { text: '补一句你的赛道（如「家居收纳」）', href: '/persona' },
        },
  );

  // 7) 常青储备：口径与 evergreen.ts 一致——没有赛道词就整源沉默
  sources.push(
    niche
      ? { key: 'evergreen', name: label('evergreen'), state: 'active', reason: `已按「${niche}」备好常青题库` }
      : {
          key: 'evergreen', name: label('evergreen'), state: 'dormant',
          reason: '没有赛道词就生成不了常青题（不写缺主语的废话选题）',
          action: { text: '补一句你的赛道', href: '/persona' },
        },
  );

  // 8) 灵感箱
  sources.push(
    input.inspirationCount > 0
      ? { key: 'inspiration', name: label('inspiration'), state: 'active', reason: `收集箱里有 ${input.inspirationCount} 条待用` }
      : {
          key: 'inspiration', name: label('inspiration'), state: 'dormant',
          reason: '收集箱是空的',
          action: { text: '存一条刷到的内容，或从评论里挖问题', href: '/topics?view=inspiration' },
        },
  );

  const active = sources.filter((s) => s.state === 'active').length;
  return { sources, active, total: sources.length, cold: sources.length - active >= COLD_THRESHOLD };
}

// 素材库不是候选源，是**给所有来源加证据**的增强项，单独提示。
export function materialHint(materialCount: number): SourceReadiness | null {
  if (materialCount > 0) return null;
  return {
    key: 'material', name: '素材唤醒', state: 'dormant',
    reason: '素材库是空的——热点人人可抄，只有你的亲身经历抄不走',
    action: { text: '记两条你的真实经历或观点', href: '/material' },
  };
}

// 取数入口。全部是 count / 轻量 select，不进 LLM、不发网络。
export async function loadReadiness(workspaceId: string, accountId: string): Promise<ReadinessReport & { material: SourceReadiness | null }> {
  const account = await prisma.creatorAccount.findUnique({
    where: { id: accountId },
    select: { personaCard: true },
  });
  const persona = readPersona(account?.personaCard ?? '{}');

  const since = new Date(Date.now() - 72 * 3_600_000);
  const watch = await prisma.watchlistItem.findMany({ where: { workspaceId }, select: { competitorId: true } });
  const competitorIds = watch.map((w) => w.competitorId);

  const [posts, clusters, records, ownPosts, materialCount, inspirationCount, hotItemCount] = await Promise.all([
    competitorIds.length
      ? prisma.crawledPost.findMany({
          where: {
            competitorId: { in: competitorIds },
            OR: [{ publishedAt: { gte: since } }, { publishedAt: null, crawledAt: { gte: since } }],
          },
          select: { platform: true },
        })
      : Promise.resolve([] as { platform: string }[]),
    // 与 gap.ts 同口径：只数**跨平台**簇（成员来自 ≥2 个源）
    prisma.topicCluster.findMany({
      where: { isSensitive: false },
      select: { hotItems: { select: { source: true } } },
      take: 30,
    }),
    prisma.publishRecord.findMany({
      where: { accountId },
      orderBy: { publishedAt: 'desc' },
      take: 120,
      select: { platform: true, publishedAt: true, metrics: true },
    }),
    prisma.ownPost.findMany({
      where: { accountId, publishedAt: { not: null } },
      orderBy: { publishedAt: 'desc' },
      take: 120,
      select: { platform: true, publishedAt: true, metrics: true },
    }),
    prisma.material.count({ where: { accountId } }),
    prisma.inspirationItem.count({
      where: { workspaceId, state: 'open', OR: [{ accountId: null }, { accountId }] },
    }),
    // 与候选池同口径：示例词条不参与筛选（见 pipeline.ts 的 externalCandidates），
    // 这里也不能把它们数进「正在参与筛选」——否则一个全 Mock 的环境会显示「热榜已就绪」，
    // 而实际上 generateRecommendations 一条热榜候选都拿不到。
    prisma.hotItem.count({ where: { isMock: false } }),
  ]);

  const competitorPostsByPlatform: Record<string, number> = {};
  for (const p of posts) competitorPostsByPlatform[p.platform] = (competitorPostsByPlatform[p.platform] ?? 0) + 1;

  const ownWorks = [
    ...records.map((r) => ({
      platform: r.platform,
      publishedAt: r.publishedAt,
      views: parseJson<Metrics>(r.metrics, {}).views ?? 0,
    })),
    ...ownPosts.map((p) => ({
      platform: p.platform,
      publishedAt: p.publishedAt!,
      views: parseJson<Metrics>(p.metrics, {}).views ?? 0,
    })),
  ];

  const report = computeReadiness({
    persona,
    competitorCount: competitorIds.length,
    competitorPostsByPlatform,
    crossPlatformClusters: clusters.filter((c) => new Set(c.hotItems.map((h) => h.source)).size >= 2).length,
    ownWorks,
    materialCount,
    inspirationCount,
    hotItemCount,
  });

  return { ...report, material: materialHint(materialCount) };
}
