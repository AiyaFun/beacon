import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { parseJson, type Metrics } from '@/lib/json';
import { heatForSort } from '@/lib/insight/heat';
import { platformName, PLATFORMS, PLATFORM_LIST } from '@/lib/constants';
import { relTime } from '@/lib/format';
import { Card, Fold, Empty } from '@/components/ui';
import { WechatQuotaNote } from '@/components/WechatQuotaNote';
import { competitorSourceStatus } from '@/lib/adapters/registry';
import { CompetitorTopPosts } from './CompetitorTopPosts';
import { BatchCollectButton } from './BatchCollectButton';
import { ImportWechatArticles } from './ImportWechatArticles';
// 「插件能采的平台」只此一份（此前网页与 lib 各存一份 Set，改一处漏一处就会出现
// 「按钮说能采、后端说不能采」的对不上）
import { PLUGIN_COLLECTABLE } from '@/lib/ingest/competitor';
import { CompetitorConsole, type CompetitorItem } from './CompetitorConsole';
import { GrowthBoard } from '@/components/GrowthBoard';
import { loadRivalGrowth, WINDOW_KEYS } from '@/lib/insight/growth-rows';
import { growthOverWindow, windowRange, WINDOW_LABEL, windowLabel, type WindowKey } from '@/lib/insight/growth';
import type { PostGrowth } from './CompetitorTopPosts';
import { CollectionRuns } from '@/components/CollectionRuns';
import { listCollectionRuns } from '@/lib/ingest/collection-run';
import { readerVoice } from '@/lib/insight/reader-voice';
import { COMMENT_TEXT_PURGE_DAYS } from '@/lib/comment-collect-rules';
import { ReaderVoice } from '@/components/ReaderVoice';
import { getServerLang } from '@/lib/i18n/server';
import { getDictionary } from '@/lib/i18n/dict';

export const dynamic = 'force-dynamic';

export default async function CompetitorsPage({
  searchParams,
}: {
  searchParams: Promise<{ platform?: string; window?: string }>;
}) {
  const s = await getSession();
  const sp = await searchParams;
  const lang = await getServerLang();
  const dict = getDictionary(lang);
  const requestedPlatform = sp.platform && sp.platform in PLATFORMS ? sp.platform : null;
  // 增长区块的时间窗。与平台筛选共用 query string，两者互不干扰（切窗口不会丢掉平台筛选）
  const windowKey: WindowKey = (WINDOW_KEYS as string[]).includes(sp.window ?? '') ? (sp.window as WindowKey) : '7d';

  // 【三条一起发】原来是「订阅名单 → …一路串到底… → 采集台账 → 竞对增长」，
  // 台账和增长吊在链子最尾巴上，而它俩只吃 workspaceId / windowKey，谁也不等。
  // 生产库跨区 32ms 一跳，loadRivalGrowth 内部自己还有 3 跳，这条尾巴白等 128ms。
  const [allWatchlist, runs, rivalGrowth] = await Promise.all([
    prisma.watchlistItem.findMany({
      where: { workspaceId: s.workspaceId },
      include: { competitor: true },
      orderBy: { addedAt: 'desc' },
    }),
    // 采集台账：每次抓取覆盖了哪段时间。所有通道都只取「最近一小段」，
    // 没有这张表就只知道「库里有 N 篇」，不知道哪段时间采过、哪段是窟窿。
    listCollectionRuns(s.workspaceId, { scope: 'rival', take: 30 }),
    // 竞对增长。**只有竞对**——自有增长在数据看板那边（用户 2026-08-10 定的分工：
    // 各页只管自己的域）。它内部自己再查一遍全工作区名单，与这里的平台筛选无关，
    // 所以提前发不改变它看哪些账号。
    loadRivalGrowth(s.workspaceId, windowKey),
  ]);
  const { rows: growthRows, hasAny: hasGrowth } = rivalGrowth;

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

  // 订阅竞对名下的全部作品——**只取统计要的四列**。
  //
  // 【为什么不再整行取】这一份是用来算「近 7 天几条 / 平均互动率 / 每个号各几条」的，
  // 四个字段就够。原来写的是 `include: { competitor: true }` 的整行全量：
  // 标题、正文、封面地址、加上每条各拼一份竞对行，跟着订阅数一起线性膨胀，
  // 全部读进内存只为在 JS 里数一遍。订满 20 个号、每个号 500 条 = 一万行整表整行。
  // 榜单要展示的那 50 条另外取（下面一句），字段齐全，一条不少。
  const allPosts = competitorIds.length
    ? await prisma.crawledPost.findMany({
        where: { competitorId: { in: competitorIds } },
        select: { id: true, competitorId: true, publishedAt: true, metrics: true },
        orderBy: { publishedAt: 'desc' },
      })
    : [];
  // 榜取「互动量」最高的 50 条。**不再按 hotScore 排**——那个字段是 `views / 20000` 算的，
  // 抖音/小红书/X 的公开页没有播放量，它们恒为 0，于是这 50 个名额被有播放量的平台包圆，
  // 那些平台的作品根本进不了榜（见 lib/insight/heat.ts 顶部的说明）。
  // 现算而不是改库里的 hotScore：存量行还是旧语义，改定义会让新旧两种含义混在一张表里。
  const topIds = [...allPosts]
    .sort((a, b) => heatForSort(parseJson<Metrics>(b.metrics, {})) - heatForSort(parseJson<Metrics>(a.metrics, {})))
    .slice(0, 50)
    .map((p) => p.id);
  // 榜上这 50 条才把整行 + 竞对信息取齐（表格要标题、链接、账号名）
  const topPostRows = topIds.length
    ? await prisma.crawledPost.findMany({ where: { id: { in: topIds } }, include: { competitor: true } })
    : [];
  // `in` 查询不保证顺序，按刚才算好的热度次序摆回去
  const byId = new Map(topPostRows.map((p) => [p.id, p]));
  const topPosts = topIds.map((id) => byId.get(id)).filter((p): p is (typeof topPostRows)[number] => !!p);
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

  // 【删掉了一整排算完不显示的指标】1.3.62 把名单与指标行搬进 CompetitorConsole 之后，
  // 这里留下了 accountCount / platformSet / weekPosts / avgEngage / rosterRows /
  // neverCrawled 一整排——算得好好的，一个都没渲染（指标行本身是那次改版有意换掉的，
  // 换掉的是展示，没人把计算跟着删）。其中 avgEngage 还要把整个作品语料逐条 parseJson
  // 再求一次均值，纯粹白烧 CPU。留下的只有下面这一份 perCompetitor：competitorItems 真在用。
  const weekAgo = new Date(Date.now() - 7 * 86400000);

  // 每个竞对各自的在库/近 7 天条数：名单里「这个号到底采到东西没有」全靠它，
  // 从已取的 allPosts 里累加，不再多打一次库。
  const perCompetitor = new Map<string, { posts: number; weekPosts: number }>();
  for (const p of allPosts) {
    const st = perCompetitor.get(p.competitorId) ?? { posts: 0, weekPosts: 0 };
    st.posts += 1;
    if (p.publishedAt && p.publishedAt >= weekAgo) st.weekPosts += 1;
    perCompetitor.set(p.competitorId, st);
  }
  // ── 下面这两个是 1.3.62 那次改版的「误伤」，2026-09-12 接回来 ──
  //
  // 那次把名单和指标行搬进 CompetitorConsole，顺手把页面上这两个入口也带走了，
  // 而**它们背后的功能一直是好的**（actImportWechatArticles 在、插件批量采集协议也在）：
  //   · 插件一键采集：小红书/抖音/X 这些平台服务端根本取不到，只能由浏览器插件采。
  //     Console 头上的「采集全部」走的是服务端通道，替代不了它。
  //   · 公众号文章导入：公众号没有公开主页可采，导入本地导出的 JSON 是**唯一**通道。
  // 「功能还在、入口没了」在用户那儿等于功能没了，而且不报错——这是本仓库反复栽的那一类。
  const collectableCount = watchlist.filter((w) => PLUGIN_COLLECTABLE.has(w.competitor.platform)).length;
  const wechatAccounts = allWatchlist
    .filter((w) => w.competitor.platform === 'wechat')
    .map((w) => ({ id: w.competitorId, name: w.competitor.name, handle: w.competitor.handle }));

  // （platformCounts 原本在这里算：算完一次都没被读过，平台页签的条数由 CompetitorConsole 自己算。已删。）
  // 同数据看板：客户端组件收不了函数，链接在服务端算好
  const windowHrefs = Object.fromEntries(
    WINDOW_KEYS.map((k) => [
      k,
      `/competitors?${requestedPlatform ? `platform=${encodeURIComponent(requestedPlatform)}&` : ''}window=${k}#growth`,
    ]),
  );

  const sourceStatus = Object.fromEntries(
    PLATFORM_LIST.map((p) => [p.key, competitorSourceStatus(p.key)]),
  );

  const competitorItems: CompetitorItem[] = allWatchlist.map((w) => {
    const st = perCompetitor.get(w.competitorId) ?? { posts: 0, weekPosts: 0 };
    return {
      watchId: w.id,
      competitorId: w.competitorId,
      name: w.competitor.name,
      handle: w.competitor.handle,
      platform: w.competitor.platform,
      followers: w.competitor.followers,
      lastCrawledAt: w.competitor.lastCrawledAt ? w.competitor.lastCrawledAt.toISOString() : null,
      postsCount: st.posts,
      weekPosts: st.weekPosts,
      label: w.label,
      avatarUrl: w.competitor.avatar,
    };
  });

  const rivalVoiceQuotes = rivalVoice.recent.slice(0, 3).map((c) => ({
    quote: c.text,
  }));

  return (
    <>
      {/* 【把算好的话说出来】droppedFilter 此前只算不渲染：URL 上钉着一个已经没有账号的
          ?platform=，页面自动退回「全部」却一声不吭，用户看到的是「我的筛选怎么没了」。
          （本仓库反复栽在同一类缺陷上：值算出来了、界面上一个字都没有。） */}
      {droppedFilter && (
        <div className="card" style={{ padding: '10px 14px', marginBottom: 12, borderColor: 'var(--amber)' }}>
          <span className="small">
            {lang === 'en'
              ? `No accounts are being monitored on ${platformName(droppedFilter, lang)} any more — showing all platforms instead.`
              : `「${platformName(droppedFilter, lang)}」上已经没有在监控的账号了，已自动退回「全部平台」。`}
          </span>
        </div>
      )}

      <CompetitorConsole
        accounts={competitorItems}
        workspaceId={s.workspaceId}
        sourceStatus={sourceStatus}
        readerVoices={rivalVoiceQuotes}
        initialPlatform={platformFilter}
        wechatQuotaNote={<WechatQuotaNote workspaceId={s.workspaceId} lang={lang} />}
      />

      {/* 两条只有这里才有的采集通道（见上方 collectableCount / wechatAccounts 处的说明） */}
      {(collectableCount > 0 || wechatAccounts.length > 0) && (
        <div className="row wrap" style={{ gap: 10, marginTop: 12, alignItems: 'flex-start' }}>
          {collectableCount > 0 && <BatchCollectButton count={collectableCount} />}
          {wechatAccounts.length > 0 && (
            <details className="card" style={{ padding: '10px 14px', flex: '1 1 320px', minWidth: 0 }}>
              <summary className="small" style={{ cursor: 'pointer', fontWeight: 600 }}>
                {lang === 'en' ? 'Import Official Account articles' : '导入公众号竞对文章'}
              </summary>
              <div className="small muted" style={{ margin: '10px 0', lineHeight: 1.6 }}>
                {lang === 'en'
                  ? 'Official Account competitor articles can only be imported from exported JSON files.'
                  : '公众号没有可采的公开主页，竞对文章只能通过本地导出的 JSON 导入。'}
              </div>
              <ImportWechatArticles accounts={wechatAccounts} />
            </details>
          )}
        </div>
      )}

      <div id="all-posts" style={{ marginTop: 24 }}>

      {/* ── 辅助分析与台账区（双列平稳排布，不再抢占栅格位移） ── */}
      <div id="growth" />
      <div className="grid grid-2" style={{ marginBottom: 20 }}>
        {/* 竞对增长卡 */}
        <Fold
          title={lang === 'en' ? 'Competitor Growth' : '📈 竞对增长走势'}
          sub={lang === 'en' ? `${windowLabel(windowKey, lang)} net growth · One snapshot per crawl` : `${WINDOW_LABEL[windowKey]}净增 · 每次采集一个时点`}
          note={growthRows.length > 0 ? <span className="small muted hide-mobile">{growthRows.length} {lang === 'en' ? 'accounts' : '个账号'}</span> : undefined}
          defaultOpen={true}
        >
          {growthRows.length === 0 ? (
            <Empty text={lang === 'en' ? 'No competitor growth data yet — growth curves appear after at least two crawls.' : '还没有可用于算增长的竞对数据——增长需要至少两次采集。采两轮（或等定时采集跑过两轮）后，这里就会出现曲线。'} />
          ) : (
            <>
              {!hasGrowth && (
                <div className="small muted" style={{ marginBottom: 10 }}>
                  {lang === 'en' ? 'No crawls found in this window. Switch to a longer window or trigger a crawl.' : '这个时间窗内还没有竞对采集记录。换一个更长的时间窗，或者去采一次。'}
                </div>
              )}
              <GrowthBoard
                windowKey={windowKey}
                rows={growthRows}
                windowHrefs={windowHrefs}
                empty={lang === 'en' ? 'No competitor crawl records in this window.' : '这个时间窗内没有竞对采集记录。'}
              />
            </>
          )}
        </Fold>

        {/* 采集台账卡 */}
        <Fold
          title={lang === 'en' ? 'Crawl Logs' : '⏱ 采集记录台账'}
          sub={lang === 'en' ? 'Time coverage per crawl · Past 30 runs' : '每次抓取覆盖的时间段 · 最近 30 次'}
          note={
            runs[0] ? (
              <span className="small muted hide-mobile">{lang === 'en' ? `Latest ${relTime(runs[0].ranAt)}` : `最近一次 ${relTime(runs[0].ranAt)}`}</span>
            ) : undefined
          }
          defaultOpen={false}
        >
          <CollectionRuns
            rows={runs}
            emptyText={lang === 'en' ? 'No crawl records yet — click "Crawl Competitors" above or run extension.' : '还没有采集记录——点右上角「采集竞对」，或用插件采一次，这里会记下每批数据覆盖的时间段'}
            lang={lang}
          />
        </Fold>
      </div>

      <Card
        title={dict.competitors.topPostsTitle}
        sub={lang === 'en' ? `TOP ${topPosts.length} by engagement · ${windowLabel(windowKey, lang)} delta` : `按互动量取 TOP ${topPosts.length} · 每行带 ${WINDOW_LABEL[windowKey]}增长`}
      >
        <CompetitorTopPosts
          topPosts={topPosts}
          snapsByPostMap={Object.fromEntries(
            Array.from(snapsByPost.entries()).map(([k, v]) => [
              k,
              v.map((sn) => ({ takenAt: sn.takenAt.toISOString(), metrics: sn.metrics, source: sn.source })),
            ])
          )}
          postGrowth={postGrowth}
          windowLabel={windowLabel(windowKey, lang)}
        />
      </Card>
      </div>

      <div id="rival-voice" style={{ marginTop: 16 }} />
      <Card
        title={lang === 'en' ? '🗣 Competitor Audience Voice' : '🗣 同行读者原声'}
        sub={lang === 'en' ? `What readers care about in rival comment sections · Latest ${rivalVoice.total} comments` : `竞对作品评论区里读者在关心什么 · 最近 ${rivalVoice.total} 条 · 先判断他们的读者是不是你的读者`}
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
          emptyHint={lang === 'en' ? 'No competitor comments collected yet. Enable comment crawling in extension settings.' : '还没采到同行评论。在插件设置里打开「评论提问采集（竞对作品）」，然后到同行的作品详情页点侧栏的「读评论提问」。'}
        />
      </Card>
    </>
  );
}
