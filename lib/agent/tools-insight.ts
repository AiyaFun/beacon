import { prisma } from '../db';
import { parseJson, type Metrics, type MetricCountKey } from '../json';
import { fmtDate } from '../format';
import { authoritativeMetrics } from '../insight/source-priority';
import { absenceNote } from '../insight/platform-metrics';
import { loadGeneProfile } from '../insight/genes';
import { readerVoice, KIND_LABEL } from '../insight/reader-voice';
import { buildBaseline, diagnose } from '../algorithm/coach';
import { platformName } from '../constants';
import type { AgentTool } from './tools';

// ── 数据与洞察类工具 ────────────────────────────────────────────────────────
//
// 这一组回答「我做得怎么样、为什么」。全部是只读、不花钱的。
//
// 【这一组反复要处理的一件事：缺席不许当成 0】抖音的公开作品页没有播放量，
// 小红书拿不到完播率——这些是**平台没有**，不是「表现差」。给模型回 0 的下场
// 项目里出过两次：页面上所有抖音作品一律「互动率 0.0%」，按互动率排序时抖音被
// 系统性摁到最底。所以这里的规矩是两条：
//   ① 值保持 null，绝不 `?? 0`；
//   ② 顺手把 absenceNote() 一起带上——只给 null，模型分不清「平台没有」「没采到」
//      「真的是 0」，它会自己挑一个说法，而那个说法多半是错的。

const num = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v.trim() : fallback);

/** 展示给模型的计数指标。跟 /data 页同一套键，不多不少。 */
const COUNT_KEYS: MetricCountKey[] = ['views', 'likes', 'comments', 'shares', 'collects'];

/**
 * 把一条作品的指标压成「值 + 缺席原因」的形状。
 *
 * 有值就给值；没值就给 null 并附一句为什么没有——这一句是模型不至于胡说的关键。
 */
function metricsForModel(platform: string, m: Metrics): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of COUNT_KEYS) {
    const v = m[key];
    if (typeof v === 'number') {
      out[key] = v;
      continue;
    }
    // availabilityOf 的缺省是 'unknown'（没验过）而不是 'no'（平台没有）——
    // 两者对用户的意思完全不同，绝不许拿 unknown 冒充 no
    out[key] = null;
    out[`${key}_缺席原因`] = absenceNote(platform, key);
  }
  if (typeof m.completion === 'number') out.completion = m.completion;
  return out;
}

const accountPerformance: AgentTool = {
  name: 'account_performance',
  label: '查我的作品表现',
  action: 'content.view',
  write: false,
  def: {
    name: 'account_performance',
    description:
      '当前账号最近发布作品的数据表现（播放/点赞/评论等）。'
      + '拿不到的指标会给 null 并附「为什么没有」——那是平台不提供或还没采到，**不是表现为 0**，转述时要说清楚。',
    parameters: { type: 'object', properties: { limit: { type: 'number', description: '默认 10，上限 30' } } },
  },
  async run(ctx, args) {
    const limit = clamp(num(args.limit, 10), 1, 30);

    // 【这里曾经读错了表】原来查的是 OwnPost，而全库只有「导入历史作品 CSV」这一个
    // 入口会写它；插件回填与发布登记写的都是 PublishRecord。结果是用户在数据看板上
    // 看得见几十条作品，一问 AI 却得到「还没有回流的作品数据」——功能看着在，其实没接上。
    // 现在以 PublishRecord 为主，OwnPost 只作为「导入过 CSV 但还没有发布记录」的补充。
    const records = await prisma.publishRecord.findMany({
      where: { accountId: ctx.accountId },
      orderBy: { publishedAt: 'desc' },
      take: limit,
      select: {
        id: true, title: true, platform: true, publishedAt: true, metrics: true,
        snapshots: { select: { takenAt: true, metrics: true, source: true, milestone: true } },
      },
    });

    const rows = records.map((r) => ({
      publishId: r.id,
      title: r.title ?? '(无标题)',
      platform: platformName(r.platform),
      publishedAt: fmtDate(r.publishedAt),
      // 下结论用「来源优先级」挑出来的那份，不是 PublishRecord.metrics 上「谁最后写谁说了算」的值。
      // 用户随手补的一个约数不该盖掉插件同日拉回来的精确值——/data 页、复盘、预警用的都是这一份
      ...metricsForModel(r.platform, authoritativeMetrics(r.metrics, r.snapshots, r.publishedAt)),
    }));

    if (rows.length === 0) {
      // 没有发布记录时看一眼有没有导入过历史作品：直接说「没有数据」而用户明明导过，
      // 是同一个「功能看着在其实没接上」的坑
      const imported = await prisma.ownPost.count({ where: { accountId: ctx.accountId } });
      return {
        ok: true,
        data: [],
        summary: imported > 0
          ? `还没有发布记录，但导入过 ${imported} 条历史作品——让用户去「数据」页看，或先登记一次发布`
          : '这个账号还没有作品数据（没登记过发布，插件也还没回填）',
      };
    }

    return { ok: true, data: rows, summary: `最近 ${rows.length} 条作品的表现` };
  },
};

const workMetrics: AgentTool = {
  name: 'work_metrics',
  label: '查单条作品的详细数据',
  action: 'content.view',
  write: false,
  def: {
    name: 'work_metrics',
    description:
      '查**一条**作品的完整指标与逐日变化。先用 account_performance 拿 publishId。'
      + '用于「这条为什么跑得好/差」这类要看细节的问题。缺席的指标同样给 null 加原因。',
    parameters: {
      type: 'object',
      properties: { publishId: { type: 'string', description: 'account_performance 返回的 publishId' } },
      required: ['publishId'],
    },
  },
  async run(ctx, args) {
    const publishId = str(args.publishId);
    if (!publishId) return { ok: false, error: '要先说清楚看哪一条（先调 account_performance）', summary: '缺少 publishId' };

    // 归属校验绝不能省：模型可能把别处见过的 id 直接拿来用（它并不知道那是别人的）
    const record = await prisma.publishRecord.findFirst({
      where: { id: publishId, accountId: ctx.accountId },
      include: { snapshots: { orderBy: { takenAt: 'asc' }, select: { takenAt: true, metrics: true, source: true, milestone: true } } },
    });
    if (!record) return { ok: false, error: '这条作品不存在，或不属于当前账号', summary: '没找到这条作品' };

    const m = authoritativeMetrics(record.metrics, record.snapshots, record.publishedAt);
    // 逐日序列：让模型看得出「是首日就起不来，还是第三天才断掉」——这两种要给的建议完全不同
    const trend = record.snapshots.map((s) => {
      const sm = parseJson<Metrics>(s.metrics, {});
      return { at: fmtDate(s.takenAt), views: sm.views ?? null, likes: sm.likes ?? null, source: s.source ?? '未标注' };
    });

    return {
      ok: true,
      data: {
        title: record.title ?? '(无标题)',
        platform: platformName(record.platform),
        publishedAt: fmtDate(record.publishedAt),
        指标: metricsForModel(record.platform, m),
        快照条数: record.snapshots.length,
        趋势: trend.slice(-14),
        // 没有快照 = 从来没回流过，与「回流了但数字没涨」是两件事
        说明: record.snapshots.length === 0 ? '这条作品还没有任何数据快照（没回流过），下面的数字是登记发布时填的' : null,
      },
      summary: `《${record.title ?? '无标题'}》· ${platformName(record.platform)} · ${record.snapshots.length} 次数据回流`,
    };
  },
};

const listComments: AgentTool = {
  name: 'list_comments',
  label: '看读者原声',
  action: 'content.view',
  write: false,
  def: {
    name: 'list_comments',
    description:
      '读者在评论区说了什么：总条数、大致分类占比、反复被提到的话题（带例句）。'
      + '用于「读者关心什么」「大家在问什么」。⚠️ 分类是关键词粗分，不是事实断言，'
      + '别据此算出「满意度百分之多少」这种结论。',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['own', 'rival'], description: 'own=我自己作品下的读者（默认），rival=竞对作品下的' },
        platform: { type: 'string', description: '可选：只看某个平台' },
      },
    },
  },
  async run(ctx, args) {
    const scope = str(args.scope) === 'rival' ? 'rival' : 'own';
    const platform = str(args.platform) || undefined;
    const voice = await readerVoice(ctx.workspaceId, {
      scope,
      // 自己的读者才按账号收窄；竞对那侧本来就是工作区级
      accountId: scope === 'own' ? ctx.accountId : undefined,
      platform,
    });

    if (voice.total === 0) {
      return {
        ok: true,
        data: { total: 0 },
        // 评论正文有 90 天保留期，「查不到」不等于「没采过」——这句必须说，
        // 否则模型会告诉用户「你的作品没人评论」
        summary: '这个范围里没有留存的读者评论（评论正文只保留 90 天，也可能是还没用插件采过）',
      };
    }

    return {
      ok: true,
      data: {
        总条数: voice.total,
        分类占比: voice.kinds.map((k) => ({ 类型: KIND_LABEL[k.kind] ?? k.kind, 条数: k.count, 占比: `${k.pct}%` })),
        // samples 是给人核对「这个词是从哪来的」，不能省——只给统计不给出处等于让人凭空信
        反复被提到: voice.concerns.map((c) => ({ 话题: c.term, 多少条提到: c.docs, 例句: c.samples.slice(0, 2) })),
      },
      summary: `${scope === 'own' ? '自有作品' : '竞对作品'}下共 ${voice.total} 条读者评论，${voice.concerns.length} 个反复出现的话题`,
    };
  },
};

const genesSummary: AgentTool = {
  name: 'genes_summary',
  label: '看爆款基因',
  action: 'content.view',
  write: false,
  def: {
    name: 'genes_summary',
    description:
      '这个账号「什么形状的内容跑得动」：近 180 天已发布内容按来源/平台/时段/切入角算胜率。'
      + '用于「我该写什么类型」「什么时候发」。⚠️ 胜率为 null 表示**样本不足**（不到 3 条），不是 0%。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  async run(ctx) {
    const profile = await loadGeneProfile(ctx.accountId);
    if (profile.sample === 0) {
      return {
        ok: true,
        data: { sample: 0 },
        summary: '还没有带播放数据的已发布内容，算不出爆款基因（不是「基因弱」，是还没有样本）',
      };
    }
    return {
      ok: true,
      data: {
        样本数: profile.sample,
        统计窗口天数: profile.windowDays,
        一句话结论: profile.headline
          ? `${profile.headline.label} 表现最好（胜率 ${Math.round(profile.headline.winRate * 100)}%，${profile.headline.sample} 条样本）`
          : '样本还不够，给不出稳定结论',
        各维度: profile.dimensions.map((d) => ({
          维度: d.name,
          // conclusive=false 表示这一维**没有任何一档达到样本线**，整块都不该下结论
          有结论: d.conclusive,
          分档: d.buckets.map((b) => ({
            名称: b.label,
            样本: b.sample,
            // null 必须原样带走并说清楚：写成 0 模型会当成「这一档从来不成功」
            胜率: b.winRate === null ? null : `${Math.round(b.winRate * 100)}%`,
            备注: b.winRate === null ? '样本不足 3 条，没有结论' : null,
          })),
        })),
      },
      summary: `${profile.sample} 条样本的爆款基因画像`,
    };
  },
};

const algorithmHint: AgentTool = {
  name: 'algorithm_hint',
  label: '看平台算法诊断',
  action: 'content.view',
  write: false,
  def: {
    name: 'algorithm_hint',
    description:
      '按某个平台的第一权重信号，对照这个账号的真实基线给出 good/warn/bad 诊断与改法。'
      + '用于「为什么我的播放起不来」「这个平台看重什么」。是确定性规则，不是模型猜的。',
    parameters: {
      type: 'object',
      properties: { platform: { type: 'string', description: '平台键，如 douyin / xiaohongshu / wechat / bilibili。不传用当前账号主战平台' } },
    },
  },
  async run(ctx, args) {
    const account = await prisma.creatorAccount.findUnique({
      where: { id: ctx.accountId },
      select: { platform: true },
    });
    const platform = str(args.platform) || account?.platform || '';
    if (!platform) return { ok: false, error: '不知道要诊断哪个平台', summary: '缺少平台' };

    // 取数口径照抄 /algorithm 页：自有作品 + 发布记录各取近 20 条，只留有播放量的。
    // 【别自造第三份口径】页面一份、这里一份就已经会对不上了
    const [posts, records] = await Promise.all([
      prisma.ownPost.findMany({
        where: { accountId: ctx.accountId, platform },
        orderBy: { publishedAt: 'desc' }, take: 20, select: { metrics: true },
      }),
      prisma.publishRecord.findMany({
        where: { accountId: ctx.accountId, platform },
        orderBy: { publishedAt: 'desc' }, take: 20, select: { metrics: true },
      }),
    ]);
    const list = [...posts, ...records]
      .map((r) => parseJson<Metrics>(r.metrics, {}))
      .filter((m) => (m.views ?? 0) > 0);

    const baseline = buildBaseline(list);
    const findings = diagnose(platform, list);

    return {
      ok: true,
      data: {
        平台: platformName(platform),
        样本数: baseline.sample,
        // 基线里每个率都可能是 null（算不出来），原样带走。
        // 写成 0.0% 模型会反过来给出「你点赞率过低要改开头」这种凭空结论
        基线: {
          均播放: baseline.avgViews,
          完播率: baseline.avgCompletion,
          点赞率: baseline.likeRate,
          评论率: baseline.commentRate,
          收藏率: baseline.collectRate,
        },
        诊断: findings.map((f) => ({ 信号: f.signal, 判定: f.severity, 发现: f.finding, 建议: f.advice })),
      },
      summary: baseline.sample > 0
        ? `${platformName(platform)} · ${baseline.sample} 条样本 · ${findings.length} 条诊断`
        : `${platformName(platform)} 还没有带播放量的样本，只能给通用建议`,
    };
  },
};

export const INSIGHT_TOOLS: AgentTool[] = [
  accountPerformance,
  workMetrics,
  listComments,
  genesSummary,
  algorithmHint,
];