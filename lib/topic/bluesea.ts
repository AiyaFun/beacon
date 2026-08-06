import type { Candidate } from './scoring';

// 蓝海度：识别「需求已经被验证、但还没什么人做」的话题。
//
// ─────────────────── 为什么不买搜索指数 ───────────────────
// 教科书式的蓝海分是「需求热度 ÷ 供给密度」，需求侧要用微信指数 / 巨量算数这类官方产品。
// 那条路要么花钱、要么爬（红线不碰）。但停在这里就等于放着已有数据不用——
// 站内其实有**三个真实可观测的需求代理信号**：
//
//   1) 持续性：一个词条在榜上待了多久。瞬时冲榜可能只是算法波动，
//      连续在榜几十小时说明是持续有人在搜、在讨论。
//   2) 扩散广度：同一事件在几个平台同时上榜。跨平台扩散排除了「单平台推荐机制偶然」，
//      是「真需求」比较硬的证据。
//   3) 供给密度：近 72h 有多少条同题竞对作品（saturation.ts 已有）。
//
// 蓝海度 = 需求代理 × (1 − 供给密度)。全部来自站内已有数据，零采购、零爬取。
//
// ⚠️ **它不是搜索指数，措辞上必须如实**：这是「站内可观测的代理信号」，
// 只能说明「这个话题在榜上活得久、扩散得广，而同行还没怎么做」，不能说成「全网搜索需求量」。
// UI 与证据句一律用前一种说法。
//
// ─────────────────── 它怎么用：修正倒U，而不是再加一个因子 ───────────────────
// 粗排已有一个竞争饱和度的倒U因子——供给太多降分（红海做不出头），供给太少**也**降分。
// 后者的理由是「没人做可能是因为根本没流量」。这个假设在没有需求信号时是对的，
// 但一旦需求被独立验证了（持续在榜 + 多平台扩散），低供给就不再是风险信号，而是纯机会。
// 所以蓝海度的正确用法是**把倒U的最优点往低供给方向推**，而不是叠加第四个权重——
// 叠加会和倒U打架（一个奖励低供给、一个惩罚低供给），最终谁也说不清分是怎么来的。

// 需求代理满分线
const PERSIST_FULL_HOURS = 48; // 在榜 48 小时算「持续性拉满」
const SPREAD_FULL_SOURCES = 4; // 4 个平台同时上榜算「扩散拉满」
// 持续性与扩散各占一半：只久不广可能是单平台长尾，只广不久可能是一次性事件，两者都要。
const PERSIST_WEIGHT = 0.5;

// 倒U最优点的移动范围：需求代理为 0 时中心是 0.5（原行为逐字不变），拉满时移到 0。
//
// 为什么正好是 0 而不是 0.15：规则是「需求被验证后，低供给不再被惩罚」。
// 停在 0.15 意味着一条「四个平台连烧 40 小时、没人做」的话题**仍带着一点残余扣分**——
// 那就不是「不再惩罚」，而是「少惩罚一点」，和写下来的规则对不上。
// 推到 0 之后语义精确：需求拉满时零供给就是最优点，拿到与任何其它最优点相同的满分，
// 不多不少——**不给加分**（代理信号不配主导排序），**也不留残余罚分**。
const CENTER_BASE = 0.5;
const CENTER_SHIFT = 0.5;

// 「蓝海」徽标的门槛。定得高一些：这个标是给用户看的强信号，
// 满屏都是就等于没有。
export const BLUE_SEA_BADGE = 0.55;

export type DemandInput = {
  // 该词条/簇在榜上待了多久（小时）。热榜项用 lastSeenAt - firstSeenAt。
  hoursOnList?: number;
  // 同一话题在几个来源上榜（跨源簇的成员源数；单源为 1）
  sourceCount?: number;
};

// 需求代理（0-1）。两项都缺 → 0，即「没有需求证据」，下游行为完全退回原样。
export function demandProxy(input: DemandInput): number {
  const persist = Math.min(1, Math.max(0, input.hoursOnList ?? 0) / PERSIST_FULL_HOURS);
  // 单源上榜的扩散度是 0 而不是 0.25：一个平台不叫「扩散」。
  const spread = Math.min(1, Math.max(0, (input.sourceCount ?? 1) - 1) / (SPREAD_FULL_SOURCES - 1));
  return persist * PERSIST_WEIGHT + spread * (1 - PERSIST_WEIGHT);
}

// 蓝海度（0-1）：需求已验证 × 供给还空着。
export function blueSeaScore(demand: number, saturation: number): number {
  const d = Math.min(1, Math.max(0, demand));
  const s = Math.min(1, Math.max(0, saturation));
  return d * (1 - s);
}

// 倒U的最优供给点：需求越强，最优点越靠近「没人做」。
export function saturationCenter(demand: number): number {
  return CENTER_BASE - CENTER_SHIFT * Math.min(1, Math.max(0, demand));
}

// 给人看的一句话。只描述观测到的事实，不外推成「搜索需求量」。
export function blueSeaEvidence(input: {
  hoursOnList?: number;
  sourceCount?: number;
  rivals: number;
}): string | null {
  const hours = Math.round(input.hoursOnList ?? 0);
  const sources = input.sourceCount ?? 1;
  const parts: string[] = [];
  if (hours >= 12) parts.push(`已连续在榜约 ${hours} 小时`);
  if (sources >= 2) parts.push(`在 ${sources} 个平台同时上榜`);
  if (parts.length === 0) return null;
  const supply =
    input.rivals === 0
      ? '而你监控的竞对里还没人做同题'
      : `而近期只有 ${input.rivals} 条同题竞对作品`;
  return `这个话题${parts.join('、')}，${supply}——需求在、供给还空着。`;
}

// 批量算：候选标题 → 蓝海度。
// demand 表由 pipeline 从热榜项/跨源簇填好传进来；查不到的候选（竞对/自搬运/常青/日历等
// 本来就没有热榜时间线）拿不到需求证据，蓝海度为 0，一切行为退回原样。
export function blueSeaByTitle(
  candidates: Candidate[],
  demandByTitle: Record<string, number>,
  saturation: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of candidates) {
    const d = demandByTitle[c.title] ?? 0;
    if (d <= 0) continue; // 无需求证据就不写这个键，下游按缺省 0 处理
    out[c.title] = blueSeaScore(d, saturation[c.title] ?? 0);
  }
  return out;
}
