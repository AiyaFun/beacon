import { prisma } from '../../db';
import { platformName, sourceBrandName, HOT_SOURCES } from '../../constants';
import { platformWindowHours } from '../../hot/lifecycle';
import { isSensitiveTitle } from '../../hot/sensitive';
import { textShingles, type Candidate } from '../scoring';
import type { PersonaCard } from '../../persona';

// 候选源：跨平台时间差雷达（抢跑窗口）。
//
// 【为什么这个源只有烽火台做得了】跨源聚类（TopicCluster）已经知道「同一件事在哪几个平台上了榜、
// 各自第一次出现是几点」。那么「微博和知乎已经爆了 5 小时、抖音还没有」就是一个可计算的事实——
// 不是预测，是观测。竞品只监控单平台或只做榜单聚合，拿不到这个差值。
//
// 【纯规则，零 LLM】整条链路只有查库和减法，成本恒等于 0，不进精排也能独立成立
// （精排仍会对入选的抢跑候选打分，但那笔钱本来就要花在 topN 上）。
//
// ─────────────────────── 「尚未上榜」怎么才算数 ───────────────────────
// 这个源的全部价值在于断言「你的主战平台还没有」。断言错了比不推更糟，所以只在能观测时才产出：
//
//   A) 主战平台本身有热榜源（抖音/B站/YouTube）→ 直接查 HotItem，最硬的证据。
//   B) 主战平台没有热榜源（小红书/公众号/视频号/X）但订阅了足够多的该平台竞对
//      → 用「监控的 N 个同行里没人做」代替，并在证据里如实写明这是抽样口径。
//   C) 两者都没有 → **不产出**。宁可这个源对该账号沉默，也不能拿「我没看见」当「它不存在」。
//
// 这条纪律的代价是真实的：一个只发小红书、又没订阅竞对的新用户，这个源对他完全不工作。
// 那是数据可得性的事实，解法是引导他加竞对，不是把话说满。

// 有公开热榜数据源的平台（= 可直接观测「上没上榜」）
const HOT_SOURCE_KEYS = new Set<string>(HOT_SOURCES.map((s) => s.key));

// 该平台能否直接用热榜观测「上没上榜」（口径 A）。
// 导出给就绪度引导用（lib/topic/readiness.ts）——引导要告诉用户「这个源为什么对你沉默」，
// 那个判断必须与这里**同一份**依据，否则清单会和实际行为漂移，变成一个会撒谎的进度条。
export function isHotlistObservable(platform: string): boolean {
  return HOT_SOURCE_KEYS.has(platform);
}

// 抢跑窗口上限：话题跨平台扩散超过这么久还没到你的平台，多半是平台调性不合（不是机会），
// 或者已经晚了。24h 是热点在主流平台完成跨平台扩散的经验上限。
const MAX_LEAD_HOURS = 24;
// 至少已在这么多个平台上榜才算「正在扩散」——单平台上榜可能只是该平台的算法偶然。
export const MIN_SPREAD_SOURCES = 2;
// 竞对抽样口径(B)的最低样本量：少于这个数说「同行都没做」没有说服力。
export const MIN_COMPETITOR_SAMPLE = 3;
// 竞对样本的观察窗口
const COMPETITOR_WINDOW_HOURS = 72;
// 与全站一致的「相关」判据：共享 ≥2 个中文 2-gram（同 saturation.ts / cantDo 硬过滤）
const MIN_OVERLAP = 2;

function isRelated(aGrams: Set<string>, b: string): boolean {
  const bGrams = textShingles(b);
  let overlap = 0;
  for (const g of aGrams) {
    if (bGrams.has(g)) {
      overlap++;
      if (overlap >= MIN_OVERLAP) return true;
    }
  }
  return false;
}

export type GapObservation = 'hotlist' | 'competitor-sample';

export type GapFinding = {
  clusterTitle: string;
  clusterId: string;
  platform: string; // 账号主战平台（尚未覆盖到的那个）
  spreadSources: string[]; // 已上榜的源
  leadHours: number; // 已扩散多久
  remainingHours: number; // 估算剩余抢跑窗口
  heat: number; // 簇热度（原始值）
  observation: GapObservation;
  sampleSize?: number; // observation=competitor-sample 时的样本量
};

// 纯函数：把一次观测结果写成给人看的证据句 + 窗口提示。
// 抽出来是为了让文案可被单测钉死——这两句会原样进 LLM prompt 并展示给用户，措辞即契约。
export function describeGap(f: GapFinding): { evidence: string; windowHint: string } {
  // 榜单源必须走 sourceBrandName：微博/知乎/百度/头条不在 PLATFORMS 里，platformName 会吐英文 key
  const spread = f.spreadSources.map(sourceBrandName).join('、');
  const target = platformName(f.platform);
  const base = `该话题已在 ${spread} 共 ${f.spreadSources.length} 个平台上榜，最早 ${f.leadHours} 小时前出现`;
  const evidence =
    f.observation === 'hotlist'
      ? `${base}；${target}热榜此刻仍无同题词条。`
      : `${base}；本工作区监控的 ${f.sampleSize} 条${target}竞对近期作品中无人做同题（抽样口径，非全平台）。`;
  const windowHint = `${target}抢跑窗口约剩 ${f.remainingHours} 小时`;
  return { evidence, windowHint };
}

// 找出「已跨平台扩散、但还没到账号主战平台」的话题。
// 与 generateRecommendations 的候选池是并列关系：那边喂的是「已经在榜的」，这边喂的是「即将到你这」。
export async function findGaps(input: {
  workspaceId: string;
  persona: PersonaCard;
  limit?: number;
  now?: Date;
}): Promise<GapFinding[]> {
  const now = input.now ?? new Date();
  const platforms = (input.persona.platforms ?? []).filter(Boolean);
  if (platforms.length === 0) return []; // 没填主战平台就无从谈「还没到你这」

  const clusters = await prisma.topicCluster.findMany({
    where: { isSensitive: false },
    include: { hotItems: { select: { source: true, firstSeenAt: true, title: true, heat: true } } },
    orderBy: { heat: 'desc' },
    take: 30,
  });
  if (clusters.length === 0) return [];

  // 竞对抽样口径(B)所需的样本：按平台分组的近期竞对作品标题。
  // 一次取全、内存分组——按平台逐个查会在 N 个主战平台上打 N 次库。
  const since = new Date(now.getTime() - COMPETITOR_WINDOW_HOURS * 3_600_000);
  const watch = await prisma.watchlistItem.findMany({
    where: { workspaceId: input.workspaceId },
    select: { competitorId: true },
  });
  const samples = new Map<string, string[]>();
  if (watch.length > 0) {
    const posts = await prisma.crawledPost.findMany({
      where: {
        competitorId: { in: watch.map((w) => w.competitorId) },
        OR: [{ publishedAt: { gte: since } }, { publishedAt: null, crawledAt: { gte: since } }],
      },
      select: { platform: true, title: true },
    });
    for (const p of posts) {
      const list = samples.get(p.platform);
      if (list) list.push(p.title);
      else samples.set(p.platform, [p.title]);
    }
  }

  const findings: GapFinding[] = [];
  for (const cluster of clusters) {
    if (cluster.hotItems.length === 0) continue;
    // 条目级敏感兜底：与 pipeline 候选池同一道双闸，别让敏感话题从这个新入口绕进推荐。
    if (isSensitiveTitle(cluster.title)) continue;

    const spreadSources = [...new Set(cluster.hotItems.map((h) => h.source))];
    if (spreadSources.length < MIN_SPREAD_SOURCES) continue;

    const firstAt = Math.min(...cluster.hotItems.map((h) => h.firstSeenAt.getTime()));
    const leadHours = Math.floor((now.getTime() - firstAt) / 3_600_000);
    if (leadHours < 0 || leadHours > MAX_LEAD_HOURS) continue;

    const grams = textShingles(cluster.title);

    for (const platform of platforms) {
      if (spreadSources.includes(platform)) continue; // 已经上了你的平台，没有抢跑可言

      let observation: GapObservation;
      let sampleSize: number | undefined;
      if (HOT_SOURCE_KEYS.has(platform)) {
        observation = 'hotlist'; // 上面已确认该平台不在 spreadSources 里 = 热榜没有
      } else {
        const sample = samples.get(platform) ?? [];
        if (sample.length < MIN_COMPETITOR_SAMPLE) continue; // 口径 C：不可观测，闭嘴
        if (sample.some((t) => isRelated(grams, t))) continue; // 同行已经在做了，不是空档
        observation = 'competitor-sample';
        sampleSize = sample.length;
      }

      const remainingHours = Math.max(1, Math.round(platformWindowHours(platform) * 0.5 - leadHours));
      findings.push({
        clusterTitle: cluster.title,
        clusterId: cluster.id,
        platform,
        spreadSources,
        leadHours,
        remainingHours,
        heat: cluster.heat,
        observation,
        sampleSize,
      });
    }
  }

  // 扩散广、发现得早的排前面：平台数是「这事真的在火」的强度，leadHours 小是「你还来得及」。
  findings.sort((a, b) => b.spreadSources.length - a.spreadSources.length || a.leadHours - b.leadHours);
  return findings.slice(0, input.limit ?? 6);
}

// 转成候选（统一进主漏斗：硬过滤 → 粗排 → 精排，不另起一套管线）。
// maxHeat 用主候选池的口径传进来做归一化，保证抢跑候选与热榜候选的 heat 在同一把尺上可比。
export async function gapCandidates(input: {
  workspaceId: string;
  persona: PersonaCard;
  maxHeat: number;
  limit?: number;
  now?: Date;
}): Promise<Candidate[]> {
  const findings = await findGaps(input);
  const denom = Math.max(1, input.maxHeat);
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const f of findings) {
    // 同一话题在多个主战平台都有空档时只出一条：推荐位是稀缺资源，
    // 同题刷屏对用户是噪声（多平台分发是创作工坊的事，不该在选题阶段拆成 N 条）。
    if (seen.has(f.clusterTitle)) continue;
    seen.add(f.clusterTitle);
    const { evidence, windowHint } = describeGap(f);
    out.push({
      title: f.clusterTitle,
      heat: Math.min(1, f.heat / denom),
      sourceType: 'gap',
      sourceRef: f.clusterId,
      platform: f.platform,
      lifecycle: 'rising',
      queue: 'today', // 抢跑本质就是限时，不进今日队列就失去意义
      evidence,
      windowHint,
    });
  }
  return out;
}
