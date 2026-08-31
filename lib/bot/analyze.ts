import { prisma } from '../db';
import { parseJson, type Metrics } from '../json';
import { llmComplete } from '../llm/gateway';
import { readPersona, personaCompleteness } from '../persona';
import { platformName } from '../constants';
import { loadGeneProfile } from '../insight/genes';
import { checkDataHealth } from '../insight/health-check';
import { accountPlatformProfiles } from '../insight/learn';
import { log } from '../logger';
import { beaconUrl } from './index';

// 账号体检：群里发「/分析」，机器人把这个账号近 30 天的真实数据摊开，再给一段可执行的反馈。
//
// 【一条硬纪律：先给事实，再给点评】
// 事实块（发了几篇、均播多少、环比涨跌、最好最差是哪条、粉丝净增、数据缺口）是查库算出来的，
// 任何时候都成立；点评是 LLM 基于这些事实写的，AI 不可用时整段缺席但事实照给。
// 反过来做——只给一段没有数字的「建议多发垂类内容」——正是用户最反感的那种 AI 空话，
// 而且他无法判断机器人到底看没看他的数据。
//
// 【没有数据时不许硬凑】一条发布记录都没有，就直说没有、并指路去哪补，
// 绝不拿 0 篇 0 播放去让模型「分析」——那只会生成一段煞有介事的幻觉。

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;

function viewsOf(raw: string): number {
  return parseJson<Metrics>(raw, {}).views ?? 0;
}

export type AccountFacts = {
  accountName: string;
  platform: string;
  personaScore: number;
  published: number;
  prevPublished: number;
  totalViews: number;
  avgViews: number;
  prevAvgViews: number;
  deltaPct: number | null;
  best: { title: string; views: number } | null;
  worst: { title: string; views: number } | null;
  followers: number | null;
  followerDelta7d: number | null;
  geneHeadline: string | null;
  platformLines: string[];
  healthLines: string[];
  missingLink: number;
};

/** 事实包：只查库算数，不调 LLM。抽出来是为了让「体检看的是哪些数」能被单测钉死。 */
export async function collectAccountFacts(accountId: string, now = Date.now()): Promise<AccountFacts | null> {
  const account = await prisma.creatorAccount.findUnique({
    where: { id: accountId },
    select: { name: true, platform: true, personaCard: true },
  });
  if (!account) return null;

  const from = new Date(now - WINDOW_DAYS * DAY_MS);
  const prevFrom = new Date(now - 2 * WINDOW_DAYS * DAY_MS);

  const [records, prevRecords, healthRows, dailyStats, platformProfiles, gene] = await Promise.all([
    prisma.publishRecord.findMany({
      where: { accountId, publishedAt: { gte: from } },
      select: { title: true, metrics: true, platform: true },
    }),
    prisma.publishRecord.findMany({
      where: { accountId, publishedAt: { gte: prevFrom, lt: from } },
      select: { metrics: true },
    }),
    prisma.publishRecord.findMany({
      where: { accountId },
      orderBy: { publishedAt: 'desc' },
      take: 60,
      select: {
        id: true, platform: true, title: true, publishedAt: true, needsBackfill: true, metrics: true,
        snapshots: { select: { takenAt: true, metrics: true } },
      },
    }),
    prisma.accountDailyStat.findMany({
      where: { accountId },
      orderBy: { date: 'desc' },
      take: 7,
      select: { followers: true, followerDelta: true },
    }),
    accountPlatformProfiles(accountId).catch(() => []),
    loadGeneProfile(accountId).catch(() => null),
  ]);

  const totalViews = records.reduce((s, r) => s + viewsOf(r.metrics), 0);
  const avgViews = records.length ? Math.round(totalViews / records.length) : 0;
  const prevAvg = prevRecords.length
    ? Math.round(prevRecords.reduce((s, r) => s + viewsOf(r.metrics), 0) / prevRecords.length)
    : 0;

  const sorted = [...records].sort((a, b) => viewsOf(b.metrics) - viewsOf(a.metrics));
  const top = sorted[0];
  const bottom = sorted.length > 1 ? sorted[sorted.length - 1] : null;

  // 粉丝：最新一条有粉丝数的快照 + 近 7 天净增合计（掉粉是负数，如实呈现不钳 0）
  const latestFollowers = dailyStats.find((d) => d.followers != null)?.followers ?? null;
  const deltas = dailyStats.map((d) => d.followerDelta).filter((d): d is number => d != null);
  const followerDelta7d = deltas.length ? deltas.reduce((s, d) => s + d, 0) : null;

  // 【没有发布时间的不进体检】checkDataHealth 判的是「发了这么久还没数据」这类陈旧问题，
  // 而「这么久」需要发布时间。缺了它按回填当天算，会把一条三个月前的老作品判成刚发的。
  const health = checkDataHealth(
    healthRows.filter((r): r is typeof r & { publishedAt: Date } => r.publishedAt !== null),
    now,
  ).filter((i) => i.severity === 'warn');

  return {
    accountName: account.name,
    platform: account.platform,
    personaScore: personaCompleteness(readPersona(account.personaCard)),
    published: records.length,
    prevPublished: prevRecords.length,
    totalViews,
    avgViews,
    prevAvgViews: prevAvg,
    deltaPct: prevAvg > 0 && avgViews > 0 ? Math.round((avgViews / prevAvg - 1) * 100) : null,
    best: top ? { title: top.title ?? '未命名', views: viewsOf(top.metrics) } : null,
    worst: bottom ? { title: bottom.title ?? '未命名', views: viewsOf(bottom.metrics) } : null,
    followers: latestFollowers,
    followerDelta7d,
    geneHeadline: gene?.headline
      ? `${gene.headline.dimension}「${gene.headline.label}」胜率 ${Math.round(gene.headline.winRate * 100)}%（${gene.headline.sample} 条）`
      : null,
    platformLines: platformProfiles
      .filter((p) => p.sample > 0)
      .slice(0, 3)
      // 互动率算不出来（该平台不给播放量）就不写这一段，别给机器人一个 0.0% 当真事说
      .map(
        (p) =>
          `${platformName(p.platform)}：历史 ${p.sample} 条均播 ${p.avgViews}` +
          (p.engagement === null ? '' : `，互动率 ${(p.engagement * 100).toFixed(1)}%`),
      ),
    healthLines: health.slice(0, 2).map((i) => `${i.title}——${i.detail}`),
    missingLink: healthRows.filter((r) => r.needsBackfill).length,
  };
}

/** 事实块（发给用户看，也原样喂给模型；两边看的是同一份数，不许有第二个口径）。 */
export function factLines(f: AccountFacts): string[] {
  const trend =
    f.deltaPct === null
      ? ''
      : `（环比上一个 ${WINDOW_DAYS} 天${f.deltaPct >= 0 ? '↑' : '↓'}${Math.abs(f.deltaPct)}%）`;
  return [
    `近 ${WINDOW_DAYS} 天发布 ${f.published} 篇（上一期 ${f.prevPublished} 篇），总播放/阅读 ${f.totalViews}，均量 ${f.avgViews}${trend}`,
    f.best ? `最好：《${f.best.title}》${f.best.views}` : '',
    f.worst ? `最弱：《${f.worst.title}》${f.worst.views}` : '',
    f.followers != null ? `粉丝 ${f.followers}${f.followerDelta7d != null ? `，近 7 天净增 ${f.followerDelta7d >= 0 ? '+' : ''}${f.followerDelta7d}` : ''}` : '',
    ...f.platformLines,
    f.geneHeadline ? `爆款基因：${f.geneHeadline}` : '',
    `人设卡完整度 ${f.personaScore}%`,
    f.missingLink > 0 ? `${f.missingLink} 篇缺发布链接，自动回流拿不到它们的数据` : '',
    ...f.healthLines,
  ].filter(Boolean);
}

/**
 * 账号体检全文（直接发到群里的文本）。
 * 无发布数据 → 明确说没有并指路，不生成任何「分析」。
 */
export async function analyzeAccount(params: {
  workspaceId: string;
  accountId: string;
  now?: number;
}): Promise<string> {
  const { workspaceId, accountId } = params;
  const now = params.now ?? Date.now();
  const facts = await collectAccountFacts(accountId, now);
  if (!facts) return '账号不存在或已被删除。';

  const head = `📊 账号体检 · ${facts.accountName}（${platformName(facts.platform)}）`;
  const lines = factLines(facts);

  if (facts.published === 0 && facts.followers == null) {
    return [
      head,
      '近 30 天没有任何发布数据，没有数据我不编分析。',
      '补数据的两条路：装采集助手插件回填创作者后台数据，或在「创作 → 发布登记」里补上已发作品链接。',
      `去补 → ${beaconUrl('/data')}`,
    ].join('\n');
  }

  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { tenantId: true } });
  const factBlock = lines.map((l) => `- ${l}`).join('\n');

  let review = '';
  try {
    const res = await llmComplete(ws?.tenantId ?? null, 'diagnosis', [
      {
        role: 'system',
        content: [
          '你是内容账号的运营诊断助手。下面是这个账号的真实运营数据，请给出体检结论。',
          '硬要求：',
          '1. 每条结论必须引用上面的具体数字，不许出现数据里没有的事实；',
          '2. 建议要具体到「下一步做什么」，不要「多发优质内容」这种废话；',
          '3. 数据不足以下结论时直说「样本太少，先补数据」，不要硬凑；',
          '4. 每条不超过 45 字，这段会发到群聊里。',
          `【账号】${facts.accountName}（${platformName(facts.platform)}）`,
          `【真实数据】\n${factBlock}`,
          '严格输出 JSON：{"findings":["看到的问题或亮点"],"actions":["下一步动作"]}，各不超过 3 条。',
        ].join('\n'),
      },
      { role: 'user', content: '请给出这个账号的体检结论与下一步动作。' },
    ], { json: true, temperature: 0.4 });

    const parsed = parseJson<{ findings?: string[]; actions?: string[] }>(res.text, {});
    const findings = (parsed.findings ?? []).filter(Boolean).map((x) => String(x).slice(0, 80)).slice(0, 3);
    const actions = (parsed.actions ?? []).filter(Boolean).map((x) => String(x).slice(0, 80)).slice(0, 3);
    const degraded = res.mocked || res.degraded;
    if (findings.length || actions.length) {
      review = [
        degraded ? '\n🤖 AI 点评（服务降级，以下为示例文本，别当结论）' : '\n🤖 AI 点评',
        ...findings.map((x) => `· ${x}`),
        actions.length ? '下一步：' : '',
        ...actions.map((x, i) => `${i + 1}. ${x}`),
      ].filter(Boolean).join('\n');
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    review = /配额|quota|演示/.test(msg) ? `\n（AI 点评未生成：${msg}）` : '\n（AI 点评未生成：服务异常，数据部分不受影响）';
    if (!/配额|quota|演示/.test(msg)) log.warn('bot 账号体检点评失败', { accountId, err: e });
  }

  return [head, ...lines.map((l) => `· ${l}`), review, `\n完整数据 → ${beaconUrl('/data')}`].filter(Boolean).join('\n');
}
