import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { parseJson, engagementRate, type Metrics } from '@/lib/json';
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
import { CollectionRuns } from '@/components/CollectionRuns';
import { listCollectionRuns } from '@/lib/ingest/collection-run';
import { wechatCollectRuleLines } from '@/lib/wechat-collect-rules';
// 「插件能采的平台」只此一份（此前网页与 lib 各存一份 Set，改一处漏一处就会出现
// 「按钮说能采、后端说不能采」的对不上）
import { PLUGIN_COLLECTABLE } from '@/lib/ingest/competitor';

export const dynamic = 'force-dynamic';

// 页面自上而下只分四段：指标 → 平台筛选 → 管理区（全部折叠）→ 高热作品榜。
// 管理区（添加账号 / 公众号采集说明 / 对标名单）此前是左侧一条常驻侧栏，账号和说明一多
// 就把主内容——作品榜——挤成半屏还看不完；现在收进折叠卡，作品榜吃满整宽。
export default async function CompetitorsPage({
  searchParams,
}: {
  searchParams: Promise<{ platform?: string }>;
}) {
  const s = await getSession();
  const sp = await searchParams;
  const requestedPlatform = sp.platform && sp.platform in PLATFORMS ? sp.platform : null;

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

  const watchlist = platformFilter
    ? allWatchlist.filter((w) => w.competitor.platform === platformFilter)
    : allWatchlist;
  const competitorIds = watchlist.map((w) => w.competitorId);

  // 订阅竞对名下的全部作品（用于统计），以及高热榜（表格取前 15）
  const allPosts = competitorIds.length
    ? await prisma.crawledPost.findMany({
        where: { competitorId: { in: competitorIds } },
        include: { competitor: true },
        orderBy: { hotScore: 'desc' },
      })
    : [];
  const topPosts = allPosts.slice(0, 50);
  // 趋势快照给榜单展示的 50 条作品取
  const topSnapshots = topPosts.length
    ? await prisma.postMetricSnapshot.findMany({
        where: { postId: { in: topPosts.map((p) => p.id) } },
        orderBy: { takenAt: 'asc' },
        select: { postId: true, takenAt: true, metrics: true },
      })
    : [];
  const snapsByPost = new Map<string, { takenAt: Date; metrics: string }[]>();
  for (const sn of topSnapshots) {
    if (!snapsByPost.has(sn.postId)) snapsByPost.set(sn.postId, []);
    snapsByPost.get(sn.postId)!.push({ takenAt: sn.takenAt, metrics: sn.metrics });
  }

  // ── 指标行 ──
  const accountCount = watchlist.length;
  const platformSet = new Set(watchlist.map((w) => w.competitor.platform));
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const weekPosts = allPosts.filter((p) => p.publishedAt && p.publishedAt >= weekAgo).length;
  const avgEngage =
    allPosts.length > 0
      ? allPosts.reduce((sum, p) => sum + engagementRate(parseJson<Metrics>(p.metrics, {})), 0) / allPosts.length
      : 0;

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

  const rosterOrEmpty =
    rosterRows.length === 0 ? (
      <Empty icon="🎯" text="还没有对标账号——贴一个同行主页链接就能建档，B站/抖音/小红书/YouTube/X 都支持" />
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
        <Stat label="平均互动率" value={`${(avgEngage * 100).toFixed(1)}%`} foot="点赞评论收藏 / 播放" />
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

      {/* ── 管理区：默认全部收起，用到再展开 ── */}
      <div className="stack" style={{ gap: 12, marginBottom: 20 }}>
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
      </div>

      <Card title="高热作品榜" sub={`TOP ${topPosts.length} 实时对标与深度拆解`}>
        <CompetitorTopPosts
          topPosts={topPosts}
          snapsByPostMap={Object.fromEntries(
            Array.from(snapsByPost.entries()).map(([k, v]) => [
              k,
              v.map((sn) => ({ takenAt: sn.takenAt.toISOString(), metrics: sn.metrics })),
            ])
          )}
        />
      </Card>
    </>
  );
}
