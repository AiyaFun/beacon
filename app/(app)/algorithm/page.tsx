import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { parseJson, type Metrics } from '@/lib/json';
import { readPersona, personaPromptBlock } from '@/lib/persona';
import { llmComplete } from '@/lib/llm/gateway';
import { PLATFORMS, PLATFORM_LIST, platformName } from '@/lib/constants';
import { fmtNum } from '@/lib/format';
import { PageHead, Card, Meter, ConfidenceBadge, Empty } from '@/components/ui';
import { Icon } from '@/components/icons';
import { diagnose, buildBaseline } from '@/lib/algorithm/coach';
import { AI_SOURCE_UNKNOWN_NOTE, AI_SOURCE_VERSION, aiSourceOf } from '@/lib/algorithm/ai-source';
import { isDemoTenant } from '@/lib/demo/guard';

export const dynamic = 'force-dynamic';

const CONF_ORDER: Record<string, number> = { official: 0, opensource: 1, consensus: 2, rumor: 3 };

export default async function AlgorithmCoachPage({
  searchParams,
}: {
  searchParams: Promise<{ platform?: string }>;
}) {
  const sp = await searchParams;
  const platform = sp.platform && sp.platform in PLATFORMS ? sp.platform : 'douyin';
  const s = await getSession();

  const [rules, ownPosts, publishRecords] = await Promise.all([
    prisma.algorithmRule.findMany({
      where: { platform, enabled: true },
      orderBy: { weight: 'desc' },
    }),
    prisma.ownPost.findMany({
      where: { accountId: s.accountId, platform },
      orderBy: { publishedAt: 'desc' },
      take: 20,
    }),
    // 发布回流也进基线：用户在数据看板登记的数据即刻生效，避免「永远样本不足」
    prisma.publishRecord.findMany({
      where: { accountId: s.accountId, platform },
      orderBy: { publishedAt: 'desc' },
      take: 20,
      select: { metrics: true },
    }),
  ]);

  const metricsList = [...ownPosts, ...publishRecords]
    .map((p) => parseJson<Metrics>(p.metrics, {}))
    .filter((m) => (m.views ?? 0) > 0);
  const baseline = buildBaseline(metricsList);
  const diagnoses = diagnose(platform, metricsList);

  // 竞对基准（三者结合之一）：本工作区订阅的该平台竞对，已采集作品的真实指标做对标基线。
  const watch = await prisma.watchlistItem.findMany({
    where: { workspaceId: s.workspaceId },
    select: { competitor: { select: { id: true, platform: true } } },
  });
  const compIds = watch.filter((w) => w.competitor.platform === platform).map((w) => w.competitor.id);
  const compPosts = compIds.length
    ? await prisma.crawledPost.findMany({
        where: { competitorId: { in: compIds }, platform },
        select: { metrics: true },
        orderBy: { hotScore: 'desc' },
        take: 60,
      })
    : [];
  const compMetrics = compPosts.map((p) => parseJson<Metrics>(p.metrics, {})).filter((m) => (m.views ?? 0) > 0);
  const compBaseline = buildBaseline(compMetrics);

  // 发布前 Checklist：把该平台每条 rule 的 advice 拆成可勾选条目（传闻级不进 Checklist，兑现免责声明）
  const trusted = rules.filter((r) => r.confidence !== 'rumor');
  const checklist = trusted.map((r) => ({ text: r.advice, conf: r.confidence }));

  // LLM 个性化诊断文案（Mock 下也能返回可用内容，永不抛错）。
  // 三者结合：①平台算法信号（公开算法信息，含可信度分级）②你自己的回流基线 ③竞对基准。
  // 只要「自有回流」或「竞对基准」任一有数据就出诊断——你自己没发过作品时，也能靠竞对基准 + 算法信号给方向。
  const account = await prisma.creatorAccount.findUnique({ where: { id: s.accountId } });
  const persona = readPersona(account?.personaCard ?? '{}');
  // 这段会进 LLM 提示词。算不出来的率**整项不写**——写成 0.0% 模型会当真实观测，
  // 然后给出「你的点赞率过低」这类基于虚构数字的诊断（抖音公开页没有播放量做分母）。
  const fmtBaseline = (b: typeof baseline) => {
    const bits: string[] = [];
    if (b.avgViews !== null) bits.push(`平均播放 ${fmtNum(b.avgViews)}`);
    bits.push(`完播/完读率 ${b.avgCompletion === null ? '无' : (b.avgCompletion * 100).toFixed(1) + '%'}`);
    if (b.likeRate !== null) bits.push(`点赞率 ${(b.likeRate * 100).toFixed(1)}%`);
    if (b.commentRate !== null) bits.push(`评论率 ${(b.commentRate * 100).toFixed(1)}%`);
    if (b.collectRate !== null) bits.push(`收藏率 ${(b.collectRate * 100).toFixed(1)}%`);
    if (b.shareRate !== null) bits.push(`转发率 ${(b.shareRate * 100).toFixed(1)}%`);
    if (b.avgViews === null) bits.push('（该平台公开页面不提供播放量，率类指标不可得；点赞/评论/收藏/转发的绝对数是真实的）');
    return bits.join('，');
  };
  let llmText = '';
  // 演示租户禁止 LLM 生成（assertNotDemo 会抛错）——原逻辑靠 sample>0 恰好避开，
  // 现在加了竞对基准触发条件，必须显式跳过 demo，否则演示模式访问本页直接报错。
  if ((baseline.sample > 0 || compBaseline.sample > 0) && !isDemoTenant(s.tenantId)) {
    const ruleLines = trusted
      .map((r) => `- ${r.signal}（权重${Math.round(r.weight * 100)}/100）：${r.advice}`)
      .join('\n');
    const ownLine =
      baseline.sample > 0
        ? `你自己（${baseline.sample} 条）：${fmtBaseline(baseline)}`
        : '你自己：暂无回流数据（还没登记/采集到自己作品的表现）';
    const compLine =
      compBaseline.sample > 0
        ? `竞对基准（${compBaseline.sample} 条已采集作品）：${fmtBaseline(compBaseline)}`
        : '竞对基准：暂无该平台竞对作品数据';
    const res = await llmComplete(
      s.tenantId,
      'diagnosis',
      [
        {
          role: 'system',
          content:
            '你是平台算法教练。结合三方证据给方向性建议：①平台算法信号与权重（公开算法信息）②该账号自己的历史回流 ③同平台竞对的真实表现基准。' +
            '禁止「保证上热门」类承诺。用中文，3-4 句：先指出该账号相对竞对基准/健康线在第一权重信号上的最大短板（可引用具体数字对比），' +
            '再给一条最该先做的动作。若该账号暂无自有数据，就以竞对基准为参照给出对标建议。',
        },
        {
          role: 'user',
          content:
            `${personaPromptBlock(persona)}\n\n平台：${platformName(platform)}\n` +
            `该平台算法信号与建议：\n${ruleLines}\n\n${ownLine}\n${compLine}\n\n请给一段个性化诊断。`,
        },
      ],
      { temperature: 0.6 },
    );
    llmText = res.text.trim();
  }

  // 竞对基准对比表数据（你 vs 竞对）
  const pctFmt = (x: number) => `${(x * 100).toFixed(1)}%`;
  const bench =
    compBaseline.sample > 0
      ? [
          { label: '平均播放', own: baseline.avgViews, comp: compBaseline.avgViews, fmt: (x: number) => fmtNum(x) },
          { label: '点赞率', own: baseline.likeRate, comp: compBaseline.likeRate, fmt: pctFmt },
          { label: '评论率', own: baseline.commentRate, comp: compBaseline.commentRate, fmt: pctFmt },
          { label: '收藏率', own: baseline.collectRate, comp: compBaseline.collectRate, fmt: pctFmt },
          { label: '转发率', own: baseline.shareRate, comp: compBaseline.shareRate, fmt: pctFmt },
        ]
      : [];

  // AI 引擎信源口径（纯常量，不查库）。
  //
  // ⚠️ 它**只用于渲染下面那张只读小卡**，不许再往别处接：
  //   ① 不进上面的 trusted / checklist —— 那是「发布前逐条勾」的清单，八个平台里只有三格有实证，
  //      把「没统计过」变成一个可勾选项，比不写更误导；
  //   ② 不进 llmComplete 的提示词 —— 六格 unknown 喂给模型，它会自动把「没数据」讲成
  //      「这个平台对 AI 不可见」，那是凭空造结论（本库在 hotScore 上刚为「缺席当 0」栽过一次）。
  // tests/algorithm/ai-source.test.ts 有源码级守卫盯着这两条。
  const aiSource = aiSourceOf(platform);

  return (
    <>
      <PageHead
        title="平台算法教练"
        desc="学习每个平台的分发算法，按平台给差异化优化建议"
      />

      <div
        className="row"
        style={{ gap: 8, marginBottom: 14, padding: '10px 14px', background: 'var(--surface-2)', borderRadius: 10, alignItems: 'flex-start' }}
      >
        <Icon.shield size={16} className="" />
        <span className="small muted">
          免责：平台算法是黑盒且会变，本页结论按可信度分级呈现（官方披露 / 开源代码 / 行业共识 / 坊间传闻），仅为方向性建议，非「上热门」承诺。传闻级具体参数（流量池阈值等）默认不进诊断。
          写稿时可在 <Link href="/studio" style={{ color: 'var(--brand)' }}>创作工坊</Link> 获得逐条实时诊断与一键优化。
        </span>
      </div>

      {/* 平台选择 tab */}
      <div className="tabs" style={{ marginBottom: 16 }}>
        {PLATFORM_LIST.map((p) => (
          <Link
            key={p.key}
            href={`/algorithm?platform=${p.key}`}
            className={`tab${p.key === platform ? ' active' : ''}`}
          >
            {p.name}
          </Link>
        ))}
      </div>

      {/* 算法信号与权重表 */}
      <Card
        title={`${platformName(platform)} · 算法信号与权重`}
        sub="按权重从高到低"
        style={{ marginBottom: 16 }}
      >
        {rules.length === 0 ? (
          <Empty icon="📡" text="该平台暂无算法规则库数据" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>信号</th>
                  <th style={{ width: 160 }}>权重</th>
                  <th>内容形态</th>
                  <th>可信度</th>
                  <th>建议</th>
                  <th>来源</th>
                </tr>
              </thead>
              <tbody>
                {rules
                  .slice()
                  .sort((a, b) => (CONF_ORDER[a.confidence] ?? 9) - (CONF_ORDER[b.confidence] ?? 9) || b.weight - a.weight)
                  .map((r) => (
                    <tr key={r.id}>
                      <td className="mono small">{r.signal}</td>
                      <td>
                        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                          <div style={{ flex: 1 }}>
                            <Meter value={r.weight * 100} />
                          </div>
                          <span className="small mono">{Math.round(r.weight * 100)}</span>
                        </div>
                      </td>
                      <td className="small">{contentTypeName(r.contentType)}</td>
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

      {/* AI 引擎信源：这个平台的内容会不会被 AI 抠走当答案。
          只读参考栏——刻意长在「算法信号」之后、「竞对基准」之前：它回答的是另一个问题
          （不是「平台推不推你」而是「机器引不引你」），但证据强度够不上进结论区。 */}
      {aiSource && (
        <Card
          title={`${platformName(platform)} · 会不会被 AI 引擎抠走当答案`}
          sub={`第三方统计口径 · ${aiSource.asOf} 年数据 · 只读参考`}
          style={{ marginBottom: 16 }}
        >
          <div className="stack" style={{ gap: 10 }}>
            <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
              {aiSource.coverage === 'yes' ? (
                <>
                  <span className="badge badge-brand">{aiSource.engine} 的信源</span>
                  <ConfidenceBadge level={aiSource.confidence ?? ''} />
                </>
              ) : (
                // 「未核实」不是「不覆盖」。这个 badge 的文案与 title 都要顶得住这句反问：
                // 用户看完会不会以为「这个平台发了也白发」？会的话就是写错了。
                <span className="badge badge-gray" title={AI_SOURCE_UNKNOWN_NOTE}>
                  未核实
                </span>
              )}
            </div>
            <div className="small" style={{ lineHeight: 1.6 }}>{aiSource.note}</div>
            {aiSource.caveat && (
              <div className="row" style={{ gap: 6, alignItems: 'flex-start' }}>
                <Icon.info size={14} className="" />
                <span className="small">{aiSource.caveat}</span>
              </div>
            )}
            {aiSource.coverage === 'unknown' && (
              <div className="small muted" style={{ lineHeight: 1.6 }}>{AI_SOURCE_UNKNOWN_NOTE}</div>
            )}
            <div className="small muted">
              来源：{aiSource.source} · 口径 {aiSource.asOf} 年 · 表版本 {AI_SOURCE_VERSION}
            </div>
            <div className="small muted" style={{ lineHeight: 1.6 }}>
              为什么它只是参考、不出现在下面的发布前 Checklist 与教练诊断里：证据是第三方统计口径（行业共识级，非平台官方披露），
              而且八个平台里只有三格有实证。把「还没人统计过」当成结论去勾，比不写更容易误导。
            </div>
          </div>
        </Card>
      )}

      {/* 竞对基准对比（三者结合：你的回流 × 竞对真实表现 × 平台算法信号） */}
      <Card
        title="竞对基准对比"
        sub={compBaseline.sample > 0 ? `基于 ${compIds.length} 个竞对 · ${compBaseline.sample} 条已采集作品` : '暂无竞对数据'}
        style={{ marginBottom: 16 }}
      >
        {compBaseline.sample === 0 ? (
          <div className="small muted">
            还没采集到该平台竞对的作品数据。去 <Link href="/competitors" style={{ color: 'var(--brand)' }}>竞对监控</Link>{' '}
            添加并采集 {platformName(platform)} 竞对后，这里会显示「你 vs 竞对」的对标基准，教练也会据此给出对标建议。
          </div>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>指标</th>
                    <th>你</th>
                    <th>竞对基准</th>
                    <th>对比</th>
                  </tr>
                </thead>
                <tbody>
                  {bench.map((r) => {
                    // 任一侧算不出来（该平台不给播放量）就不出对比结论。
                    // 拿 0 去比会得出「↓100%」这种看着很确凿、实则纯属虚构的差距。
                    const gap =
                      baseline.sample === 0 || r.own === null || r.comp === null || r.comp === 0
                        ? null
                        : (r.own - r.comp) / r.comp;
                    return (
                      <tr key={r.label}>
                        <td className="small">{r.label}</td>
                        <td className="small mono">{baseline.sample > 0 && r.own !== null ? r.fmt(r.own) : '—'}</td>
                        <td className="small mono">{r.comp === null ? '—' : r.fmt(r.comp)}</td>
                        <td className="small mono">
                          {gap === null ? (
                            <span className="muted">—</span>
                          ) : (
                            <span style={{ color: gap >= 0 ? 'var(--green)' : 'var(--red)' }}>
                              {gap >= 0 ? '↑' : '↓'} {Math.abs(gap * 100).toFixed(0)}%
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="small muted" style={{ marginTop: 8 }}>
              {baseline.sample === 0
                ? '你自己还没有回流数据——先以竞对基准为对标目标，配合上方算法信号执行。'
                : '「对比」为你相对竞对基准的高低；播放/各互动率越高越好。'}
            </div>
          </>
        )}
      </Card>

      <div className="grid-asym-left">
        {/* 发布前 Checklist */}
        <Card title="发布前 Checklist" sub={`${platformName(platform)} 定稿自查`}>
          {checklist.length === 0 ? (
            <div className="small muted">暂无该平台清单</div>
          ) : (
            <div className="stack" style={{ gap: 10 }}>
              {checklist.map((c, i) => (
                <div key={i} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                  <Icon.check size={16} className="" />
                  <div>
                    <div className="small">{c.text}</div>
                    <div style={{ marginTop: 3 }}>
                      <ConfidenceBadge level={c.conf} />
                    </div>
                  </div>
                </div>
              ))}
              <div className="divider" />
              <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <Icon.check size={16} className="" />
                <div className="small">避免标题党/封面党、搬运消重、诱导互动话术（平台明令处罚，红线级）</div>
              </div>
            </div>
          )}
        </Card>

        {/* 个性化诊断 */}
        <Card
          title="个性化诊断"
          sub={
            baseline.sample > 0
              ? `基于你 ${baseline.sample} 条 ${platformName(platform)} 作品`
              : compBaseline.sample > 0
                ? `你暂无回流 · 参照 ${compBaseline.sample} 条竞对作品`
                : '样本不足'
          }
        >
          {llmText && (
            <div
              className="small"
              style={{ padding: 12, background: 'var(--surface-2)', borderRadius: 10, marginBottom: 12, lineHeight: 1.6 }}
            >
              <div className="row" style={{ gap: 6, color: 'var(--brand)', marginBottom: 4 }}>
                <Icon.sparkles size={14} className="" /> <b>教练点评</b>
              </div>
              {llmText}
            </div>
          )}
          <div className="stack" style={{ gap: 12 }}>
            {diagnoses.map((d, i) => (
              <div key={i} className="card" style={{ padding: 12, boxShadow: 'none', background: 'var(--surface-2)' }}>
                <div className="row-between">
                  <b className="small">{d.signal}</b>
                  <span className={`dot ${sevDot(d.severity)}`} />
                </div>
                <div className="small" style={{ margin: '6px 0' }}>
                  <span className="muted">你的数据：</span>{d.finding}
                </div>
                <div className="small" style={{ color: 'var(--text)' }}>
                  <span className="muted">建议：</span>{d.advice}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}

function contentTypeName(t: string): string {
  const map: Record<string, string> = {
    short_video: '短视频',
    image_text: '图文',
    article: '长图文',
    long_video: '中长视频',
    short_text: '短文本',
    all: '通用',
  };
  return map[t] ?? t;
}

function sevDot(sev: string): string {
  if (sev === 'good') return 'dot-green';
  if (sev === 'bad') return 'dot-red';
  return 'dot-amber';
}
