import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { parseJson, toJson, type Metrics } from '@/lib/json';
import { platformName, platformColor } from '@/lib/constants';
import { fmtNum, fmtDate } from '@/lib/format';
import { PageHead, Card, Stat, Meter, Empty } from '@/components/ui';
import { Icon } from '@/components/icons';
import { CopyText } from '@/components/CopyText';
import { Backfill } from './Backfill';
import { MetricsUpdater } from './MetricsUpdater';
import { AttachUrl } from './AttachUrl';
import { ImportPosts } from './ImportPosts';
import { DataFilters } from './DataFilters';
import { ExportButton } from './ExportButton';
import { TrendCell } from './TrendCell';
import { ReviewCell } from './ReviewCell';
import { accountPlatformProfiles } from '@/lib/insight/learn';
import { checkDataHealth, type HealthIssue } from '@/lib/insight/health-check';
import { analyzePublishTiming } from '@/lib/insight/timing';
import { sourceTier, SOURCE_TIER_LABEL } from '@/lib/insight/csv';
import { GrowthBoard } from '@/components/GrowthBoard';
import { loadSelfGrowth, WINDOW_KEYS } from '@/lib/insight/growth-rows';
import type { WindowKey } from '@/lib/insight/growth';
import { parseRange, filterRecordsByRange, filterByPlatform, prevPeriodRecords } from '@/lib/insight/dashboard-filter';
import { decisionQuality } from '@/lib/insight/decision-quality';
import { topicClashRate, complianceFalsePositiveRate, type GuardrailValue } from '@/lib/insight/guardrails';
import { authoritativeMetrics, pickAuthoritativeSnapshot } from '@/lib/insight/source-priority';
import type { WeeklyReview, ArticleReview } from '@/lib/insight/review';
import { WeeklyReviewCard } from './WeeklyReviewCard';
import { OffscreenDataHint, type ElsewhereAccount } from './OffscreenDataHint';
import { followerSeries, readAudience } from '@/lib/ingest/own-account';
import { AudienceCard } from './AudienceCard';
import { DataIllumination, type IlluminationSignal } from './DataIllumination';
import { CollectionRuns } from '@/components/CollectionRuns';
import { listCollectionRuns } from '@/lib/ingest/collection-run';
import { publicItemUrl } from '@/lib/publish/parse-url';
import { readerQuestionsByWork } from '@/lib/insight/reader-questions';
import { readerVoice, readerCommentsByWork } from '@/lib/insight/reader-voice';
import { COMMENT_TEXT_PURGE_DAYS } from '@/lib/comment-collect-rules';
import { ReaderVoice } from '@/components/ReaderVoice';
import { PageTabs } from '@/components/PageTabs';
import { EffectTabs } from '@/components/insight/EffectTabs';
import { GenesPanel } from '@/components/insight/GenesPanel';
import { AlgorithmPanel } from '@/components/insight/AlgorithmPanel';
import { HubHeader } from '@/components/HubHeader';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

export default async function DataPage({
  searchParams,
}: {
  searchParams: Promise<{ [k: string]: string | string[] | undefined }>;
}) {
  const s = await getSession();
  const sp = await searchParams;

  // 「看效果」三合一（2026-08-25）：爆款基因 /genes、平台算法教练 /algorithm 并进本页。
  // 顶层用 view 参数切换，**只渲染当前 tab**——「平台怎么想」会调 LLM，全渲染会白烧调用，
  // 所以走早返回：view=genes/algorithm 时直接出对应 Panel（各自取数），不跑下面 /data 的重取数。
  const view = sp.view === 'genes' || sp.view === 'algorithm' ? sp.view : 'data';
  if (view !== 'data') {
    return (
      <>
        <HubHeader
          title="看效果"
          hint="发完之后回答三件事：跑得怎么样、什么样的跑得动、平台为什么这么推"
          tabs={<EffectTabs active={view} inline />}
        />
        {view === 'genes' ? (
          <GenesPanel />
        ) : (
          <AlgorithmPanel platform={typeof sp.platform === 'string' ? sp.platform : undefined} />
        )}
      </>
    );
  }

  const range = parseRange(typeof sp.range === 'string' ? sp.range : undefined);
  const platformFilter = typeof sp.platform === 'string' ? sp.platform : 'all';
  const page = Math.max(1, parseInt(typeof sp.page === 'string' ? sp.page : '1', 10) || 1);
  // 增长区块的时间窗。与本页既有的 range/platform/page 共用 query string，互不干扰
  const windowKey: WindowKey = (WINDOW_KEYS as string[]).includes(typeof sp.window === 'string' ? sp.window : '')
    ? (sp.window as WindowKey)
    : '7d';

  const [records, ownPosts, activeAccounts, profiles, learnedMemories, account] = await Promise.all([
    prisma.publishRecord.findMany({
      where: { accountId: s.accountId },
      include: { snapshots: { orderBy: { takenAt: 'desc' } } },
      orderBy: { publishedAt: 'desc' },
    }),
    prisma.ownPost.findMany({ where: { accountId: s.accountId } }),
    prisma.creatorAccount.count({ where: { workspaceId: s.workspaceId, status: 'active' } }),
    accountPlatformProfiles(s.accountId),
    prisma.memoryEntry.findMany({
      where: { workspaceId: s.workspaceId, accountId: s.accountId, type: { in: ['performance', 'preference'] } },
      orderBy: [{ active: 'desc' }, { confidence: 'desc' }, { updatedAt: 'desc' }],
      take: 8,
    }),
    prisma.creatorAccount.findUnique({ where: { id: s.accountId } }),
  ]);

  // 采集台账（自有）：每次回填覆盖了哪几天。按工作区取而不是按当前账号——
  // 「数据记到别的号名下了」正是这页最常见的困惑，台账里把账号名摆出来才答得了它。
  const collectionRuns = await listCollectionRuns(s.workspaceId, { scope: 'self', take: 30 });

  // 每条作品下「读者在问什么」（评论采集的提问，按 platformItemId 挂回作品行）。
  // 指标 × 提问并排看才有诊断价值：完读率低+评论区在问概念 = 没讲清；
  // 点赞高+催更 = 系列化信号。取数与口径见 lib/insight/reader-questions.ts。
  const readerQs = await readerQuestionsByWork(s.workspaceId, s.accountId);

  // 读者原声（评论正文，与上面的提问是两条链路）。提问回答「他们卡在哪」，
  // 原声回答「他们原话是怎么说的」——后者是任何聚合都会压缩掉的东西。
  const [voice, commentsByWork] = await Promise.all([
    readerVoice(s.workspaceId, { scope: 'own', accountId: s.accountId }),
    readerCommentsByWork(s.workspaceId, s.accountId),
  ]);

  // 自有增长（账号涨粉 + 单条作品）。竞对增长在竞对监控页。
  const { rows: growthRows, hasAny: hasGrowth } = await loadSelfGrowth(s.accountId, windowKey);
  // 切时间窗时要带上本页既有的筛选，否则一点就把用户的时间段/平台筛选清掉了
  const qsBase = [
    typeof sp.range === 'string' ? `range=${encodeURIComponent(sp.range)}` : '',
    platformFilter !== 'all' ? `platform=${encodeURIComponent(platformFilter)}` : '',
  ].filter(Boolean).join('&');
  // 在服务端算好三条链接再传下去。GrowthBoard 是客户端组件，**不能收函数**
  // （Next 会在渲染时抛 "Functions cannot be passed directly to Client Components"）。
  const windowHrefs = Object.fromEntries(
    // 带上 tab=growth：本页分了页签之后，不带它会切完时间窗跳回「总览」，
    // 用户看到的是「我点了 30 天，怎么又回去了」。
    WINDOW_KEYS.map((k) => [k, `/data?${qsBase ? qsBase + '&' : ''}window=${k}&tab=growth#growth`]),
  );

  const dq = await decisionQuality(s.accountId, s.workspaceId);
  // 最近一份周报（周任务生成，此前在 app 里没有任何入口——通知点进来找不到本体）
  const weeklyRow = await prisma.reviewReport.findFirst({
    where: { accountId: s.accountId, kind: 'weekly' },
    orderBy: { createdAt: 'desc' },
    select: { content: true },
  });
  const weekly = weeklyRow ? parseJson<WeeklyReview | null>(weeklyRow.content, null) : null;

  // 已存的单篇复盘：此前生成后落了库却**从不再读**——组件只把当次返回值放在 useState 里，
  // 刷新页面就退回「🔮 AI 复盘」按钮，用户以为没生成过，再点一次又烧一份额度。
  // 这里按 refId 取回来，让存量复盘直接可看。
  const articleReviewRows = await prisma.reviewReport.findMany({
    where: { accountId: s.accountId, kind: 'article', refId: { in: records.map((r) => r.id) } },
    orderBy: { createdAt: 'desc' },
    select: { refId: true, content: true },
  });
  // 同一篇可能有多份（重新生成过），orderBy desc + 首次写入优先 = 保留最新那份
  const storedReviews = new Map<string, ArticleReview>();
  for (const row of articleReviewRows) {
    if (!row.refId || storedReviews.has(row.refId)) continue;
    const parsed = parseJson<ArticleReview | null>(row.content, null);
    if (parsed) storedReviews.set(row.refId, parsed);
  }

  const now = Date.now();
  const verifiedAngles = parseJson<{ topic?: string[] }>(account?.styleFingerprint ?? '{}', {}).topic ?? [];
  const availablePlatforms = [...new Set(records.map((r) => r.platform))];

  // 账号级数据（粉丝曲线 + 受众画像）。平台跟随当前筛选：账号可能同时经营多个平台，
  // 把不同平台的粉丝混在一条曲线上没有意义。未筛选时取该账号发得最多的那个平台。
  const audiencePlatform =
    platformFilter !== 'all'
      ? platformFilter
      : (profiles[0]?.platform ?? availablePlatforms[0] ?? 'douyin');
  // 两条安全线（撞题率 / 合规误报率）现算：都是本工作区内可算的真实数字，
  // 样本不足时返回 insufficient，由 UI 如实说「为什么没有数」而不是显示 0。
  const [clashRate, fpRate] = await Promise.all([
    topicClashRate(s.workspaceId, s.accountId).catch((): GuardrailValue => ({ state: 'insufficient', note: '统计失败，稍后再看' })),
    complianceFalsePositiveRate(s.tenantId).catch((): GuardrailValue => ({ state: 'insufficient', note: '统计失败，稍后再看' })),
  ]);

  const [followerPoints, audienceBuckets] = await Promise.all([
    followerSeries(s.accountId, audiencePlatform),
    readAudience(s.accountId, audiencePlatform),
  ]);

  // 数据体检在全量记录上做（数据质量与时间段无关）
  const healthIssues = checkDataHealth(records, now);

  // 记在**本工作区其它账号**名下的作品数。本页所有查询都按 accountId 过滤，
  // 挂错账号 = 这页永远看不见（2026-07-25 与 07-27 两次真机事故都是这个），
  // 而插件在没有对应平台账号时会自动建号，新数据自然落在那个新号名下。
  // 只查数量与账号名，不把别人账号的内容读进来。
  const elsewhereRows = await prisma.publishRecord.groupBy({
    by: ['accountId'],
    where: { accountId: { not: s.accountId }, account: { workspaceId: s.workspaceId } },
    _count: { _all: true },
  });
  const elsewhereAccounts = elsewhereRows.length
    ? await prisma.creatorAccount.findMany({
        where: { id: { in: elsewhereRows.map((r) => r.accountId) } },
        select: { id: true, name: true, platform: true },
      })
    : [];
  const recordsElsewhere: ElsewhereAccount[] = elsewhereAccounts.map((a) => ({
    id: a.id,
    name: a.name,
    platformLabel: platformName(a.platform),
    count: elsewhereRows.find((r) => r.accountId === a.id)?._count._all ?? 0,
  }));

  // 时间段 + 平台筛选（页面与导出共用口径）
  const scoped = filterByPlatform(filterRecordsByRange(records, range, now), platformFilter);
  const prevScoped = filterByPlatform(prevPeriodRecords(records, range, now), platformFilter);

  // 全页统一走「来源优先级」取数：官方 > 插件 > 手填（同一逻辑日内比较，跨天不比）。
  // PublishRecord.metrics 是「谁最后写谁说了算」的值——用户随手补的一个约数会盖掉适配器
  // 拉回来的精确值。此前本页顶格数字用的就是它，而同页的趋势曲线、AI 复盘、爆款预警、
  // learn 的结论早已改走优先级，于是「表格里 900、曲线上 5000」这种自相矛盾是可能出现的。
  // 口径分裂比数值不准更糟：用户无法判断该信哪个。这里统一到与结论一致的那份。
  const authOf = new Map(
    records.map((r) => [r.id, authoritativeMetrics(r.metrics, r.snapshots, r.publishedAt)] as const),
  );
  const metricsOf = (r: { id: string }) => authOf.get(r.id) ?? {};
  const viewsOf = (r: { id: string }) => metricsOf(r).views ?? 0;
  const interactionsOf = (r: { id: string }) => {
    const m = metricsOf(r);
    return (m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0) + (m.collects ?? 0);
  };
  const sumViews = (list: typeof records) => list.reduce((sum, r) => sum + viewsOf(r), 0);

  const totalViews = sumViews(scoped);
  const totalInteractions = scoped.reduce((sum, r) => sum + interactionsOf(r), 0);
  const publishCount = scoped.length;
  const recommendRecords = scoped.filter((r) => r.fromRecommend);
  const selfRecords = scoped.filter((r) => !r.fromRecommend);
  const adoptedPublished = recommendRecords.length;

  // 环比（仅在有限时间段下有意义）
  const prevViews = sumViews(prevScoped);
  const viewsDeltaPct = prevViews > 0 ? Math.round(((totalViews - prevViews) / prevViews) * 100) : null;

  const accounts = Math.max(1, activeAccounts);
  const northStar = (adoptedPublished / accounts).toFixed(1);

  const baselineViews =
    ownPosts.length > 0
      ? ownPosts.reduce((sum, p) => sum + (parseJson<Metrics>(p.metrics, {}).views ?? 0), 0) / ownPosts.length
      : publishCount > 0
        ? totalViews / publishCount
        : 0;
  const aboveBaseline = scoped.filter((r) => viewsOf(r) > baselineViews).length;
  const aboveBaselinePct = publishCount > 0 ? Math.round((aboveBaseline / publishCount) * 100) : 0;

  const avg = (list: typeof records) =>
    list.length > 0 ? Math.round(list.reduce((sum, r) => sum + viewsOf(r), 0) / list.length) : 0;
  const recAvg = avg(recommendRecords);
  const selfAvg = avg(selfRecords);
  const lift = selfAvg > 0 ? Math.round(((recAvg - selfAvg) / selfAvg) * 100) : 0;
  const maxAvg = Math.max(recAvg, selfAvg, 1);
  const hasBothSamples = recommendRecords.length > 0 && selfRecords.length > 0 && selfAvg > 0;
  const liftPositive = hasBothSamples && lift > 0;

  // 发布时段分析
  // 时段分析同样吃优先级后的值：否则「几点发效果好」的结论建立在被手填盖过的数上
  const timing = analyzePublishTiming(
    scoped.map((r) => ({ publishedAt: r.publishedAt, metrics: toJson(metricsOf(r)) })),
  );
  const maxSlotViews = Math.max(1, ...timing.hourSlots.map((slot) => slot.avgViews));

  // 分页（渲染层）
  const pageCount = Math.max(1, Math.ceil(scoped.length / PAGE_SIZE));
  const curPage = Math.min(page, pageCount);
  const pageRecords = scoped.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE);

  const qs = (over: Record<string, string>) => {
    const p = new URLSearchParams();
    p.set('range', range);
    p.set('platform', platformFilter);
    for (const [k, v] of Object.entries(over)) p.set(k, v);
    return `?${p.toString()}`;
  };

  return (
    <>
      <HubHeader
        title="看效果"
        hint="发布登记 + 多通道数据回流，看清每篇内容前 7 天的真实增长"
        tabs={<EffectTabs active="data" inline />}
        action={<ExportButton range={range} platform={platformFilter} />}
      />

      <div style={{ marginBottom: 16 }}>
        <DataFilters platforms={availablePlatforms} range={range} platform={platformFilter} />
      </div>

      {/* 数据点亮进度：四个真实数据源信号，未全亮时引导用户去点亮（全亮自动隐藏） */}
      <DataIllumination
        signals={[
          { key: 'posts', label: '作品表现数据', lit: records.length > 0, how: '装插件在作品页一键回填，或用下方「手动回填」登记第一条' },
          { key: 'history', label: '历史作品基线', lit: ownPosts.length > 0, how: '用下方「导入历史作品」上传 CSV，建立你的历史水位' },
          { key: 'followers', label: '粉丝增长数据', lit: followerPoints.length > 0, how: '在创作者后台「粉丝分析」页用插件回填；在自己的主页上点回填也能记下当天的粉丝数' },
          { key: 'audience', label: '受众画像', lit: audienceBuckets != null, how: '同上，创作者后台「粉丝/受众分析」页用插件回填' },
        ] satisfies IlluminationSignal[]}
      />

      {/* ⚠️ 「回填成功，但看板上什么都没有」——真机 2026-07-27 又撞到一次。
          本页有两道**完全静默**的过滤，任何一道命中都长这个样：
            ① accountId：记录压根不查出来（数据挂在别的账号名下，这页永远看不见）；
            ② 时间范围：默认只看近 30 天，而插件现在能读到作品的**真实发表时间**了——
               回填一批半年前的老作品，条条都在窗口外，表格就是空的。
          数据在库里躺着，用户却只看到一句「已回填 N 条」和一个空页面，无从判断是哪一种。
          所以这里把两种情况都说破，并给出可点的下一步。 */}
      <OffscreenDataHint
        totalForAccount={records.length}
        visible={scoped.length}
        range={range}
        platformFilter={platformFilter}
        elsewhere={recordsElsewhere}
      />

      {/* 数据体检 */}
      {healthIssues.length > 0 && (
        <Card title="🩺 数据体检" sub="检测到需要你确认的数据问题 · 只提示不自动改" style={{ marginBottom: 16 }}>
          <div className="stack" style={{ gap: 10 }}>
            {healthIssues.map((issue) => (
              <HealthRow key={issue.kind} issue={issue} />
            ))}
          </div>
        </Card>
      )}

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat
          label="总播放"
          value={fmtNum(totalViews)}
          foot={
            viewsDeltaPct === null ? (
              range === 'all' ? '全部已回填数据合计' : '上一周期无数据'
            ) : (
              <span style={{ color: viewsDeltaPct >= 0 ? 'var(--green)' : 'var(--red)' }}>
                环比 {viewsDeltaPct >= 0 ? '▲' : '▼'}{Math.abs(viewsDeltaPct)}%
              </span>
            )
          }
        />
        <Stat label="总互动量" value={fmtNum(totalInteractions)} foot="赞 + 评 + 转 + 藏" />
        <Stat label="发布篇数" value={publishCount} foot={`当前筛选 · ${range === 'all' ? '全部' : range}`} />
        <Stat label="采纳并发布" value={adoptedPublished} foot="来自 AI 推荐的篇数" />
      </div>


      {/* 次级：这一页顶上已经有「数据看板 / 什么跑得动 / 平台怎么想」那一层了，
          两条一模一样的标签条叠着分不出层级（2026-08-26 用户说的「重复」的一种） */}
      <PageTabs
        variant="sub"
        initial={typeof sp.tab === 'string' ? sp.tab : undefined}
        tabs={[
          {
            key: 'overview',
            label: '总览',
            hint: '一个核心指标 + 三条安全线，下面是每篇作品的真实表现',
            node: (
              <>
      <div className="grid-asym-left" style={{ marginBottom: 16 }}>
        <Card title="核心指标与安全线" sub="一个核心指标 + 三条不能踩的安全线">
          <div className="stat" style={{ background: 'var(--surface-2)', borderRadius: 10, padding: 14 }}>
            <div className="stat-label">核心指标 · 周均采纳并发布选题数 / 活跃账号</div>
            <div className="stat-value" style={{ color: 'var(--brand)' }}>{northStar}</div>
            <div className="stat-foot">
              {adoptedPublished} 篇采纳发布 ÷ {accounts} 个活跃账号（当前筛选估算）
            </div>
          </div>
          <div className="divider" />
          <div className="stack" style={{ gap: 14 }}>
            {clashRate.state === 'ok' ? (
              <Guardrail
                name="撞题率"
                value={clashRate.pct}
                suffix="%"
                note={clashRate.note}
                color={clashRate.pct < 30 ? 'var(--green)' : 'var(--amber)'}
                meter={100 - clashRate.pct}
              />
            ) : (
              <GuardrailPending name="撞题率" note={clashRate.note} />
            )}
            <Guardrail
              name="超基线内容占比"
              value={aboveBaselinePct}
              suffix="%"
              note={`基线播放 ${fmtNum(Math.round(baselineViews))} · 越高越好`}
              color="var(--brand)"
              meter={aboveBaselinePct}
            />
            {fpRate.state === 'ok' ? (
              <Guardrail
                name="合规误报率"
                value={fpRate.pct}
                suffix="%"
                note={fpRate.note}
                color={fpRate.pct <= 10 ? 'var(--green)' : 'var(--amber)'}
                meter={100 - fpRate.pct}
              />
            ) : (
              <GuardrailPending name="合规误报率" note={fpRate.note} />
            )}
          </div>
        </Card>

        <Card title="推荐 vs 自选" sub="用平均播放看 AI 推荐到底值不值">
          {publishCount === 0 ? (
            <Empty icon="📊" text="当前筛选下还没有数据，换个时间段或先在下方登记一条" />
          ) : (
            <div className="stack" style={{ gap: 16 }}>
              <CompareRow label="AI 推荐" count={recommendRecords.length} avg={recAvg} max={maxAvg} color="var(--brand)" />
              <CompareRow label="自选选题" count={selfRecords.length} avg={selfAvg} max={maxAvg} color="var(--muted, #94a3b8)" />
              <div className="divider" />
              <div className="row-between">
                <span className="small muted">推荐相对自选平均播放</span>
                {liftPositive ? (
                  <span className="badge badge-green" style={{ fontSize: 13 }}>+{lift}%</span>
                ) : (
                  <span className="badge badge-gray" style={{ fontSize: 13 }}>{hasBothSamples ? `${lift}%` : '—'}</span>
                )}
              </div>
              {liftPositive ? (
                <div className="small" style={{ color: 'var(--green)' }}>
                  <Icon.sparkles size={13} /> 推荐组平均播放高出自选组 {lift}%——AI 推荐的选题在你的真实数据里跑赢了。
                </div>
              ) : (
                <div className="small muted">样本还不够，暂未跑出差异——两边各多发几篇、回填数据后再看。</div>
              )}
            </div>
          )}
        </Card>
      </div>

      {/* 📊 发布效果：向前移至核心展现位置 */}
      <Card
        title={
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <Icon.chart size={20} style={{ color: 'var(--brand)' }} />
            <span>发布效果与表现明细</span>
          </div>
        }
        sub="每条已登记内容的真实表现 · 展开看逐日趋势 · 更新数据即触发学习"
        style={{ marginBottom: 16 }}
      >
        {publishCount === 0 ? (
          <Empty icon="📥" text="当前筛选下没有发布记录，用下方「手动回填」登记第一条" />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>平台</th>
                    <th>发布时间 / 标题</th>
                    <th style={{ textAlign: 'right' }}>播放</th>
                    <th style={{ textAlign: 'right' }}>点赞</th>
                    <th style={{ textAlign: 'right' }}>评论</th>
                    <th style={{ textAlign: 'right' }}>转发</th>
                    <th style={{ textAlign: 'right' }}>收藏</th>
                    <th style={{ textAlign: 'right' }}>完播</th>
                    <th>来源</th>
                    <th>出处</th>
                    <th>趋势 / 复盘</th>
                    <th>内容</th>
                    <th>更新</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRecords.map((r) => {
                    const m = metricsOf(r);
                    // 出处 badge 必须标**被采用的那条快照**的来源，不是「最新一条」——
                    // 否则会出现「数字是官方的、badge 写着手填」这种自相矛盾的展示
                    const picked = pickAuthoritativeSnapshot(r.snapshots, r.publishedAt);
                    // snapshots 已按 takenAt desc 取回，[0] 即最后写入的那条
                    const tier = sourceTier(picked?.source ?? r.snapshots[0]?.source);
                    // 链接从 platformItemId 现算（见 publicItemUrl）：库里没有 url 列，
                    // 而「看得到数字却打不开原文」等于没法核对这条数据是不是自己的那篇。
                    // 认不出形态就返回 null，宁可不给链接也不给一个点开是 404 的。
                    const itemUrl = publicItemUrl(r.platform, r.platformItemId);
                    return (
                      <tr key={r.id}>
                        <td>
                          <span className="badge" style={{ background: 'var(--surface-2)', color: platformColor(r.platform) }}>
                            {platformName(r.platform)}
                          </span>
                        </td>
                        <td className="small muted">
                          {r.title ? (
                            <div className="small" style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>
                              {itemUrl ? (
                                <a href={itemUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text)' }} title={itemUrl}>
                                  {r.title} ↗
                                </a>
                              ) : (
                                r.title
                              )}
                            </div>
                          ) : itemUrl ? (
                            // 标题没采到时链接更要给：它是这条记录唯一能被人工核对的抓手
                            <div className="small" style={{ fontWeight: 600, marginBottom: 2 }}>
                              <a href={itemUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--brand)' }} title={itemUrl}>
                                查看原文 ↗
                              </a>
                            </div>
                          ) : null}
                          {fmtDate(r.publishedAt)}
                          {r.needsBackfill && (
                            <div style={{ marginTop: 4 }}>
                              <span className="badge badge-amber" title="缺发布链接，数据不会自动回流">缺链接</span>
                            </div>
                          )}
                          {(() => {
                            // 这条作品下的读者提问（评论采集）。与右侧指标并排是刻意的：
                            // 数字说效果，提问说读者卡在哪/还想要什么。
                            const workKey = r.platformItemId ? `${r.platform}:${r.platformItemId}` : null;
                            const qs = workKey ? readerQs.get(workKey) : undefined;
                            // 这条作品下采到的评论条数。提问可能一条都没归并出来（整页都是夸奖），
                            // 但评论是有的——只看 qs 会让这行显示成「什么都没采到」。
                            const cs = workKey ? commentsByWork.get(workKey) : undefined;
                            if (!qs?.length && !cs?.length) return null;
                            return (
                              <div style={{ marginTop: 6 }}>
                                {cs?.length ? (
                                  <a
                                    href="?tab=audience#voice"
                                    className="small"
                                    style={{ color: 'var(--text-2)', display: 'block', marginTop: 2 }}
                                    title="这条作品下采到的读者评论，在本页「读者原声」里可以逐条读"
                                  >
                                    🗣 {cs.length} 条读者原声
                                  </a>
                                ) : null}
                                {(qs ?? []).slice(0, 2).map((q) => (
                                  <div
                                    key={q.text}
                                    className="small"
                                    style={{ color: 'var(--brand)', marginTop: 2 }}
                                    title={`读者在这条作品的评论区问到 ${q.count} 次（来自评论采集，已按隐私规则聚合）`}
                                  >
                                    💬 {q.text}
                                    {q.count > 1 ? <span className="muted"> ×{q.count}</span> : null}
                                  </div>
                                ))}
                                {(qs?.length ?? 0) > 2 && (
                                  <div className="small muted" style={{ marginTop: 2 }}>
                                    还有 {(qs?.length ?? 0) - 2} 条读者提问，见灵感箱
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }} className="mono">{fmtNum(m.views)}</td>
                        <td style={{ textAlign: 'right' }} className="mono">{fmtNum(m.likes)}</td>
                        <td style={{ textAlign: 'right' }} className="mono">{fmtNum(m.comments)}</td>
                        <td style={{ textAlign: 'right' }} className="mono">{fmtNum(m.shares)}</td>
                        <td style={{ textAlign: 'right' }} className="mono">{fmtNum(m.collects)}</td>
                        <td style={{ textAlign: 'right' }} className="mono">
                          {typeof m.completion === 'number' ? `${Math.round(m.completion * 100)}%` : '—'}
                        </td>
                        <td>
                          {r.fromRecommend ? (
                            <span className="badge badge-brand">AI推荐</span>
                          ) : (
                            <span className="badge badge-gray">自选</span>
                          )}
                        </td>
                        <td>
                          <span
                            className={`badge ${tier === 'official' ? 'badge-green' : tier === 'plugin' ? 'badge-brand' : 'badge-gray'}`}
                            title="数据出处：官方=授权API/适配器，插件=浏览器回传，手填=手动录入"
                          >
                            {SOURCE_TIER_LABEL[tier]}
                          </span>
                        </td>
                        <td>
                          <div className="stack" style={{ gap: 6 }}>
                            <TrendCell
                              publishedAt={r.publishedAt.toISOString()}
                              snapshots={r.snapshots.map((sn) => ({
                                takenAt: sn.takenAt.toISOString(),
                                metrics: sn.metrics,
                                source: sn.source,
                                milestone: sn.milestone,
                              }))}
                            />
                            <ReviewCell publishId={r.id} stored={storedReviews.get(r.id) ?? null} />
                          </div>
                        </td>
                        <td>
                          {r.contentText ? (
                            <CopyText text={r.contentText} label="复制" className="btn btn-sm btn-ghost" />
                          ) : (
                            <span className="small muted">—</span>
                          )}
                        </td>
                        <td>
                          <div className="stack" style={{ gap: 6 }}>
                            <MetricsUpdater publishId={r.id} initial={m} />
                            {r.needsBackfill && <AttachUrl publishId={r.id} />}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {pageCount > 1 && (
              <div className="row-between" style={{ marginTop: 12 }}>
                <span className="small muted">共 {scoped.length} 条 · 第 {curPage}/{pageCount} 页</span>
                <div className="row" style={{ gap: 8 }}>
                  {curPage > 1 && <a className="btn btn-sm btn-ghost" href={qs({ page: String(curPage - 1) })}>上一页</a>}
                  {curPage < pageCount && <a className="btn btn-sm btn-ghost" href={qs({ page: String(curPage + 1) })}>下一页</a>}
                </div>
              </div>
            )}
          </>
        )}
      </Card>
              </>
            ),
          },
          {
            key: 'audience',
            label: '受众与原声',
            hint: '粉丝画像说「他们是谁」，读者原声说「他们在关心什么、原话怎么说」',
            node: (
              <>
      {/* 账号级数据：粉丝曲线 + 受众画像（只有创作者后台给得到） */}
      <AudienceCard platform={audiencePlatform} series={followerPoints} audience={audienceBuckets} />

      {/* 读者原声：粉丝画像说「他们是谁」，这里说「他们在关心什么、原话怎么说」 */}
      {/* 锚点用兄弟节点，不是 Card 的 prop——Card 不收 id（同 #growth 的写法） */}
      <div id="voice" />
      <Card
        title="💬 读者原声"
        sub={`评论区里粉丝在了解什么、关心什么 · 最近 ${voice.total} 条`}
        style={{ marginBottom: 16 }}
      >
        <ReaderVoice
          comments={voice.recent.map((c) => ({
            id: c.id,
            text: c.text,
            kind: c.kind,
            platform: c.platform,
            workTitle: c.workTitle,
            // Date 传不进客户端组件的边界要先序列化
            collectedAt: c.collectedAt.toISOString(),
          }))}
          topics={voice.concerns}
          kinds={voice.kinds}
          retentionDays={COMMENT_TEXT_PURGE_DAYS}
          emptyHint="还没采到评论。在插件设置里打开「评论提问采集」，然后到自己的作品详情页点侧栏的「读评论提问」——插件只读当前屏幕上已经显示的评论，不翻页。"
        />
      </Card>
              </>
            ),
          },
          {
            key: 'growth',
            label: '增长',
            hint: '账号涨粉与单条作品在同一时间窗下的净增（竞对增长在竞对监控页）',
            node: (
              <>
      {/* 发布时段分析 */}
      {/* 自有增长。竞对增长在竞对监控页那边（用户 2026-08-10 定的分工：各页只管自己的域）。
          与本页其它卡的分工：它们答「现在是多少」，这里答「这段时间涨了多少、什么时候涨的」。 */}
      <div id="growth" />
      <Card title="📈 我的增长" sub="账号涨粉与单条作品在同一时间窗下的净增，以及每次采集的时点曲线" style={{ marginBottom: 16 }}>
        {growthRows.length === 0 ? (
          <Empty text="还没有可用于算增长的数据——增长需要至少两次采集。用插件在你的作品页点两次「这是我的作品」（或等定时回填跑过两轮）后，这里就会出现曲线。" />
        ) : (
          <>
            {!hasGrowth && (
              <div className="small muted" style={{ marginBottom: 10 }}>
                这个时间窗内还没有回流记录。换一个更长的时间窗，或者去回填一次。
              </div>
            )}
            <GrowthBoard
              windowKey={windowKey}
              rows={growthRows}
              windowHrefs={windowHrefs}
              empty="这个时间窗内没有自有数据回流。"
            />
          </>
        )}
      </Card>
              </>
            ),
          },
          {
            key: 'review',
            label: '复盘',
            hint: '这一周做得怎么样、AI 的判断准不准、什么时段发更好、账号画像学到了什么',
            node: (
              <>
      {/* 周度运营复盘 + R7「记住了你的 N 件事」 */}
      <WeeklyReviewCard review={weekly} />

      {/* 决策质量：AI 的推荐/会诊到底准不准 */}
      <Card title="🎯 决策质量" sub="AI 的推荐与智囊团会诊到底准不准 · 让决策本身可复盘" style={{ marginBottom: 16 }}>
        <div className="grid grid-4">
          <Stat
            label="推荐采纳率"
            value={dq.adoptRatePct === null ? '—' : `${dq.adoptRatePct}%`}
            foot={dq.adoptRatePct === null ? '暂无采纳/拒绝样本' : `采纳 ${dq.recommendAdopted} · 拒绝 ${dq.recommendRejected}`}
          />
          <Stat
            label="智囊团命中率"
            value={dq.advisorHitRatePct === null ? '—' : `${dq.advisorHitRatePct}%`}
            foot={dq.advisorHitRatePct === null ? '暂无会诊裁决' : `采纳 ${dq.advisorAdopted} · 否决 ${dq.advisorRejected}`}
          />
          <Stat
            label="被验证切入角"
            value={dq.angleProven}
            foot={<span style={{ color: dq.angleFailed > 0 ? 'var(--red)' : undefined }}>{dq.angleFailed > 0 ? `另有 ${dq.angleFailed} 个已证伪` : '数据验证有效'}</span>}
          />
          <Stat label="已复盘选题" value={dq.reviewed} foot="发布后回写 reviewed" />
        </div>
        <div className="small muted" style={{ marginTop: 10, lineHeight: 1.6 }}>
          这些数字来自你自己的采纳/拒绝与发布后真实数据——AI 建议准不准，用你的行为和结果说话，而不是我们自说自话。
        </div>
      </Card>
      <Card title="⏰ 发布时段分析" sub="哪个时段发的内容平均播放更高 · 满 3 条/时段才下结论" style={{ marginBottom: 16 }}>
        {!timing.conclusive ? (
          <Empty icon="⏳" text="样本积累中——同一时段满 3 条发布后，这里给出「几点发效果好」的结论" />
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            <div className="small">
              最佳发布时段：<b style={{ color: 'var(--brand)' }}>{timing.best!.label}</b>
              <span className="muted">（{timing.best!.sample} 条 · 均播 {fmtNum(timing.best!.avgViews)}，整体均播 {fmtNum(timing.overallAvg)}）</span>
            </div>
            <div className="stack" style={{ gap: 8 }}>
              {timing.hourSlots.map((slot) => (
                <div key={slot.key}>
                  <div className="row-between" style={{ marginBottom: 4 }}>
                    <span className="small">{slot.label} <span className="muted">· {slot.sample} 条</span></span>
                    <span className="small mono">{fmtNum(slot.avgViews)}</span>
                  </div>
                  <Meter value={(slot.avgViews / maxSlotViews) * 100} color={slot.key === timing.best!.key ? 'var(--brand)' : 'var(--text-3)'} />
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      {/* 账号属性画像 */}
      <Card title="账号属性画像 · 持续学习" sub="每次回填流量，系统都会与账号自身基线对比并沉淀结论" style={{ marginBottom: 16 }}>
        {profiles.length === 0 && learnedMemories.length === 0 ? (
          <Empty icon="🧭" text="还没有可学习的数据——发布后回来回填数据，账号画像会自动长出来" />
        ) : (
          <div className="grid-asym-left grid-align-start">
            <div className="stack" style={{ gap: 10 }}>
              <div className="small muted">平台算法适配（按你的真实数据）</div>
              {profiles.map((p) => (
                <div key={p.platform} className="card" style={{ padding: 10, boxShadow: 'none', background: 'var(--surface-2)' }}>
                  <div className="row-between">
                    <span className="badge" style={{ background: 'var(--surface)', color: platformColor(p.platform) }}>
                      {platformName(p.platform)}
                    </span>
                    <span className="small muted">{p.sample} 条样本</span>
                  </div>
                  <div className="row wrap small" style={{ gap: 12, marginTop: 6 }}>
                    <span>均播 <b className="mono">{fmtNum(p.avgViews)}</b></span>
                    {p.engagement !== null && (
                      <span>互动率 <b className="mono">{(p.engagement * 100).toFixed(1)}%</b></span>
                    )}
                    {p.avgCompletion !== null && <span>完播 <b className="mono">{(p.avgCompletion * 100).toFixed(0)}%</b></span>}
                  </div>
                </div>
              ))}
              {profiles.length === 0 && <span className="small muted">暂无平台样本</span>}
            </div>
            <div className="stack" style={{ gap: 10 }}>
              <div className="small muted">学到的账号结论（重复被数据验证会转为「生效」并注入 AI）</div>
              {learnedMemories.length === 0 ? (
                <span className="small muted">暂无——更新几条发布数据后出现</span>
              ) : (
                <div className="stack" style={{ gap: 6 }}>
                  {learnedMemories.map((m) => (
                    <div key={m.id} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                      <span className={`dot ${m.active ? 'dot-green' : 'dot-amber'}`} style={{ marginTop: 5, flexShrink: 0 }} />
                      <span className="small" style={{ opacity: m.active ? 1 : 0.7 }}>
                        {m.content}
                        <span className="muted">（命中 {m.hitCount} 次{m.active ? '，已生效' : '，观察中'}）</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {verifiedAngles.length > 0 && (
                <>
                  <div className="divider" style={{ margin: '4px 0' }} />
                  <div className="small muted">被数据验证的切入角（已进风格指纹，生成时优先）</div>
                  <div className="row wrap" style={{ gap: 6 }}>
                    {verifiedAngles.map((a, i) => (
                      <span key={i} className="badge badge-brand">{a}</span>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </Card>
              </>
            ),
          },
          {
            key: 'input',
            label: '录入数据',
            hint: '数据从哪来：插件一键回填 / 补链接 / 导入历史作品 / 手动登记',
            node: (
              <>
      <Card title="🔌 插件一键回填" sub="装上「烽火台采集助手」，打开自己的作品页一键回填，省去手动填数" style={{ marginBottom: 16 }}>
        <div className="small muted" style={{ lineHeight: 1.8 }}>
          在 B站视频页 / 抖音视频页 / 小红书笔记页打开<b>你自己已发布的作品</b>，点插件里的
          <b style={{ color: 'var(--text)' }}>「📥 这是我的作品 · 回填数据看板」</b>，
          插件会把你亲眼可见的公开数据（播放、点赞、评论、收藏等）回传到这里，自动匹配已登记的发布记录、
          没匹配到的会新建一条。数据即时进入下方「发布效果」与账号画像学习闭环。
          <br />
          <b style={{ color: 'var(--text)' }}>创作者后台（推荐）</b>：在<b>你自己</b>的创作者后台
          <b style={{ color: 'var(--text)' }}>「数据中心 · 作品数据」</b>页点同一个按钮，能拿到公开作品页
          <b>拿不到的完播率 / 完读率</b>——它是抖音、公众号、B站、视频号算法的第一信号，也是「个性化诊断」
          此前总说样本不足的原因。支持：视频号（channels.weixin.qq.com）、公众号（mp.weixin.qq.com 后台）、
          抖音（creator.douyin.com）、小红书（creator.xiaohongshu.com）、B站（member.bilibili.com）。
          <br />
          边界写在这里，不藏在协议里：<b>仅在你本人登录态下运行</b>、<b>只读不写</b>（不发布、不修改、不调用平台任何接口）、
          <b>只读取你自己账号后台已渲染出来的数据</b>、<b>不采集任何他人的数据</b>；插件不持有、不读取、也不上传
          任何平台的 Cookie 或登录凭证，更不会代你登录。必须由你手动点击触发——这些页面不参与「访问即采」。
          <br />
          还没装插件？<a href="/extension" style={{ color: 'var(--brand)', fontWeight: 600 }}>去下载采集助手 →</a>（Chrome / Edge / 360 / Brave）；
          装好后在 <a href="/settings/keys" style={{ color: 'var(--brand)' }}>接入与密钥 · 插件采集令牌</a> 生成令牌并填入插件（与竞对采集共用同一令牌）。
          本产品不代发、不托管平台 Cookie，只回传你本人可见的公开数据。
        </div>
      </Card>

      <Card
        title="采集记录"
        sub="每次回填覆盖的时间段 · 最近 30 次"
        style={{ marginBottom: 16 }}
      >
        <div className="small muted" style={{ marginBottom: 12, lineHeight: 1.7 }}>
          插件每次只能采到后台当前页面上那一段（作品数据页通常是最近若干条）。
          这里记下<b>每一批数据覆盖的发布时间区间</b>，用来判断哪段时间已经采过、哪段还是窟窿；
          账号名是这批数据<b>记在谁名下</b>——看板按账号分开看，挂错号在上面就找不到它。
        </div>
        <CollectionRuns
          rows={collectionRuns}
          emptyText="还没有自有数据的采集记录——用插件在你自己的创作者后台点一次回填，这里会记下覆盖的时间段"
        />
      </Card>

      <Card title="历史作品导入" sub="导入已发布作品，充实基线样本" style={{ marginBottom: 16 }}>
        <ImportPosts />
      </Card>

      <Card title="手动回填" sub="发布登记 + 手动回填，效果追踪就能跑起来">
        <div className="small muted" style={{ marginBottom: 14, lineHeight: 1.7 }}>
          本产品不代发、不托管平台 Cookie。发布后请回这里手动登记内容的真实表现，
          系统据此把「AI 推荐 → 采纳 → 发布 → 数据」串成完整的效果追踪链路，
          让核心指标与「推荐 vs 自选」对比都建立在你的真实数据上。
        </div>
        <Backfill />
      </Card>
              </>
            ),
          },
        ]}
      />
    </>
  );
}

function HealthRow({ issue }: { issue: HealthIssue }) {
  const color = issue.severity === 'warn' ? 'var(--amber)' : 'var(--text-3)';
  return (
    <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
      <span className="dot" style={{ background: color, marginTop: 6, flexShrink: 0 }} />
      <div className="stack" style={{ gap: 2 }}>
        <span className="small" style={{ fontWeight: 600, color }}>{issue.title}</span>
        <span className="small muted" style={{ lineHeight: 1.6 }}>{issue.detail}</span>
      </div>
    </div>
  );
}

function GuardrailPending({ name, note }: { name: string; note: string }) {
  return (
    <div style={{ opacity: 0.55 }}>
      <div className="row-between" style={{ marginBottom: 6 }}>
        <span className="small">{name}</span>
        <span className="small muted">暂无数据</span>
      </div>
      <Meter value={0} />
      <div className="stat-foot" style={{ marginTop: 4 }}>{note}</div>
    </div>
  );
}

function Guardrail({
  name,
  value,
  suffix,
  note,
  color,
  meter,
}: {
  name: string;
  value: number;
  suffix: string;
  note: string;
  color: string;
  meter: number;
}) {
  return (
    <div>
      <div className="row-between" style={{ marginBottom: 6 }}>
        <span className="small">{name}</span>
        <span className="small"><b style={{ color }}>{value}{suffix}</b></span>
      </div>
      <Meter value={meter} color={color} />
      <div className="stat-foot" style={{ marginTop: 4 }}>{note}</div>
    </div>
  );
}

function CompareRow({
  label,
  count,
  avg,
  max,
  color,
}: {
  label: string;
  count: number;
  avg: number;
  max: number;
  color: string;
}) {
  return (
    <div>
      <div className="row-between" style={{ marginBottom: 6 }}>
        <span className="small"><b>{label}</b> <span className="muted">· {count} 篇</span></span>
        <span className="small mono">均 {fmtNum(avg)}</span>
      </div>
      <Meter value={(avg / max) * 100} color={color} />
    </div>
  );
}
