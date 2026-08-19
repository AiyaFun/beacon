import type { Metrics } from '@/lib/json';

// 「这条作品表现如何」的排序口径。**一处定义，各处引用**——此前它散在四五个地方，
// 每处都写成 `hotScore = views / 20000`，于是没有播放量的平台（抖音/小红书/X 的公开页
// 根本不显示播放量）**恒为 0**，而这个 0 会一路往下渗：
//   · 竞对页 orderBy(hotScore) + slice(0,50) → 决定了哪 50 条作品能进榜
//   · 榜的默认排序 → 全 0 等于顺序随机
//   · pipeline 取 top15 竞对作品当选题候选 → 这些平台的作品几乎永远选不上
//   · account-context 告诉 AI「热度 0」
// 和 lib/json.ts 里那条「缺席不许当 0」是同一个病，只是长在排序层，后果更隐蔽。

/**
 * 互动总量 = 赞 + 评 + 藏 + 转，**只累计真的采到的项**。
 * 一项都没采到时返回 null（「不知道」，不是「零互动」）。
 *
 * 【为什么故意不含播放量】播放量的量级比互动量高两三个数量级。把它算进来，
 * 报播放的平台（B站/YouTube）会仅仅因为数字大就永远排在前面，
 * 而这正是原来那套口径的偏斜本身。互动量在每个平台都拿得到（至少有点赞），
 * 是真实观测，不需要发明「1 次播放折算几个赞」这种系数。
 *
 * 【跨平台仍然不完全可比】B站 283 万赞和 X 2000 赞不是一回事。
 * 同类对比靠页面上的平台筛选，这里不做归一化——任何归一化都要引入假设，
 * 而假设会变成一个看起来很确定、其实是编的数字。
 */
export function interactionTotal(m: Metrics): number | null {
  const parts = [m.likes, m.comments, m.collects, m.shares];
  let sum = 0;
  let got = false;
  for (const v of parts) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      sum += v;
      got = true;
    }
  }
  return got ? sum : null;
}

/**
 * 排序用的可比数值。算不出互动量时返回 -1，**排到最后而不是混进「互动最少」那一堆**
 * ——「没采到」和「真的没人互动」在榜上不该长得一样。
 */
export function heatForSort(m: Metrics): number {
  const t = interactionTotal(m);
  return t === null ? -1 : t;
}

/**
 * 把一批作品的互动量归一到 0..1，用于选题候选的 heat 权重。
 *
 * **按批内最大值归一**，不用固定除数：固定除数（原来是 `hotScore / 100`）在
 * 不同平台、不同体量的账号之间完全不可比，小号的作品永远接近 0、大号永远顶格 1。
 * 批内归一至少保证「这批里相对最强的那条 = 1」，这才是候选池要的相对权重。
 */
export function normalizedHeat(list: Metrics[]): number[] {
  const totals = list.map((m) => interactionTotal(m) ?? 0);
  const max = Math.max(1, ...totals);
  return totals.map((t) => Math.min(1, t / max));
}
