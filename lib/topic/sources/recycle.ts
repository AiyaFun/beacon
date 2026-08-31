import { prisma } from '../../db';
import { parseJson, type Metrics } from '../../json';
import { platformName } from '../../constants';
import { isSensitiveTitle } from '../../hot/sensitive';
import { textShingles, type Candidate } from '../scoring';
import type { PersonaCard } from '../../persona';
import { beijingParts } from '../../beijing';

// 候选源：旧文翻新（话题回温）与跨平台自搬运。
//
// 【为什么这是确定性最高的一个源】热榜和竞对给的都是「别人验证过的东西」，而这里给的是
// **你自己的账号验证过的东西**——同一批读者、同一个人设、同一套表达方式下真实跑出来的数据。
// 风险最低、制作成本最低，偏偏此前完全没被选题引擎用上：OwnPost / PublishRecord 躺在库里
// 只服务于「数据看板」和「基线」，从没回头影响过「明天做什么」。
//
// 两个子信号，形态刻意不同：
//
//   A) 话题回温 = **给已有热点候选挂证据，不新增候选**（enrichWithRecycle）。
//      热点本来就在候选池里，再造一条同题的只会让推荐位重复。真正的增量是那句
//      「你 5 个月前做过这个题、当时跑了 3.2 万」——它改变的是这条值不值得做的判断，
//      不是候选池里多一行。sourceType 因此从 hot 改写为 recycle：推荐它的**理由变了**。
//
//   B) 跨平台自搬运 = **真·新候选**（crossPlatformCandidates）。
//      「B站那条 5 万播放的，小红书你根本没发过」——这条内容不在任何热榜上，
//      只有对着自有作品跨平台比对才看得见。这本来就是「跨平台内容作战室」的本职工作。

// 话题回温的最小年龄：太新的不叫翻新，叫重复发。
export const RECYCLE_MIN_AGE_DAYS = 30;
// 自搬运的最小年龄：给数据一点稳定时间，别在发布当天就催人搬运（那时播放还在涨，判断不了是不是爆款）。
const CROSSPLAT_MIN_AGE_DAYS = 3;
// 自搬运只看近半年的作品：更早的内容平台环境已经变了，搬过去未必还成立。
const CROSSPLAT_MAX_AGE_DAYS = 180;
// 「跑赢自己」的判据：达到该平台历史均播放的多少倍才算爆款，值得搬。
const HIT_RATIO = 1.5;
// 算均值所需的最小样本：3 条以下的「均值」不是基线，是噪声，此时一律不下「跑赢」的结论。
export const MIN_BASELINE_SAMPLE = 3;
// 与全站一致的「同题」判据：共享 ≥2 个中文 2-gram（同 saturation.ts / cantDo / gap.ts）
const MIN_OVERLAP = 2;

export type OwnWork = {
  id: string;
  source: 'publish' | 'own'; // PublishRecord（发布回流）| OwnPost（历史作品回溯）
  platform: string;
  title: string;
  publishedAt: Date;
  views: number;
};

export type PlatformBaseline = { mean: number; sample: number };

function related(aGrams: Set<string>, b: string): boolean {
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

function ageDays(d: Date, now: Date): number {
  return (now.getTime() - d.getTime()) / 86_400_000;
}

// 各平台历史均播放。样本不足的平台**不出现在结果里**——调用方据此放弃「跑赢基线」类判断，
// 而不是拿一个 1 条样本的「均值」去比。
export function platformBaselines(works: OwnWork[]): Map<string, PlatformBaseline> {
  const acc = new Map<string, number[]>();
  for (const w of works) {
    if (w.views <= 0) continue; // 0 播放多半是没回流到数据，不是真的没人看，不该拉低均值
    const list = acc.get(w.platform);
    if (list) list.push(w.views);
    else acc.set(w.platform, [w.views]);
  }
  const out = new Map<string, PlatformBaseline>();
  for (const [platform, list] of acc) {
    if (list.length < MIN_BASELINE_SAMPLE) continue;
    out.set(platform, { mean: list.reduce((a, b) => a + b, 0) / list.length, sample: list.length });
  }
  return out;
}

function fmtViews(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(Math.round(n));
}

function fmtDate(d: Date): string {
  const p = beijingParts(d); // 容器跑在 UTC 上，本地月份会在每月 1 日早上八点前说成上个月
  return `${p.year}年${p.month}月`;
}

// 已有明确来源归属、不该被「你做过这个题」覆盖掉的候选类型。
// 其余（= 各热榜源 key）都是可回温的对象。
// **新增延伸候选源时必须往这里加一行**：漏加会让新源的来源标签和证据被回温悄悄改写掉。
const CLAIMED_SOURCE_TYPES = new Set([
  'gap', 'crossplat', 'evergreen', 'calendar', 'inspiration',
  'recycle', 'competitor', 'advisor', 'manual',
  'comment', 'rival-comment',
]);

// ── A) 话题回温：给已有候选挂上「你做过这个题」的证据 ──
//
// 纯函数（无 IO），所以「什么样的旧作算数、证据怎么措辞」可以被单测钉死。
// 只改写命中的候选，其余原样返回；命中多条旧作时取表现最好的那条当证据。
export function enrichWithRecycle(
  candidates: Candidate[],
  works: OwnWork[],
  baselines: Map<string, PlatformBaseline>,
  now: Date = new Date(),
): Candidate[] {
  const aged = works.filter((w) => ageDays(w.publishedAt, now) >= RECYCLE_MIN_AGE_DAYS);
  if (aged.length === 0) return candidates;

  return candidates.map((c) => {
    // 已经被别的源认领的候选不抢：抢跑窗口是更强的时间信号，不该被「你做过」覆盖掉。
    //
    // 注意这里必须是**排除法**：热榜候选的 sourceType 是榜单源 key（douyin/weibo/zhihu…），
    // 不是字面量 'hot'（见 pipeline.ts 候选池构造 `sourceType: h.source`）。
    // 早前写成 `if (c.sourceType !== 'hot') return c` 时，这个源在生产上一条都不会触发。
    if (CLAIMED_SOURCE_TYPES.has(c.sourceType)) return c;
    const grams = textShingles(c.title);
    const hits = aged.filter((w) => related(grams, w.title));
    if (hits.length === 0) return c;

    const best = hits.reduce((a, b) => (b.views > a.views ? b : a));
    const base = baselines.get(best.platform);
    // 「跑赢基线」只在样本够时才说；不够就只陈述发布时间和播放数这两个硬事实。
    const perf =
      base && best.views > 0
        ? `当时 ${fmtViews(best.views)}播放（你在${platformName(best.platform)}近 ${base.sample} 条的均值是 ${fmtViews(base.mean)}）`
        : best.views > 0
          ? `当时 ${fmtViews(best.views)}播放`
          : '当时的数据没回流到系统';
    return {
      ...c,
      sourceType: 'recycle',
      // 回温话题此刻确实在榜上，时间压力跟普通热点一样，队列交给 resolveQueue 按 lifecycle 判。
      evidence: `你在 ${fmtDate(best.publishedAt)} 发过同题的《${best.title}》，${perf}。这个话题现在重新上榜了。`,
      windowHint: hits.length > 1 ? `你做过 ${hits.length} 条相关内容，可整合成合集` : undefined,
    };
  });
}

// ── B) 跨平台自搬运：跑赢基线的爆款，还没发到你的其他主战平台 ──
export function crossPlatformFindings(
  works: OwnWork[],
  persona: PersonaCard,
  now: Date = new Date(),
): { work: OwnWork; targets: string[]; ratio: number; baseline: PlatformBaseline }[] {
  const platforms = (persona.platforms ?? []).filter(Boolean);
  if (platforms.length < 2) return []; // 只经营一个平台，无处可搬
  const baselines = platformBaselines(works);
  if (baselines.size === 0) return [];

  const out: { work: OwnWork; targets: string[]; ratio: number; baseline: PlatformBaseline }[] = [];
  for (const w of works) {
    const age = ageDays(w.publishedAt, now);
    if (age < CROSSPLAT_MIN_AGE_DAYS || age > CROSSPLAT_MAX_AGE_DAYS) continue;
    const base = baselines.get(w.platform);
    if (!base || w.views <= 0) continue;
    const ratio = w.views / base.mean;
    if (ratio < HIT_RATIO) continue; // 没跑赢自己的平均线，搬过去也未必成
    if (isSensitiveTitle(w.title)) continue;

    const grams = textShingles(w.title);
    // 目标平台 = 主战平台里，既不是原平台、也从没发过同题内容的
    const targets = platforms.filter(
      (p) => p !== w.platform && !works.some((o) => o.platform === p && related(grams, o.title)),
    );
    if (targets.length === 0) continue;
    out.push({ work: w, targets, ratio, baseline: base });
  }
  // 倍数越高越该先搬
  out.sort((a, b) => b.ratio - a.ratio);
  return out;
}

// ── 自搬运去重 ──

// 池子里已经有同题候选时，不再让自搬运单出一条。
//
// 这是在真实数据上实测出来的噪声：一条旧作既会被话题回温引用为证据（「你做过这个题，它又上榜了」），
// 又会作为自搬运候选自己占一个推荐位（「这条还没发小红书」）。两条推荐在用户眼里几乎一样，
// 白白吃掉一个位置。「先做哪个话题」这一层同题只该出现一次；
// 至于这条内容要分发到哪几个平台，那是创作工坊的事，不该在选题阶段拆成 N 行。
export function dropDuplicateCrossPlat(crossPlat: Candidate[], others: Candidate[]): Candidate[] {
  if (crossPlat.length === 0 || others.length === 0) return crossPlat;
  const otherGrams = others.map((c) => textShingles(c.title));
  return crossPlat.filter((c) => {
    const grams = textShingles(c.title);
    return !otherGrams.some((o) => {
      let overlap = 0;
      for (const g of grams) {
        if (o.has(g)) {
          overlap++;
          if (overlap >= MIN_OVERLAP) return true;
        }
      }
      return false;
    });
  });
}

// ── 取数 + 组装 ──

// 账号自有作品：发布回流（PublishRecord）+ 历史作品回溯（OwnPost）。
// 两张表都要：前者是本产品发出去的，后者是用户接入前的存量，缺任一都会让「你做过什么」失真。
export async function loadOwnWorks(accountId: string, take = 120): Promise<OwnWork[]> {
  const [records, posts] = await Promise.all([
    prisma.publishRecord.findMany({
      where: { accountId },
      orderBy: { publishedAt: 'desc' },
      take,
      select: { id: true, platform: true, title: true, publishedAt: true, metrics: true },
    }),
    prisma.ownPost.findMany({
      where: { accountId, publishedAt: { not: null } },
      orderBy: { publishedAt: 'desc' },
      take,
      select: { id: true, platform: true, title: true, publishedAt: true, metrics: true },
    }),
  ]);
  const works: OwnWork[] = [];
  for (const r of records) {
    if (!r.title) continue; // 发布记录的 title 可空（补链接时可能只填了 URL）
    // 旧稿回收的判据是「发出去够久了」（RECYCLE_MIN_AGE_DAYS），没有发布时间就算不出「够久」
    if (!r.publishedAt) continue;
    works.push({
      id: r.id,
      source: 'publish',
      platform: r.platform,
      title: r.title,
      publishedAt: r.publishedAt,
      views: parseJson<Metrics>(r.metrics, {}).views ?? 0,
    });
  }
  for (const p of posts) {
    works.push({
      id: p.id,
      source: 'own',
      platform: p.platform,
      title: p.title,
      publishedAt: p.publishedAt!,
      views: parseJson<Metrics>(p.metrics, {}).views ?? 0,
    });
  }
  return works;
}

// 自搬运候选的热度映射：这里的「热」不是全网热度，是**账号内热度**（跑赢自己多少倍）。
// 两者不是一回事，所以刻意封顶 0.6——一条自有爆款不该在粗排里压过一条真正的全网热点，
// 它的优势应该体现在「零制作成本 + 已验证」，那是精排 cost/traffic 维度的事。
const CROSSPLAT_HEAT_CAP = 0.6;

export async function crossPlatformCandidates(input: {
  accountId: string;
  persona: PersonaCard;
  works?: OwnWork[]; // 调用方已加载则复用，避免同一次推荐里查两遍
  limit?: number;
  now?: Date;
}): Promise<Candidate[]> {
  const now = input.now ?? new Date();
  const works = input.works ?? (await loadOwnWorks(input.accountId));
  if (works.length === 0) return [];

  const findings = crossPlatformFindings(works, input.persona, now);
  const out: Candidate[] = [];
  for (const f of findings.slice(0, input.limit ?? 4)) {
    const targets = f.targets.map(platformName).join('、');
    out.push({
      title: f.work.title,
      heat: Math.min(CROSSPLAT_HEAT_CAP, (f.ratio / 3) * CROSSPLAT_HEAT_CAP),
      sourceType: 'crossplat',
      sourceRef: f.work.id,
      platform: f.targets[0],
      // 自有爆款没有「过期」一说，但也不该插队到今日突击去挤真热点。
      queue: 'week',
      evidence:
        `这条在${platformName(f.work.platform)}跑到 ${fmtViews(f.work.views)}播放，` +
        `是你该平台近 ${f.baseline.sample} 条均值（${fmtViews(f.baseline.mean)}）的 ${f.ratio.toFixed(1)} 倍；` +
        `${targets}尚未发过同题内容。`,
      windowHint: `已验证内容改编到${targets}，制作成本远低于从零起题`,
    });
  }
  return out;
}
