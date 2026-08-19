import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { parseJson, engagementRate, type Metrics } from '@/lib/json';
import { heatForSort } from '@/lib/insight/heat';
import { platformName, PLATFORMS, PLATFORM_LIST } from '@/lib/constants';
import { relTime } from '@/lib/format';
import { PageHead, Card, Stat, Fold, Empty } from '@/components/ui';
import { ActionButton } from '@/components/ActionButton';
import { actCrawlCompetitors } from './actions';
import { AddCompetitorForm } from './AddCompetitorForm';
import { BatchCollectButton } from './BatchCollectButton';
import { CompetitorTopPosts } from './CompetitorTopPosts';
import { CompetitorRoster, type RosterRow } from './CompetitorRoster';
import { MonitorStat } from './MonitorStat';
import { ImportWechatArticles } from './ImportWechatArticles';
import { GrowthBoard } from '@/components/GrowthBoard';
import { loadRivalGrowth, WINDOW_KEYS } from '@/lib/insight/growth-rows';
import { growthOverWindow, windowRange, WINDOW_LABEL, type WindowKey } from '@/lib/insight/growth';
import type { PostGrowth } from './CompetitorTopPosts';
import { CollectionRuns } from '@/components/CollectionRuns';
import { listCollectionRuns } from '@/lib/ingest/collection-run';
import { wechatCollectRuleLines } from '@/lib/wechat-collect-rules';
// 「插件能采的平台」只此一份（此前网页与 lib 各存一份 Set，改一处漏一处就会出现
// 「按钮说能采、后端说不能采」的对不上）
import { PLUGIN_COLLECTABLE } from '@/lib/ingest/competitor';
import { readerVoice } from '@/lib/insight/reader-voice';
import { COMMENT_TEXT_PURGE_DAYS } from '@/lib/comment-collect-rules';
import { ReaderVoice } from '@/components/ReaderVoice';

export const dynamic = 'force-dynamic';

// 页面自上而下只分四段：指标 → 平台筛选 → 管理区（全部折叠）→ 高热作品榜。
// 管理区（添加账号 / 公众号采集说明 / 对标名单）此前是左侧一条常驻侧栏，账号和说明一多
// 就把主内容——作品榜——挤成半屏还看不完；现在收进折叠卡，作品榜吃满整宽。
export default async function CompetitorsPage({
  searchParams,
}: {
  searchParams: Promise<{ platform?: string; window?: string }>;
}) {
  const s = await getSession();
  const sp = await searchParams;
  const requestedPlatform = sp.platform && sp.platform in PLATFORMS ? sp.platform : null;
  // 增长区块的时间窗。与平台筛选共用 query string，两者互不干扰（切窗口不会丢掉平台筛选）
  const windowKey: WindowKey = (WINDOW_KEYS as string[]).includes(sp.window ?? '') ? (sp.window as WindowKey) : '7d';

  const allWatchlist = await prisma.watchlistItem.findMany({
    where: { workspaceId: s.workspaceId },
    include: { competitor: true },
    orderBy: { addedAt: 'desc' },
  });

  // 把某个平台的账号移除干净之后，URL 上的 ?platform= 还钉在那儿：标签栏里这个平台已经没了，
  // 页面却仍按它过滤——指标全 0、名单空、作品榜 TOP 0，看起来像「数据全丢了」。
  // 没有账号的平台就当没筛过：自动退回「全部」，并说一句为什么退。
  const platformFilter =
    requestedPlatform && allWatchlist.some((w) => w.competitor.platform === requestedPlatform)
      ? requestedPlatform
      : null;
  const droppedFilter = requestedPlatform && !platformFilter ? requestedPlatform : null;

  // 同行读者原声。跟着本页的平台筛选走——筛了小红书还把抖音的评论摆出来，
  // 就是「URL 筛选参数指向已空维度」那类坑的反面：页面说在看 A，数据却是 A+B。
  const rivalVoice = await readerVoice(s.workspaceId, {
    scope: 'rival',
    ...(platformFilter ? { platform: platformFilter } : {}),
  });

  const watchlist = platformFilter
    ? allWatchlist.filter((w) => w.competitor.platform === platformFilter)
    : allWatchlist;
  const competitorIds = watchlist.map((w) => w.competitorId);

  // 订阅竞对名下的全部作品（用于统计），以及高热榜（表格取前 15）
  const allPosts = competitorIds.length
    ? await prisma.crawledPost.findMany({
        where: { competitorId: { in: competitorIds } },
        include: { competitor: true },
        orderBy: { publishedAt: 'desc' },
      })
    : [];
  // 榜取「互动量」最高的 50 条。**不再按 hotScore 排**——那个字段是 `views / 20000` 算的，
  // 抖音/小红书/X 的公开页没有播放量，它们恒为 0，于是这 50 个名额被有播放量的平台包圆，
  // 那些平台的作品根本进不了榜（见 lib/insight/heat.ts 顶部的说明）。
  // 现算而不是改库里的 hotScore：存量行还是旧语义，改定义会让新旧两种含义混在一张表里。
  const topPosts = [...allPosts]
    .sort((a, b) => heatForSort(parseJson<Metrics>(b.metrics, {})) - heatForSort(parseJson<Metrics>(a.metrics, {})))
    .slice(0, 50);
  // 趋势快照给榜单展示的 50 条作品取
  const topSnapshots = topPosts.length
    ? await prisma.postMetricSnapshot.findMany({
        where: { postId: { in: topPosts.map((p) => p.id) } },
        orderBy: { takenAt: 'asc' },
        select: { postId: true, takenAt: true, metrics: true, source: true },
      })
    : [];
  const snapsByPost = new Map<string, { takenAt: Date; metrics: string; source: string }[]>();
  for (const sn of topSnapshots) {
    if (!snapsByPost.has(sn.postId)) snapsByPost.set(sn.postId, []);
    snapsByPost.get(sn.postId)!.push({ takenAt: sn.takenAt, metrics: sn.metrics, source: sn.source });
  }

  // 每条作品在当前时间窗内的增长。用刚取回的快照现算，不再多打一次库。
  // 口径与增长卡完全一致（同一个 growthOverWindow）：基准点取窗口**之前**最近一次观测，
  // 缺席的项不产出数字（见 lib/insight/growth.ts）。
  const { from: growthFrom, to: growthTo } = windowRange(windowKey, new Date());
  const postGrowth: Record<string, PostGrowth> = {};
  for (const [postId, snaps] of snapsByPost) {
    const obs = snaps.map((sn) => ({ at: sn.takenAt, metrics: parseJson<Metrics>(sn.metrics, {}) }));
    const g = growthOverWindow(obs, growthFrom, growthTo);
    postGrowth[postId] = {
      status: g.status,
      delta: g.delta as Record<string, number | undefined>,
      points: g.points.length,
    };
  }

  // ── 指标行 ──
  const accountCount = watchlist.length;
  const platformSet = new Set(watchlist.map((w) => w.competitor.platform));
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const weekPosts = allPosts.filter((p) => p.publishedAt && p.publishedAt >= weekAgo).length;
  // 只对**算得出互动率**的作品求均值。抖音等平台的公开页面没有播放量，
  // 那些作品的互动率是 null 而不是 0——按 0 计入会把整体均值系统性拉低，
  // 于是「大半的号在抖音」看起来就像「这批竞对互动都很差」，那是编出来的。
  const engRates = allPosts
    .map((p) => engagementRate(parseJson<Metrics>(p.metrics, {})))
    .filter((e): e is number => e !== null);
  const avgEngage = engRates.length > 0 ? engRates.reduce((s, e) => s + e, 0) / engRates.length : null;

  // 每个竞对各自的在库/近 7 天条数：名单里「这个号到底采到东西没有」全靠它，
  // 从已取的 allPosts 里累加，不再多打一次库。
  const perCompetitor = new Map<string, { posts: number; weekPosts: number }>();
  for (const p of allPosts) {
    const st = perCompetitor.get(p.competitorId) ?? { posts: 0, weekPosts: 0 };
    st.posts += 1;
    if (p.publishedAt && p.publishedAt >= weekAgo) st.weekPosts += 1;
    perCompetitor.set(p.competitorId, st);
  }
  const rosterRows: RosterRow[] = watchlist.map((w) => ({
    watchId: w.id,
    name: w.competitor.name,
    handle: w.competitor.handle,
    platform: w.competitor.platform,
    label: w.label,
    followers: w.competitor.followers,
    lastCrawledAt: w.competitor.lastCrawledAt,
    posts: perCompetitor.get(w.competitorId)?.posts ?? 0,
    weekPosts: perCompetitor.get(w.competitorId)?.weekPosts ?? 0,
  }));

  // 平台 tab 用全量订阅的平台集合（不受当前过滤影响），带上各平台账号数
  const platformCounts = new Map<string, number>();
  for (const w of allWatchlist) {
    platformCounts.set(w.competitor.platform, (platformCounts.get(w.competitor.platform) ?? 0) + 1);
  }
  const neverCrawled = watchlist.filter((w) => !w.competitor.lastCrawledAt).length;
  // 一键采集覆盖的竞对数（仅插件能采集的平台）
  const collectableCount = watchlist.filter((w) => PLUGIN_COLLECTABLE.has(w.competitor.platform)).length;
  // 公众号走导入通道（无公开主页 → 插件采不到），有订阅公众号才显示导入卡
  const wechatAccounts = allWatchlist
    .filter((w) => w.competitor.platform === 'wechat')
    .map((w) => ({ id: w.competitorId, name: w.competitor.name, handle: w.competitor.handle }));

  // 采集台账：每次抓取覆盖了哪段时间。所有通道都只取「最近一小段」，
  // 没有这张表就只知道「库里有 N 篇」，不知道哪段时间采过、哪段是窟窿。
  const runs = await listCollectionRuns(s.workspaceId, { scope: 'rival', take: 30 });

  // 竞对增长。**只有竞对**——自有增长在数据看板那边（用户 2026-08-10 定的分工：
  // 各页只管自己的域）。原先这里并排放自有做对照，已按要求拆开。
  const { rows: growthRows, hasAny: hasGrowth } = await loadRivalGrowth(s.workspaceId, windowKey);
  // 同数据看板：客户端组件收不了函数，链接在服务端算好
  const windowHrefs = Object.fromEntries(
    WINDOW_KEYS.map((k) => [
      k,
      `/competitors?${requestedPlatform ? `platform=${encodeURIComponent(requestedPlatform)}&` : ''}window=${k}#growth`,
    ]),
  );

  // ⚠️ 这份平台清单要与 lib/ingest/competitor.ts 的 PLUGIN_COLLECTABLE 对齐
  //（tests/ingest/platform-copy-sync.test.ts 会扫）。此前漏了 TikTok 与公众号——
  // 被明确告知「不支持」的用户根本不会去试，功能等于不存在。
  // 公众号单独说明：它没有公开主页，贴不了链接，走的是插件在你自己后台里查。
  const rosterOrEmpty =
    rosterRows.length === 0 ? (
      <Empty
        icon="🎯"
        text="还没有对标账号——贴一个同行主页链接就能建档，B站/抖音/小红书/YouTube/X/TikTok 都支持；公众号没有公开主页，填公众号名称后由插件在你自己的后台里查"
      />
    ) : (
      <CompetitorRoster rows={rosterRows} />
    );

  return (
    <>
      <PageHead
        title="竞对监控"
        desc="多平台对标账号统一视图 · 全局共享采集，同一竞对只采一次"
        action={
          <span className="row wrap" style={{ gap: 8, justifyContent: 'flex-end' }}>
            {collectableCount > 0 && <BatchCollectButton count={collectableCount} />}
            <ActionButton action={actCrawlCompetitors} primary loadingText="采集中…">采集竞对</ActionButton>
          </span>
        }
      />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        {/* 监控账号数点得开：名单是「我在盯谁、采到没有」的答案，不该只躺在页面下方 */}
        <MonitorStat
          label="监控账号数"
          value={accountCount}
          foot={platformFilter ? platformName(platformFilter) : '工作区订阅'}
          dialogTitle="监控明细"
          dialogSub={`${accountCount} 个账号${neverCrawled > 0 ? ` · ${neverCrawled} 个未采集` : ''}`}
        >
          {rosterOrEmpty}
        </MonitorStat>
        <Stat label="覆盖平台数" value={platformSet.size} foot="跨平台对标覆盖" />
        <Stat label="本周新作品" value={weekPosts} foot="近 7 天采集入库" />
        <Stat
          label="平均互动率"
          value={avgEngage === null ? '—' : `${(avgEngage * 100).toFixed(1)}%`}
          foot={
            avgEngage === null
              ? '在库作品都来自不公开播放量的平台，算不出来'
              : `点赞评论收藏 / 播放（${engRates.length}/${allPosts.length} 条有播放量）`
          }
        />
      </div>

      <div className="tabs">
        <Link href="/competitors" className={`tab${!platformFilter ? ' active' : ''}`}>
          全部 {allWatchlist.length}
        </Link>
        {[...platformCounts.entries()].map(([p, n]) => (
          <Link key={p} href={`/competitors?platform=${p}`} className={`tab${platformFilter === p ? ' active' : ''}`}>
            {platformName(p)} {n}
          </Link>
        ))}
      </div>

      {droppedFilter && (
        <div className="small muted" style={{ marginBottom: 12 }}>
          「{platformName(droppedFilter)}」下已经没有对标账号了，已切回「全部」。
        </div>
      )}

      {/* ── 管理区：三张卡并排一行，默认全收起，用到再展开 ──
           展开的那张会自动占满整行（.fold-row 里的纯 CSS 规则）——
           名单表格和采集台账挤在 1/3 宽里没法看，但收起态只有一行标题，
           并排才不至于让三张卡吃掉三屏。公众号那张是有订阅才出现的第四张，
           它出现时会自动换到下一行，不影响前三张的并排。 */}
      {/* #growth 锚点放在网格**外面**：放进去会占掉一个格子，
          第四列就空出来了（真机上撞到过）。四张卡本来同一行，滚到行首即滚到增长卡。 */}
      <div id="growth" />
      <div className="fold-row" style={{ marginBottom: 20 }}>
        <Fold
          title="添加对标账号"
          // 数字从 PLATFORM_LIST 现算：手写的「6 个平台」在平台加到 8 个之后就一直是错的，
          // 而下面渲染的正是同一个列表，用户一眼就能数出对不上。
          sub={`粘主页链接自动识别 · 支持 ${PLATFORM_LIST.length} 个平台`}
          defaultOpen={allWatchlist.length === 0}
        >
          <AddCompetitorForm />
        </Fold>

        {wechatAccounts.length > 0 && (
          <Fold
            title="公众号采集"
            sub={`${wechatAccounts.length} 个公众号 · 走你自己的后台登录态`}
            note={<span className="small muted hide-mobile">采集节奏规则 · 文章导入</span>}
          >
            <div className="stack" style={{ gap: 10 }}>
              <div className="small muted">
                由插件在你自己的公众号后台完成，服务器不接触任何登录态。为避免账号被微信限接口，
                <b>采集节奏是写死的</b>：
              </div>
              <ul className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
                {wechatCollectRuleLines().map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <div className="small muted" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                <b>备用通道</b>：也可以用 wechat-article-exporter 在本地导出 JSON 再导入（插件不可用、或要补历史文章时用）。
              </div>
              <ImportWechatArticles accounts={wechatAccounts} />
            </div>
          </Fold>
        )}

        <Fold
          title="对标账号"
          sub={`${accountCount} 个${platformFilter ? ` · ${platformName(platformFilter)}` : ''}`}
          note={
            neverCrawled > 0 ? (
              <span className="badge badge-amber" title="未配置采集通道时不会入库任何作品">
                {neverCrawled} 个未采集
              </span>
            ) : undefined
          }
        >
          {rosterOrEmpty}
        </Fold>

        <Fold
          title="采集记录"
          sub="每次抓取覆盖的时间段 · 最近 30 次"
          note={
            runs[0] ? (
              <span className="small muted hide-mobile">最近一次 {relTime(runs[0].ranAt)}</span>
            ) : undefined
          }
        >
          <CollectionRuns
            rows={runs}
            emptyText="还没有采集记录——点右上角「采集竞对」，或用插件采一次，这里会记下每批数据覆盖的时间段"
          />
        </Fold>

        {/* 竞对增长：作品榜答「谁现在最火」，这里答「这段时间谁在涨」——两个不同的问题。
            与前三张并排收在同一行，展开时自动占满整行（.fold-row 的 CSS 规则）。
            ⚠️ defaultOpen 跟着 ?window= 走：时间窗切换是**链接跳转**，
            默认收起的话，用户点完「24 小时」会落在一张关着的卡上，看起来像点了没反应。
            带了 window 参数就说明他正在看增长，那就保持展开。 */}
        <Fold
          title="竞对增长"
          sub={`${WINDOW_LABEL[windowKey]}净增 · 每次采集一个时点`}
          note={growthRows.length > 0 ? <span className="small muted hide-mobile">{growthRows.length} 个账号</span> : undefined}
          defaultOpen={!!sp.window}
        >
          {growthRows.length === 0 ? (
            <Empty text="还没有可用于算增长的竞对数据——增长需要至少两次采集。采两轮（或等定时采集跑过两轮）后，这里就会出现曲线。" />
          ) : (
            <>
              {!hasGrowth && (
                <div className="small muted" style={{ marginBottom: 10 }}>
                  这个时间窗内还没有竞对采集记录。换一个更长的时间窗，或者去采一次。
                </div>
              )}
              <GrowthBoard
                windowKey={windowKey}
                rows={growthRows}
                windowHrefs={windowHrefs}
                empty="这个时间窗内没有竞对采集记录。"
              />
            </>
          )}
        </Fold>
      </div>

      <Card title="高热作品榜" sub={`按互动量取 TOP ${topPosts.length} · 每行带 ${WINDOW_LABEL[windowKey]}增长`}>
        <CompetitorTopPosts
          topPosts={topPosts}
          snapsByPostMap={Object.fromEntries(
            Array.from(snapsByPost.entries()).map(([k, v]) => [
              k,
              v.map((sn) => ({ takenAt: sn.takenAt.toISOString(), metrics: sn.metrics, source: sn.source })),
            ])
          )}
          postGrowth={postGrowth}
          windowLabel={WINDOW_LABEL[windowKey]}
        />
      </Card>

      {/* 同行读者原声。与 /data 的「读者原声」严格分开（同增长追踪那两块的口径）：
          自有作品的评论是你的读者，竞对作品下的是**别人的**读者——混在一页里看，
          很容易把同行的需求当成自己受众的需求。 */}
      <div id="rival-voice" style={{ marginTop: 16 }} />
      <Card
        title="🗣 同行读者原声"
        sub={`竞对作品评论区里读者在关心什么 · 最近 ${rivalVoice.total} 条 · 先判断他们的读者是不是你的读者`}
      >
        <ReaderVoice
          comments={rivalVoice.recent.map((c) => ({
            id: c.id,
            text: c.text,
            kind: c.kind,
            platform: c.platform,
            workTitle: c.workTitle,
            collectedAt: c.collectedAt.toISOString(),
          }))}
          topics={rivalVoice.concerns}
          kinds={rivalVoice.kinds}
          retentionDays={COMMENT_TEXT_PURGE_DAYS}
          emptyHint="还没采到同行评论。在插件设置里打开「评论提问采集（竞对作品）」，然后到同行的作品详情页点侧栏的「读评论提问」。"
        />
      </Card>
    </>
  );
}
