import { prisma } from '../db';
import { parseJson, toJson, type Metrics } from '../json';
import { llmComplete } from '../llm/gateway';
import { platformName } from '../constants';
import { buildAccountContext } from '../account-context';
import { writeMemory, deactivateOppositeMemory, recentlyLearnedMemories, type LearnedMemory } from '../memory/core';
import { notify } from '../notify';
import { pushEvent, beaconUrl } from '../bot';
import { toDailySeries, dailyDeltas, coverage7d, type DaySeriesPoint } from './timeseries';
import { automationAllows } from '../jobs/automation';
import { DEMO_WORKSPACE_ID } from '../demo/guard';
import { calibrateAdvisorPersona } from './learn';

// AI 单篇复盘引擎。核心原则：**表现判定/曲线形态/同窗对比全部在代码里确定性算好**，
// 只把「一句话结论/成因/建议」交给 LLM，且每条成因强制标注 data|guess——不让模型裸算数字、编故事。
// 回流三合一（仅 topicId 非空且非 Mock）：reviewed 回写选题 + 曲线形态记忆 + advisor 人物战绩校准。

// ── 曲线形态（纯函数）──

export type CurveShape = 'insufficient' | 'first_day_burst' | 'long_tail' | 'steady';

export const CURVE_LABEL: Record<CurveShape, string> = {
  insufficient: '数据不足',
  first_day_burst: '首日爆发型',
  long_tail: '长尾发酵型',
  steady: '平稳增长型',
};

// 互斥形态对（写形态记忆前下线反面）
const OPPOSITE: Partial<Record<CurveShape, CurveShape>> = {
  first_day_burst: 'long_tail',
  long_tail: 'first_day_burst',
};

export type CurveAnalysis = {
  shape: CurveShape;
  label: string;
  total: number; // 末点累计播放
  firstDayShare: number; // 首日增量占总量比例
  days: number;
};

export function analyzeCurveShape(series: DaySeriesPoint[]): CurveAnalysis {
  const total = series.length ? series[series.length - 1].metrics.views ?? 0 : 0;
  if (series.length < 2 || total <= 0) {
    return { shape: 'insufficient', label: CURVE_LABEL.insufficient, total, firstDayShare: 0, days: series.length };
  }
  const deltas = dailyDeltas(series);
  const firstDelta = deltas[0]?.delta.views ?? 0;
  const firstDayShare = total > 0 ? firstDelta / total : 0;
  let shape: CurveShape;
  if (firstDayShare >= 0.6) shape = 'first_day_burst';
  else if (firstDayShare <= 0.3) shape = 'long_tail';
  else shape = 'steady';
  return { shape, label: CURVE_LABEL[shape], total, firstDayShare: Math.round(firstDayShare * 100) / 100, days: series.length };
}

// ── 同窗基线（纯函数）：账号同平台其它内容，在「发布后第 dayN 天」的平均累计播放 ──

// 取序列里逻辑日 ≤ dayN 的最后一个点的累计播放（没有则返回 null）
export function valueAtDay(series: DaySeriesPoint[], dayN: number): number | null {
  let val: number | null = null;
  for (const p of series) {
    if (p.day <= dayN) val = p.metrics.views ?? 0;
    else break; // series 已按 day 升序
  }
  return val;
}

export function sameWindowBaseline(peerSeries: DaySeriesPoint[][], dayN: number): { sample: number; avgAtDay: number } {
  const vals: number[] = [];
  for (const s of peerSeries) {
    const v = valueAtDay(s, dayN);
    if (v != null && v > 0) vals.push(v);
  }
  const sample = vals.length;
  const avgAtDay = sample > 0 ? Math.round(vals.reduce((a, b) => a + b, 0) / sample) : 0;
  return { sample, avgAtDay };
}

// ── 复盘报告 ──

export type ReviewCause = { factor: string; evidence: 'data' | 'guess' };
export type ReviewVerdict = 'over' | 'meet' | 'under';

export type DecisionChain = {
  sourceType: string;
  hotFrom: string | null; // 蹭的热点/竞品标题
  angle: string | null;
  totalScore: number; // 当时六维总分
  rationale: string | null;
  advisorOpinion: { personaName: string; suggestion: string; rationale: string | null } | null;
};

export type ArticleReview = {
  publishId: string;
  title: string;
  platform: string;
  verdict: ReviewVerdict;
  headline: string;
  shape: CurveShape;
  shapeLabel: string;
  shapeReason: string;
  causes: ReviewCause[];
  suggestions: string[];
  dataComplete: boolean;
  coverage: { have: number; missing: number[] };
  baselineCompare: { dayN: number; value: number; baselineAvg: number; sample: number; ratioPct: number } | null;
  decisionChain: DecisionChain | null;
  mocked: boolean;
};

const OVER = 50; // 超同窗基线 50% 判 over
const UNDER = -50;
const MIN_PEERS = 3;

type SnapRow = { takenAt: Date; metrics: string; source: string | null; milestone: string | null };
function toSeries(snaps: SnapRow[], publishedAt: Date): DaySeriesPoint[] {
  return toDailySeries(
    snaps.map((s) => ({ takenAt: s.takenAt, metrics: parseJson<Metrics>(s.metrics, {}), source: s.source, milestone: s.milestone })),
    publishedAt,
  );
}

export async function generateArticleReview(params: {
  tenantId: string | null;
  accountId: string;
  workspaceId: string;
  publishId: string;
}): Promise<ArticleReview | null> {
  const { tenantId, accountId, workspaceId, publishId } = params;
  const rec = await prisma.publishRecord.findFirst({
    where: { id: publishId, accountId },
    include: { snapshots: { orderBy: { takenAt: 'asc' } } },
  });
  if (!rec) return null;

  const series = toSeries(rec.snapshots, rec.publishedAt);
  const curve = analyzeCurveShape(series);
  const cov = coverage7d(series);
  const dayN = series.length ? series[series.length - 1].day : 0;
  const myViews = series.length ? series[series.length - 1].metrics.views ?? 0 : 0;
  const dataComplete = series.length >= 2 && curve.shape !== 'insufficient';

  // 同窗基线（账号同平台其它作品在 dayN 的平均累计播放）
  const peers = await prisma.publishRecord.findMany({
    where: { accountId, platform: rec.platform, id: { not: publishId } },
    include: { snapshots: { orderBy: { takenAt: 'asc' }, select: { takenAt: true, metrics: true, source: true, milestone: true } } },
    orderBy: { publishedAt: 'desc' },
    take: 30,
  });
  const peerSeries = peers.map((p) => toSeries(p.snapshots, p.publishedAt));
  const bl = sameWindowBaseline(peerSeries, dayN);
  const baselineCompare =
    bl.sample >= MIN_PEERS && bl.avgAtDay > 0 && myViews > 0
      ? { dayN, value: myViews, baselineAvg: bl.avgAtDay, sample: bl.sample, ratioPct: Math.round((myViews / bl.avgAtDay - 1) * 100) }
      : null;
  const verdict: ReviewVerdict = baselineCompare
    ? baselineCompare.ratioPct >= OVER
      ? 'over'
      : baselineCompare.ratioPct <= UNDER
        ? 'under'
        : 'meet'
    : 'meet';

  // 选题信息与决策链
  const topic = rec.topicId ? await prisma.topicIdea.findUnique({ where: { id: rec.topicId } }) : null;
  let advisorOpinion: DecisionChain['advisorOpinion'] = null;
  let hotFrom: string | null = null;
  if (topic?.sourceType === 'advisor' && topic.sourceRef) {
    const op = await prisma.advisorOpinion.findUnique({
      where: { id: topic.sourceRef },
      select: { personaName: true, suggestion: true, rationale: true },
    });
    if (op) advisorOpinion = { personaName: op.personaName, suggestion: op.suggestion, rationale: op.rationale };
  } else if (topic?.sourceType === 'hot' && topic.sourceRef) {
    const h = await prisma.hotItem.findUnique({ where: { id: topic.sourceRef }, select: { title: true } });
    hotFrom = h?.title ?? null;
  } else if (topic?.sourceType === 'competitor' && topic.sourceRef) {
    const c = await prisma.crawledPost.findUnique({ where: { id: topic.sourceRef }, select: { title: true } });
    hotFrom = c?.title ?? null;
  }
  const decisionChain: DecisionChain | null = topic
    ? {
        sourceType: topic.sourceType,
        hotFrom,
        angle: topic.angle,
        totalScore: topic.totalScore,
        rationale: topic.rationale,
        advisorOpinion,
      }
    : null;

  // 确定性数据事实（喂给 LLM，强制其归因建立其上）
  const pName = platformName(rec.platform);
  const factLines = [
    `曲线形态：${curve.label}（首日增量占比 ${Math.round(curve.firstDayShare * 100)}%，覆盖 ${cov.have}/7 天${cov.missing.length ? `，缺 D+${cov.missing.join('/')}` : ''}）`,
    baselineCompare
      ? `D+${dayN} 累计播放 ${myViews}，账号同窗基线 ${baselineCompare.baselineAvg}（${baselineCompare.sample} 篇），${baselineCompare.ratioPct >= 0 ? '高' : '低'}出 ${Math.abs(baselineCompare.ratioPct)}%`
      : `D+${dayN} 累计播放 ${myViews}（同窗基线样本不足，暂不做超/欠判定）`,
  ];

  // 账号人设 + 平台算法要点
  const ctx = await buildAccountContext({ workspaceId, accountId, blocks: ['persona'] });
  const rules = await prisma.algorithmRule.findMany({
    where: { platform: rec.platform, enabled: true, confidence: { not: 'rumor' } },
    orderBy: { weight: 'desc' },
    take: 5,
  });

  // 数据不足 → 简版报告（不硬编成因，只给数据面），不调 LLM 编故事
  let headline = '';
  let shapeReason = '';
  let causes: ReviewCause[] = [];
  let suggestions: string[] = [];
  let mocked = false;

  if (!dataComplete) {
    headline = `数据点不足（覆盖 ${cov.have}/7 天），先补足逐日数据再出完整复盘`;
    shapeReason = '当前仅有的数据点画不出可靠曲线形态。';
  } else {
    const sys = [
      '你是资深内容复盘分析师。基于这篇内容发布后的真实逐日数据，做一次简洁复盘。',
      '硬要求：你的归因必须建立在下方「确定性数据事实」之上，每条成因用 evidence 标注 "data"（有数据直接支撑）或 "guess"（合理推测）；不许编造数据，不许说放之四海皆准的空话。建议不超过 3 条、具体可执行。',
      ctx.parts.persona ?? '',
      rules.length ? `【${pName}算法要点】\n${rules.map((r) => `- ${r.signal}：${r.advice}`).join('\n')}` : '',
      `【确定性数据事实】\n${factLines.join('\n')}`,
      '严格输出 JSON：{"headline":"一句话结论","shapeReason":"用一句话解释这个曲线形态说明了什么","causes":[{"factor":"成因","evidence":"data"}],"suggestions":["下次可做的具体动作"]}',
    ].filter(Boolean).join('\n\n');
    const user = topic
      ? `选题：${rec.title}\n切入角：${topic.angle}\n当时推荐理由：${topic.rationale ?? '（无）'}`
      : `内容：${rec.title}`;
    try {
      const res = await llmComplete(tenantId, 'diagnosis', [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ], { json: true, temperature: 0.4 });
      mocked = res.mocked;
      const parsed = parseJson<{ headline?: string; shapeReason?: string; causes?: ReviewCause[]; suggestions?: string[] }>(res.text, {});
      headline = parsed.headline?.trim() || fallbackHeadline(pName, verdict, baselineCompare);
      shapeReason = parsed.shapeReason?.trim() || `${curve.label}。`;
      causes = Array.isArray(parsed.causes)
        ? parsed.causes
            .filter((c) => c && c.factor)
            .map((c): ReviewCause => ({ factor: String(c.factor).slice(0, 120), evidence: c.evidence === 'data' ? 'data' : 'guess' }))
            .slice(0, 5)
        : [];
      suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions.filter(Boolean).map((x) => String(x).slice(0, 120)).slice(0, 3) : [];
    } catch {
      mocked = true;
      headline = fallbackHeadline(pName, verdict, baselineCompare);
      shapeReason = `${curve.label}。`;
    }
  }

  const review: ArticleReview = {
    publishId,
    title: rec.title ?? '未命名内容',
    platform: rec.platform,
    verdict,
    headline,
    shape: curve.shape,
    shapeLabel: curve.label,
    shapeReason,
    causes,
    suggestions,
    dataComplete,
    coverage: cov,
    baselineCompare,
    decisionChain,
    mocked,
  };

  await prisma.reviewReport.create({
    data: { accountId, kind: 'article', refId: publishId, content: toJson(review), mocked },
  });

  // ── 三合一回流：仅 topicId 非空且非 Mock（Mock 无真实判断，不污染学习）──
  if (rec.topicId && !mocked && dataComplete) {
    // 1) reviewed 回写（激活七态死状态；仅从 published 迁移，不下修其它状态）
    await prisma.topicIdea.updateMany({ where: { id: rec.topicId, state: 'published' }, data: { state: 'reviewed' } }).catch(() => {});
    // 2) 曲线形态记忆（稳定措辞 + 互斥）
    if (curve.shape !== 'insufficient') {
      const content = `${pName}内容多呈${curve.label}`;
      const opp = OPPOSITE[curve.shape];
      if (opp) await deactivateOppositeMemory(workspaceId, accountId, 'performance', [`${pName}内容多呈${CURVE_LABEL[opp]}`]).catch(() => {});
      await writeMemory({ workspaceId, accountId, type: 'performance', content, confidence: 0.4 }).catch(() => {});
    }
    // 3) advisor 人物战绩校准（数据说了算）。走 learn.ts 的唯一实现——发布回流那条链路也调它，
    // 同一篇的结论按「标题+平台」去重覆盖，两条链路不会各写一条把笔记堆重。
    if (verdict === 'over' || verdict === 'under') {
      await calibrateAdvisorPersona(
        accountId,
        { sourceType: topic?.sourceType ?? '', sourceRef: topic?.sourceRef ?? null },
        { proven: verdict === 'over', title: rec.title ?? '未命名内容', platformName: pName },
      ).catch(() => {});
    }
  }

  return review;
}

function fallbackHeadline(pName: string, verdict: ReviewVerdict, bc: ArticleReview['baselineCompare']): string {
  if (bc) {
    const dir = verdict === 'over' ? '跑赢' : verdict === 'under' ? '低于' : '接近';
    return `这篇在${pName}${dir}你的同窗基线 ${Math.abs(bc.ratioPct)}%（D+${bc.dayN}）`;
  }
  return `${pName}这篇已回流数据，样本还不够判定超/欠基线`;
}

// 批量自动复盘扫描：发布满 7 天、有 topicId、≥2 快照、未复盘、工作区开关开、非演示 → 生成复盘。
// 只扫近 7-21 天窗口（太久的不补）。定时任务全量扫描；「立即运行」传 workspaceId 只扫本工作区。
export async function scanAndGenerateReviews(opts: { workspaceId?: string } = {}): Promise<{ scanned: number; generated: number; skipped: number }> {
  const now = Date.now();
  const from = new Date(now - 21 * 24 * 3600_000);
  const to = new Date(now - 7 * 24 * 3600_000);
  const records = await prisma.publishRecord.findMany({
    where: {
      publishedAt: { gte: from, lte: to },
      topicId: { not: null },
      account: opts.workspaceId ? { workspaceId: opts.workspaceId } : { workspaceId: { not: DEMO_WORKSPACE_ID } },
    },
    include: {
      account: { select: { workspaceId: true, workspace: { select: { automationConfig: true, tenantId: true } } } },
      _count: { select: { snapshots: true } },
    },
    orderBy: { publishedAt: 'desc' },
    take: 200,
  });
  let generated = 0;
  let skipped = 0;
  for (const rec of records) {
    if (rec.account.workspaceId === DEMO_WORKSPACE_ID) { skipped++; continue; }
    if (!automationAllows(rec.account.workspace.automationConfig, 'autoReview')) { skipped++; continue; }
    if (rec._count.snapshots < 2) { skipped++; continue; } // 数据不齐先不自动复盘
    const existing = await prisma.reviewReport.findFirst({ where: { accountId: rec.accountId, kind: 'article', refId: rec.id } });
    if (existing) { skipped++; continue; }
    const r = await generateArticleReview({
      tenantId: rec.account.workspace.tenantId,
      accountId: rec.accountId,
      workspaceId: rec.account.workspaceId,
      publishId: rec.id,
    }).catch(() => null);
    if (r) generated++;
    else skipped++;
  }
  return { scanned: records.length, generated, skipped };
}

// ── 周度运营复盘 ──

export type WeeklyReview = {
  period: string; // 如 2026-W29
  published: number;
  totalViews: number;
  avgViews: number;
  prevAvgViews: number;
  deltaPct: number | null; // 环比上周均播
  best: { title: string; views: number } | null;
  worst: { title: string; views: number } | null;
  recVsSelf: { recCount: number; recAvg: number; selfCount: number; selfAvg: number; liftPct: number | null };
  conclusions: string[];
  suggestions: string[];
  /** R7 记忆可见化：本周烽火台记住了你的几件事（代码算，非 LLM 生成） */
  learned: LearnedMemory[];
  mocked: boolean;
};

// 真正的 ISO-8601 周号：周一为一周之始，第 1 周是**包含当年第一个周四**的那一周。
// 此前是 ceil(当年第几天 / 7)，既不对齐周一、也不处理跨年周：
// 真实的 2026-W53（覆盖 2027-01-01）会被标成 2027-W01，年末那份周报归错年份、
// 且与任何外部周序号对不上账。周号同时决定 ReviewReport.period（去重键），标错即去重错。
export function isoWeek(now: number): string {
  const src = new Date(now);
  // 只保留日期部分（UTC），避免时分秒参与运算
  const d = new Date(Date.UTC(src.getUTCFullYear(), src.getUTCMonth(), src.getUTCDate()));
  // 挪到本周的周四：ISO 周号归属由该周周四所在的年份决定，跨年周靠这一步归位
  const dayNum = (d.getUTCDay() + 6) % 7; // 周一=0 … 周日=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const isoYear = d.getUTCFullYear();
  // 该 ISO 年第 1 周的周四（1 月 4 日必定落在第 1 周内）
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

const viewsOf = (raw: string): number => parseJson<Metrics>(raw, {}).views ?? 0;

export async function generateWeeklyReview(params: { tenantId: string | null; accountId: string; workspaceId: string }): Promise<WeeklyReview | null> {
  const { tenantId, accountId, workspaceId } = params;
  const now = Date.now();
  const weekAgo = new Date(now - 7 * 86_400_000);
  const twoWeeksAgo = new Date(now - 14 * 86_400_000);

  const [thisWeek, prevWeek, account] = await Promise.all([
    prisma.publishRecord.findMany({ where: { accountId, publishedAt: { gte: weekAgo } }, select: { title: true, metrics: true, fromRecommend: true, platform: true } }),
    prisma.publishRecord.findMany({ where: { accountId, publishedAt: { gte: twoWeeksAgo, lt: weekAgo } }, select: { metrics: true } }),
    prisma.creatorAccount.findUnique({ where: { id: accountId }, select: { name: true } }),
  ]);
  if (thisWeek.length === 0) return null; // 本周无发布，不出周报

  // 同一周只出一份：ReviewReport 上没有 (accountId, kind, period) 唯一约束，
  // 而「立即生成本周周报」按钮是用户可反复点的——不挡的话点 N 次就是 N 份重复周报、
  // N 条站内信、N 张机器人卡片，外加 N 次真金白银的 LLM 调用。
  // 与同文件 scanAndGenerateReviews 的 article 复盘保持同一套「先查存在再生成」口径。
  // 放在 LLM 调用之前：省掉的不只是重复记录，还有那次生成开销。
  const period = isoWeek(now);
  const already = await prisma.reviewReport.findFirst({ where: { accountId, kind: 'weekly', period } });
  if (already) return null;

  const totalViews = thisWeek.reduce((s, r) => s + viewsOf(r.metrics), 0);
  const avgViews = Math.round(totalViews / thisWeek.length);
  const prevViews = prevWeek.reduce((s, r) => s + viewsOf(r.metrics), 0);
  const prevAvgViews = prevWeek.length ? Math.round(prevViews / prevWeek.length) : 0;
  const deltaPct = prevAvgViews > 0 ? Math.round((avgViews / prevAvgViews - 1) * 100) : null;

  const sorted = [...thisWeek].sort((a, b) => viewsOf(b.metrics) - viewsOf(a.metrics));
  const best = sorted[0] ? { title: sorted[0].title ?? '未命名', views: viewsOf(sorted[0].metrics) } : null;
  const worst = sorted.length > 1 ? { title: sorted[sorted.length - 1].title ?? '未命名', views: viewsOf(sorted[sorted.length - 1].metrics) } : null;

  const rec = thisWeek.filter((r) => r.fromRecommend);
  const self = thisWeek.filter((r) => !r.fromRecommend);
  const recAvg = rec.length ? Math.round(rec.reduce((s, r) => s + viewsOf(r.metrics), 0) / rec.length) : 0;
  const selfAvg = self.length ? Math.round(self.reduce((s, r) => s + viewsOf(r.metrics), 0) / self.length) : 0;
  const liftPct = recAvg > 0 && selfAvg > 0 ? Math.round((recAvg / selfAvg - 1) * 100) : null;

  const factBlock = [
    `本周发布 ${thisWeek.length} 篇，总播放 ${totalViews}，均播 ${avgViews}${deltaPct === null ? '' : `（环比上周${deltaPct >= 0 ? '↑' : '↓'}${Math.abs(deltaPct)}%）`}`,
    best ? `最佳：《${best.title}》播放 ${best.views}` : '',
    worst ? `最弱：《${worst.title}》播放 ${worst.views}` : '',
    liftPct !== null ? `AI 推荐均播 ${recAvg} vs 自选 ${selfAvg}（${liftPct >= 0 ? '+' : ''}${liftPct}%）` : '',
  ].filter(Boolean).join('\n');

  let conclusions: string[] = [];
  let suggestions: string[] = [];
  let mocked = false;
  const ctx = await buildAccountContext({ workspaceId, accountId, blocks: ['persona'] });
  try {
    const res = await llmComplete(tenantId, 'diagnosis', [
      {
        role: 'system',
        content: [
          '你是内容账号的运营复盘助手。基于下方本周真实运营数据，输出本周复盘。',
          '硬要求：结论必须基于给出的数据，不空谈；结论与建议各不超过 3 条、具体。',
          ctx.parts.persona ?? '',
          `【本周运营数据】\n${factBlock}`,
          '严格输出 JSON：{"conclusions":["本周结论"],"suggestions":["下周建议"]}',
        ].filter(Boolean).join('\n\n'),
      },
      { role: 'user', content: '请给出本周复盘。' },
    ], { json: true, temperature: 0.5 });
    mocked = res.mocked;
    const parsed = parseJson<{ conclusions?: string[]; suggestions?: string[] }>(res.text, {});
    conclusions = Array.isArray(parsed.conclusions) ? parsed.conclusions.filter(Boolean).map((x) => String(x).slice(0, 120)).slice(0, 3) : [];
    suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions.filter(Boolean).map((x) => String(x).slice(0, 120)).slice(0, 3) : [];
  } catch {
    mocked = true;
  }
  if (conclusions.length === 0) conclusions = [factBlock.split('\n')[0]]; // 兜底：至少给数据面结论

  // R7：本周记住了你的 3 件事。放在 LLM 之后、落库之前——它是确定性事实，
  // 不参与上面的生成，Mock 降级时这块照样是真的。
  const learned = await recentlyLearnedMemories(workspaceId, accountId, weekAgo, 3);

  const review: WeeklyReview = { period, published: thisWeek.length, totalViews, avgViews, prevAvgViews, deltaPct, best, worst, recVsSelf: { recCount: rec.length, recAvg, selfCount: self.length, selfAvg, liftPct }, conclusions, suggestions, learned, mocked };

  await prisma.reviewReport.create({ data: { accountId, kind: 'weekly', period, content: toJson(review), mocked } });

  // 触达：站内通知 + 外部机器人（订阅了 review_ready 的）
  const title = `📅 ${account?.name ?? '账号'} 本周复盘（${period}）`;
  const body = `发布 ${thisWeek.length} 篇 · 均播 ${avgViews}${deltaPct === null ? '' : `（环比${deltaPct >= 0 ? '+' : ''}${deltaPct}%）`}｜${conclusions[0] ?? ''}`;
  await notify({ workspaceId, accountId, kind: 'weekly_review', refId: period, title, body, link: '/data' });
  await pushEvent(workspaceId, 'review_ready', {
    kind: 'card',
    title,
    lines: [
      ...conclusions.map((c) => `· ${c}`),
      ...(suggestions.length ? ['下周建议：', ...suggestions.map((s) => `→ ${s}`)] : []),
      // R7：让「系统学到了什么」每周主动露一次面，而不是只在 prompt 里悄悄用
      ...(learned.length
        ? [`烽火台这周记住了你的 ${learned.length} 件事：`, ...learned.map((l) => `🧠 ${l.content}${l.isNew ? '' : `（第 ${l.hitCount} 次验证）`}`)]
        : []),
    ],
    link: { text: '看数据看板', url: beaconUrl('/data') },
  });
  return review;
}

// 批量周度复盘（定时任务全量；「立即运行」传 workspaceId 只跑本工作区）
export async function scanWeeklyReviews(opts: { workspaceId?: string } = {}): Promise<{ accounts: number; generated: number }> {
  const accounts = await prisma.creatorAccount.findMany({
    where: { status: 'active', ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : { workspaceId: { not: DEMO_WORKSPACE_ID } }) },
    include: { workspace: { select: { automationConfig: true, tenantId: true } } },
  });
  let generated = 0;
  for (const a of accounts) {
    if (a.workspaceId === DEMO_WORKSPACE_ID) continue;
    if (!automationAllows(a.workspace.automationConfig, 'weeklyReview')) continue;
    const r = await generateWeeklyReview({ tenantId: a.workspace.tenantId, accountId: a.id, workspaceId: a.workspaceId }).catch(() => null);
    if (r) generated++;
  }
  return { accounts: accounts.length, generated };
}
