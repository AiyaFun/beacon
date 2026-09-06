import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { parseJson, type Metrics } from '@/lib/json';
import { readPersona, personaPromptBlock } from '@/lib/persona';
import { llmComplete } from '@/lib/llm/gateway';
import { PLATFORMS, PLATFORM_LIST, platformName } from '@/lib/constants';
import { fmtNum } from '@/lib/format';
import { Card, Meter, ConfidenceBadge, Empty } from '@/components/ui';
import { Icon } from '@/components/icons';
import { diagnose, buildBaseline } from '@/lib/algorithm/coach';
import { AI_SOURCE_UNKNOWN_NOTE, AI_SOURCE_VERSION, aiSourceOf } from '@/lib/algorithm/ai-source';
import { isDemoTenant } from '@/lib/demo/guard';
import { getServerLang } from '@/lib/i18n/server';

// 「平台算法教练」面板 —— 原 /algorithm 页的主体，现为「看效果」页的一个标签。

const CONF_ORDER: Record<string, number> = { official: 0, opensource: 1, consensus: 2, rumor: 3 };

function contentTypeName(t: string, isEn: boolean): string {
  if (isEn) {
    const map: Record<string, string> = {
      short_video: 'Short Video', image_text: 'Image & Text', article: 'Article', long_video: 'Long Video', short_text: 'Short Text', all: 'General',
    };
    return map[t] ?? t;
  }
  const map: Record<string, string> = {
    short_video: '短视频', image_text: '图文', article: '长图文', long_video: '中长视频', short_text: '短文本', all: '通用',
  };
  return map[t] ?? t;
}
function sevDot(sev: string): string {
  if (sev === 'good') return 'dot-green';
  if (sev === 'bad') return 'dot-red';
  return 'dot-amber';
}

export async function AlgorithmPanel({ platform: platformParam }: { platform?: string }) {
  const platform = platformParam && platformParam in PLATFORMS ? platformParam : 'douyin';
  const s = await getSession();
  const lang = await getServerLang();
  const isEn = lang === 'en';

  const [rules, ownPosts, publishRecords] = await Promise.all([
    prisma.algorithmRule.findMany({ where: { platform, enabled: true }, orderBy: { weight: 'desc' } }),
    prisma.ownPost.findMany({ where: { accountId: s.accountId, platform }, orderBy: { publishedAt: 'desc' }, take: 20 }),
    prisma.publishRecord.findMany({
      where: { accountId: s.accountId, platform }, orderBy: { publishedAt: 'desc' }, take: 20, select: { metrics: true },
    }),
  ]);

  const metricsList = [...ownPosts, ...publishRecords]
    .map((p) => parseJson<Metrics>(p.metrics, {}))
    .filter((m) => (m.views ?? 0) > 0);
  const baseline = buildBaseline(metricsList);
  const diagnoses = diagnose(platform, metricsList);

  const watch = await prisma.watchlistItem.findMany({
    where: { workspaceId: s.workspaceId },
    select: { competitor: { select: { id: true, platform: true } } },
  });
  const compIds = watch.filter((w) => w.competitor.platform === platform).map((w) => w.competitor.id);
  const compPosts = compIds.length
    ? await prisma.crawledPost.findMany({
        where: { competitorId: { in: compIds }, platform }, select: { metrics: true }, orderBy: { hotScore: 'desc' }, take: 60,
      })
    : [];
  const compMetrics = compPosts.map((p) => parseJson<Metrics>(p.metrics, {})).filter((m) => (m.views ?? 0) > 0);
  const compBaseline = buildBaseline(compMetrics);

  const trusted = rules.filter((r) => r.confidence !== 'rumor');
  const checklist = trusted.map((r) => ({ text: r.advice, conf: r.confidence }));

  const account = await prisma.creatorAccount.findUnique({ where: { id: s.accountId } });
  const persona = readPersona(account?.personaCard ?? '{}');
  const fmtBaseline = (b: typeof baseline) => {
    const bits: string[] = [];
    if (b.avgViews !== null) bits.push(isEn ? `Avg views ${fmtNum(b.avgViews)}` : `平均播放 ${fmtNum(b.avgViews)}`);
    bits.push(isEn ? `Completion rate ${b.avgCompletion === null ? 'N/A' : (b.avgCompletion * 100).toFixed(1) + '%'}` : `完播/完读率 ${b.avgCompletion === null ? '无' : (b.avgCompletion * 100).toFixed(1) + '%'}`);
    if (b.likeRate !== null) bits.push(isEn ? `Like rate ${(b.likeRate * 100).toFixed(1)}%` : `点赞率 ${(b.likeRate * 100).toFixed(1)}%`);
    if (b.commentRate !== null) bits.push(isEn ? `Comment rate ${(b.commentRate * 100).toFixed(1)}%` : `评论率 ${(b.commentRate * 100).toFixed(1)}%`);
    if (b.collectRate !== null) bits.push(isEn ? `Bookmark rate ${(b.collectRate * 100).toFixed(1)}%` : `收藏率 ${(b.collectRate * 100).toFixed(1)}%`);
    if (b.shareRate !== null) bits.push(isEn ? `Share rate ${(b.shareRate * 100).toFixed(1)}%` : `转发率 ${(b.shareRate * 100).toFixed(1)}%`);
    if (b.avgViews === null) bits.push(isEn ? '(Public page does not expose views on this platform; interaction absolute counts are verified)' : '（该平台公开页面不提供播放量，率类指标不可得；点赞/评论/收藏/转发的绝对数是真实的）');
    return bits.join(isEn ? ', ' : '，');
  };
  let llmText = '';
  if ((baseline.sample > 0 || compBaseline.sample > 0) && !isDemoTenant(s.tenantId)) {
    const ruleLines = trusted.map((r) => `- ${r.signal}（${isEn ? 'Weight ' : '权重'}${Math.round(r.weight * 100)}/100）：${r.advice}`).join('\n');
    const ownLine = baseline.sample > 0 ? (isEn ? `Your metrics (${baseline.sample} posts): ${fmtBaseline(baseline)}` : `你自己（${baseline.sample} 条）：${fmtBaseline(baseline)}`) : (isEn ? 'Your metrics: No backfill data yet' : '你自己：暂无回流数据（还没登记/采集到自己作品的表现）');
    const compLine = compBaseline.sample > 0 ? (isEn ? `Competitor benchmark (${compBaseline.sample} collected posts): ${fmtBaseline(compBaseline)}` : `竞对基准（${compBaseline.sample} 条已采集作品）：${fmtBaseline(compBaseline)}`) : (isEn ? 'Competitor benchmark: No collected competitor data on this platform' : '竞对基准：暂无该平台竞对作品数据');
    const res = await llmComplete(s.tenantId, 'diagnosis', [
      { role: 'system', content: isEn ? 'You are a platform algorithm coach. Provide directional recommendations based on platform signals, own historical metrics, and competitor benchmarks. 3-4 sentences in English.' : '你是平台算法教练。结合三方证据给方向性建议：①平台算法信号与权重（公开算法信息）②该账号自己的历史回流 ③同平台竞对的真实表现基准。禁止「保证上热门」类承诺。用中文，3-4 句：先指出该账号相对竞对基准/健康线在第一权重信号上的最大短板（可引用具体数字对比），再给一条最该先做的动作。若该账号暂无自有数据，就以竞对基准为参照给出对标建议。' },
      { role: 'user', content: `${personaPromptBlock(persona)}\n\nPlatform: ${platformName(platform, lang)}\nAlgorithm Signals & Advice:\n${ruleLines}\n\n${ownLine}\n${compLine}\n\nPlease provide personalized diagnosis.` },
    ], { temperature: 0.6 });
    llmText = res.text.trim();
  }

  const pctFmt = (x: number) => `${(x * 100).toFixed(1)}%`;
  const bench = compBaseline.sample > 0
    ? [
        { label: isEn ? 'Avg Views' : '平均播放', own: baseline.avgViews, comp: compBaseline.avgViews, fmt: (x: number) => fmtNum(x) },
        { label: isEn ? 'Like Rate' : '点赞率', own: baseline.likeRate, comp: compBaseline.likeRate, fmt: pctFmt },
        { label: isEn ? 'Comment Rate' : '评论率', own: baseline.commentRate, comp: compBaseline.commentRate, fmt: pctFmt },
        { label: isEn ? 'Bookmark Rate' : '收藏率', own: baseline.collectRate, comp: compBaseline.collectRate, fmt: pctFmt },
        { label: isEn ? 'Share Rate' : '转发率', own: baseline.shareRate, comp: compBaseline.shareRate, fmt: pctFmt },
      ]
    : [];

  const aiSource = aiSourceOf(platform);

  return (
    <>
      <div className="row" style={{ gap: 8, marginBottom: 14, padding: '10px 14px', background: 'var(--surface-2)', borderRadius: 10, alignItems: 'flex-start' }}>
        <Icon.shield size={16} className="" />
        <span className="small muted">
          {isEn ? (
            <>
              Disclaimer: Platform algorithms are dynamic black boxes. Conclusions are presented by credibility tier (Official / Open Source / Consensus / Rumor) as directional suggestions, not virality guarantees. Rumored parameters are excluded from diagnosis by default.
              While drafting, get real-time diagnostics and one-click optimization in <Link href="/studio" style={{ color: 'var(--brand)' }}>Studio</Link>.
            </>
          ) : (
            <>
              免责：平台算法是黑盒且会变，本页结论按可信度分级呈现（官方披露 / 开源代码 / 行业共识 / 坊间传闻），仅为方向性建议，非「上热门」承诺。传闻级具体参数（流量池阈值等）默认不进诊断。
              写稿时可在 <Link href="/studio" style={{ color: 'var(--brand)' }}>创作工坊</Link> 获得逐条实时诊断与一键优化。
            </>
          )}
        </span>
      </div>

      <div className="tabs" style={{ marginBottom: 16 }}>
        {PLATFORM_LIST.map((p) => (
          <Link key={p.key} href={`/data?view=algorithm&platform=${p.key}`} className={`tab${p.key === platform ? ' active' : ''}`}>
            {platformName(p.key, lang)}
          </Link>
        ))}
      </div>

      <Card title={isEn ? `${platformName(platform, lang)} · Algorithm Signals & Weights` : `${platformName(platform)} · 算法信号与权重`} sub={isEn ? 'Ordered by weight high to low' : '按权重从高到低'} style={{ marginBottom: 16 }}>
        {rules.length === 0 ? (
          <Empty icon="📡" text={isEn ? 'No algorithm rule data for this platform yet' : '该平台暂无算法规则库数据'} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{isEn ? 'Signal' : '信号'}</th>
                  <th style={{ width: 160 }}>{isEn ? 'Weight' : '权重'}</th>
                  <th>{isEn ? 'Content Format' : '内容形态'}</th>
                  <th>{isEn ? 'Credibility' : '可信度'}</th>
                  <th>{isEn ? 'Advice' : '建议'}</th>
                  <th>{isEn ? 'Source' : '来源'}</th>
                </tr>
              </thead>
              <tbody>
                {rules.slice().sort((a, b) => (CONF_ORDER[a.confidence] ?? 9) - (CONF_ORDER[b.confidence] ?? 9) || b.weight - a.weight).map((r) => (
                  <tr key={r.id}>
                    <td className="mono small">{r.signal}</td>
                    <td><div className="row" style={{ gap: 8, alignItems: 'center' }}><div style={{ flex: 1 }}><Meter value={r.weight * 100} /></div><span className="small mono">{Math.round(r.weight * 100)}</span></div></td>
                    <td className="small">{contentTypeName(r.contentType, isEn)}</td>
                    <td><ConfidenceBadge level={r.confidence} /></td>
                    <td className="small" style={{ maxWidth: 320 }}>{r.advice}</td>
                    <td className="small muted">{r.source ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {aiSource && (
        <Card
          title={isEn ? `${platformName(platform, lang)} · Ingestion by AI Search Engines` : `${platformName(platform)} · 会不会被 AI 引擎抠走当答案`}
          sub={isEn ? `Third-party benchmarks · Data as of ${aiSource.asOf} · Read-only reference` : `第三方统计口径 · ${aiSource.asOf} 年数据 · 只读参考`}
          style={{ marginBottom: 16 }}
        >
          <div className="stack" style={{ gap: 10 }}>
            <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
              {aiSource.coverage === 'yes' ? (
                <><span className="badge badge-brand">{isEn ? `${aiSource.engine} source` : `${aiSource.engine} 的信源`}</span><ConfidenceBadge level={aiSource.confidence ?? ''} /></>
              ) : (
                <span className="badge badge-gray" title={AI_SOURCE_UNKNOWN_NOTE}>{isEn ? 'Unverified' : '未核实'}</span>
              )}
            </div>
            <div className="small" style={{ lineHeight: 1.6 }}>{aiSource.note}</div>
            {aiSource.caveat && (<div className="row" style={{ gap: 6, alignItems: 'flex-start' }}><Icon.info size={14} className="" /><span className="small">{aiSource.caveat}</span></div>)}
            {aiSource.coverage === 'unknown' && (<div className="small muted" style={{ lineHeight: 1.6 }}>{AI_SOURCE_UNKNOWN_NOTE}</div>)}
            <div className="small muted">{isEn ? `Source: ${aiSource.source} · Year ${aiSource.asOf} · Table v${AI_SOURCE_VERSION}` : `来源：${aiSource.source} · 口径 ${aiSource.asOf} 年 · 表版本 ${AI_SOURCE_VERSION}`}</div>
            <div className="small muted" style={{ lineHeight: 1.6 }}>
              {isEn
                ? 'Why this is informational only and not included in pre-publish checklists: evidence comes from third-party industry consensus rather than official platform disclosures, with verified empirical data on only 3 of 8 platforms.'
                : '为什么它只是参考、不出现在下面的发布前 Checklist 与教练诊断里：证据是第三方统计口径（行业共识级，非平台官方披露），而且八个平台里只有三格有实证。把「还没人统计过」当成结论去勾，比不写更容易误导。'}
            </div>
          </div>
        </Card>
      )}

      <Card
        title={isEn ? 'Competitor Benchmark Comparison' : '竞对基准对比'}
        sub={compBaseline.sample > 0 ? (isEn ? `Based on ${compIds.length} competitors · ${compBaseline.sample} collected posts` : `基于 ${compIds.length} 个竞对 · ${compBaseline.sample} 条已采集作品`) : (isEn ? 'No competitor data' : '暂无竞对数据')}
        style={{ marginBottom: 16 }}
      >
        {compBaseline.sample === 0 ? (
          <div className="small muted">
            {isEn ? (
              <>
                No competitor posts collected yet for this platform. Go to <Link href="/competitors" style={{ color: 'var(--brand)' }}>Competitor Tracking</Link>{' '}
                to add and scrape {platformName(platform, lang)} competitors, and comparative benchmarks with coaching advice will appear here.
              </>
            ) : (
              <>
                还没采集到该平台竞对的作品数据。去 <Link href="/competitors" style={{ color: 'var(--brand)' }}>竞对监控</Link>{' '}
                添加并采集 {platformName(platform)} 竞对后，这里会显示「你 vs 竞对」的对标基准，教练也会据此给出对标建议。
              </>
            )}
          </div>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{isEn ? 'Metric' : '指标'}</th>
                    <th>{isEn ? 'You' : '你'}</th>
                    <th>{isEn ? 'Competitor Benchmark' : '竞对基准'}</th>
                    <th>{isEn ? 'Comparison' : '对比'}</th>
                  </tr>
                </thead>
                <tbody>
                  {bench.map((r) => {
                    const gap = baseline.sample === 0 || r.own === null || r.comp === null || r.comp === 0 ? null : (r.own - r.comp) / r.comp;
                    return (
                      <tr key={r.label}>
                        <td className="small">{r.label}</td>
                        <td className="small mono">{baseline.sample > 0 && r.own !== null ? r.fmt(r.own) : '—'}</td>
                        <td className="small mono">{r.comp === null ? '—' : r.fmt(r.comp)}</td>
                        <td className="small mono">{gap === null ? <span className="muted">—</span> : <span style={{ color: gap >= 0 ? 'var(--green)' : 'var(--red)' }}>{gap >= 0 ? '↑' : '↓'} {Math.abs(gap * 100).toFixed(0)}%</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="small muted" style={{ marginTop: 8 }}>
              {baseline.sample === 0
                ? (isEn ? 'You have no backfill metrics yet—use competitor benchmark as target alongside algorithm signals above.' : '你自己还没有回流数据——先以竞对基准为对标目标，配合上方算法信号执行。')
                : (isEn ? '"Comparison" indicates your performance relative to competitor benchmark; higher is better.' : '「对比」为你相对竞对基准的高低；播放/各互动率越高越好。')}
            </div>
          </>
        )}
      </Card>

      <div className="grid-asym-left">
        <Card title={isEn ? 'Pre-publish Checklist' : '发布前 Checklist'} sub={isEn ? `${platformName(platform, lang)} Final Self-Check` : `${platformName(platform)} 定稿自查`}>
          {checklist.length === 0 ? (
            <div className="small muted">{isEn ? 'No checklist for this platform yet' : '暂无该平台清单'}</div>
          ) : (
            <div className="stack" style={{ gap: 10 }}>
              {checklist.map((c, i) => (
                <div key={i} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                  <Icon.check size={16} className="" />
                  <div><div className="small">{c.text}</div><div style={{ marginTop: 3 }}><ConfidenceBadge level={c.conf} /></div></div>
                </div>
              ))}
              <div className="divider" />
              <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <Icon.check size={16} className="" />
                <div className="small">{isEn ? 'Avoid clickbait titles/covers, low-effort duplicate scraping, or coercive engagement tactics (Strictly penalized by platform rules, redline).' : '避免标题党/封面党、搬运消重、诱导互动话术（平台明令处罚，红线级）'}</div>
              </div>
            </div>
          )}
        </Card>

        <Card
          title={isEn ? 'Personalized Diagnosis' : '个性化诊断'}
          sub={baseline.sample > 0 ? (isEn ? `Based on your ${baseline.sample} ${platformName(platform, lang)} posts` : `基于你 ${baseline.sample} 条 ${platformName(platform)} 作品`) : compBaseline.sample > 0 ? (isEn ? `No own data · Referenced ${compBaseline.sample} competitor posts` : `你暂无回流 · 参照 ${compBaseline.sample} 条竞对作品`) : (isEn ? 'Insufficient samples' : '样本不足')}
        >
          {llmText && (
            <div className="small" style={{ padding: 12, background: 'var(--surface-2)', borderRadius: 10, marginBottom: 12, lineHeight: 1.6 }}>
              <div className="row" style={{ gap: 6, color: 'var(--brand)', marginBottom: 4 }}><Icon.sparkles size={14} className="" /> <b>{isEn ? 'Coach Review' : '教练点评'}</b></div>
              {llmText}
            </div>
          )}
          <div className="stack" style={{ gap: 12 }}>
            {diagnoses.map((d, i) => (
              <div key={i} className="card" style={{ padding: 12, boxShadow: 'none', background: 'var(--surface-2)' }}>
                <div className="row-between"><b className="small">{d.signal}</b><span className={`dot ${sevDot(d.severity)}`} /></div>
                <div className="small" style={{ margin: '6px 0' }}><span className="muted">{isEn ? 'Your metrics: ' : '你的数据：'}</span>{d.finding}</div>
                <div className="small" style={{ color: 'var(--text)' }}><span className="muted">{isEn ? 'Advice: ' : '建议：'}</span>{d.advice}</div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
