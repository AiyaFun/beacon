import { prisma } from '@/lib/db';
import { PageHead, Card, Stat, Empty } from '@/components/ui';
import { fmtDateTime, fmtNum } from '@/lib/format';
import { platformName } from '@/lib/constants';
import { sourceHealthBoard } from '@/lib/adapters/registry';
import { crawlerSummary, CRAWLER_HIT_RETENTION_DAYS } from '@/lib/geo/crawler-log';
import { beijingDayKey } from '@/lib/beijing';
import {
  AI_AGENTS, AI_ENGINES_WITHOUT_PUBLIC_UA, PURPOSE_LABEL, AI_CRAWLER_VERSION,
  AI_CRAWLER_NEXT_REVIEW, findAgent, type AiAgentPurpose,
} from '@/lib/geo/ai-crawler';

export const dynamic = 'force-dynamic';

// 采集健康（跨租户）：数据源通道 + 最近失败任务 + 带 note 的采集批次。
//
// 「带 note 的批次」是这一页的核心信号：CollectionRun.note 只在**降级/节流/没采到**时才有值
//（lib/ingest/parser-health.ts 写的降级说明也落在这里）。它变多 = 某个平台大概率改版了。
// 这一页只做「看见」，自愈闭环是另一件事（见 /ops/parser）。
export default async function OpsHealthPage() {
  const since = new Date(Date.now() - 7 * 86_400_000);

  const [board, failedJobs, notedRuns, runCount, crawlers] = await Promise.all([
    sourceHealthBoard(),
    prisma.jobRun.findMany({
      where: { status: 'failed', startedAt: { gte: since } },
      orderBy: { startedAt: 'desc' },
      take: 30,
    }),
    prisma.collectionRun.findMany({
      where: { ranAt: { gte: since }, note: { not: null } },
      orderBy: { ranAt: 'desc' },
      take: 50,
    }),
    prisma.collectionRun.count({ where: { ranAt: { gte: since } } }),
    crawlerSummary(30),
  ]);

  // 已经来过的爬虫 vs 表里有但一次都没来过的。**两边都要显示**：
  // 只显示来过的，会让人以为「没列出来的就是不存在」——而真相是「它没来过」，
  // 这恰恰是这一页最该回答的问题。
  const seen = new Set(crawlers.map((c) => c.agent));
  const neverSeen = AI_AGENTS.filter((a) => a.kind === 'crawler' && !seen.has(a.token));

  const notedByPlatform = new Map<string, number>();
  for (const r of notedRuns) notedByPlatform.set(r.platform, (notedByPlatform.get(r.platform) ?? 0) + 1);

  return (
    <>
      <PageHead title="采集健康" desc="近 7 天 · 跨租户视角" />

      {/* ── AI 爬虫来访（2026-08-29）──
          【为什么这一页放得下它】这一页问的是「采集这条链健不健康」，
          而它一直只看**出站**（我们抓别人）。入站（AI 抓我们）是同一条链的另一半，
          且是整个 GEO 判断里**唯一不靠推理、只靠事实**的那个数字。 */}
      <Card
        title="AI 爬虫来访 · 近 30 天"
        sub={`本部署自己的站被谁抓过 · 口径 ${AI_CRAWLER_VERSION} · 下次校准 ${AI_CRAWLER_NEXT_REVIEW}`
          + ` · 留存 ${CRAWLER_HIT_RETENTION_DAYS} 天`}
      >
        <p className="small muted" style={{ margin: '0 0 10px', lineHeight: 1.9 }}>
          这里记的是<b>别人来抓我们</b>，不是我们去抓别人——后者在上面那几张卡里。
          它回答不了「有没有被 AI 引用」，但能回答<b>「有没有被看见」</b>，而后者是前者的必要条件，
          也是这条链上第一个不靠推理的数字。只记<b>爬虫名、路径、天</b>，不记 IP、不记完整 UA、不记查询串。
        </p>
        {crawlers.length === 0 ? (
          <Empty text="近 30 天没有识别到任何 AI 爬虫。这本身就是一条结论——不是「还没统计」，是它们确实没来（或没来读 robots.txt）。" />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr><th>爬虫</th><th>用途</th><th>来访次数</th><th>来过几天</th><th>最近一次</th></tr>
              </thead>
              <tbody>
                {crawlers.map((c) => (
                  <tr key={c.agent}>
                    <td>
                      {/* 【出处要点得开】表里每条都记了官方文档地址，却没人看得见——
                          于是「这个名字是哪来的、还准不准」半年后没人敢改。
                          这正是 HeiGe-GEO 审查里「方法论数字静态快照」那条病灶的形状 */}
                      {(() => {
                        const a = findAgent(c.agent);
                        return a
                          ? <a href={a.doc} target="_blank" rel="noreferrer noopener"><b>{c.agent}</b></a>
                          : <b>{c.agent}</b>;
                      })()}
                    </td>
                    {/* 用途必须显示：拦掉 search 等于从此不可能被引用，
                        与拦掉 training 完全不是一个代价，合并成「AI 爬虫」就必然有人拦错 */}
                    <td className="small muted">{PURPOSE_LABEL[c.purpose as AiAgentPurpose] ?? c.purpose}</td>
                    <td>{fmtNum(c.hits)}</td>
                    {/* 【为什么单列「来过几天」】一天来一千次是一次批量抓取，
                        连着三十天每天来一次才说明它在持续跟进——只看总次数会把这两件事混成一个数 */}
                    <td>{c.days}</td>
                    <td className="small muted">{fmtDateTime(c.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* 【过期了要说】一张带「下次校准日期」却从不提醒的表，到期后不会变红，
            只会安静地继续用一份已经不成立的清单做拦截决定 */}
        {/* 【按北京日比，不能用 toISOString().slice】容器跑 UTC，
            那样切出来的是 UTC 日——北京时间清晨那几个小时会差一天。
            本库为此专门立了 lib/beijing.ts，守卫也钉着这条（它当场把我抓了出来）*/}
        {AI_CRAWLER_NEXT_REVIEW < beijingDayKey() && (
          <p className="small" style={{ margin: '10px 0 0', color: 'var(--amber, #b45309)', lineHeight: 1.9 }}>
            <b>这张表已经过了校准日期（{AI_CRAWLER_NEXT_REVIEW}）。</b>
            AI 爬虫半年就会变一批（OAI-SearchBot 是 2024 下半年才有的）。
            过期不改的后果不是「旧」，是拿一份已经不成立的清单去决定拦谁放谁——
            请重新核对 lib/geo/ai-crawler.ts。
          </p>
        )}

        {neverSeen.length > 0 && (
          <p className="small muted" style={{ margin: '10px 0 0', lineHeight: 1.9 }}>
            <b>认得但没来过：</b>{neverSeen.map((a) => a.token).join('、')}。
            没来过<b>不等于</b>它不抓中文站——也可能是它没读过我们的 robots.txt。
          </p>
        )}

        {/* 【「不知道」必须显式列出来】不列的话这就是一份纯英文清单，
            用户会得出「国产引擎不抓我」这个结论，而真相是我们不知道它们用什么名字抓。
            与 ai-source.ts 里那六个 unknown 是同一条纪律：缺席不许当成 0 */}
        <p className="small muted" style={{ margin: '8px 0 0', lineHeight: 1.9 }}>
          <b>认不出的：</b>
          {AI_ENGINES_WITHOUT_PUBLIC_UA.map((e) => e.name).join('、')}
          ——它们<b>没有公开披露独立的爬虫 UA</b>，所以这张表里不可能有它们。
          这是「我们不知道」，不是「它们没来」。
        </p>
      </Card>

      <div className="grid grid-4" style={{ marginBottom: 16, marginTop: 16 }}>
        <Stat label="采集批次" value={fmtNum(runCount)} foot="近 7 天全平台" />
        <Stat label="异常批次" value={fmtNum(notedRuns.length)} foot="降级 / 节流 / 空批" />
        <Stat label="失败任务" value={fmtNum(failedJobs.length)} foot="定时与后台任务" />
        <Stat label="热榜数据源" value={board.hot.length} foot="含降级链路" />
      </div>

      <Card title="异常批次按平台" sub="某个平台突然变多，多半是它改版了" style={{ marginBottom: 16 }}>
        {notedByPlatform.size === 0 ? (
          <div className="small" style={{ color: 'var(--green)' }}>近 7 天没有异常批次。</div>
        ) : (
          <div className="row wrap" style={{ gap: 8 }}>
            {[...notedByPlatform.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([p, n]) => (
                <span key={p} className={`badge ${n >= 5 ? 'badge-red' : 'badge-amber'}`}>
                  {platformName(p) || p} · {n} 次
                </span>
              ))}
          </div>
        )}
      </Card>

      <div className="grid grid-2">
        <Card title="最近的异常批次" sub="note 是写给人看的降级说明">
          {notedRuns.length === 0 ? (
            <Empty icon="✅" text="没有异常批次。" />
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {notedRuns.slice(0, 20).map((r) => (
                <div key={r.id} className="small">
                  <span className="muted">{fmtDateTime(r.ranAt)}</span>{' '}
                  <span className="badge badge-gray">{platformName(r.platform) || r.platform}</span>{' '}
                  <span className="muted">{r.scope === 'self' ? '自有' : '竞对'} · {r.channel}</span>
                  <div style={{ color: 'var(--amber)' }}>{r.note}</div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="失败任务" sub="worker / 定时任务">
          {failedJobs.length === 0 ? (
            <Empty icon="✅" text="近 7 天无失败任务。" />
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {failedJobs.map((j) => (
                <div key={j.id} className="small">
                  <span className="muted">{fmtDateTime(j.startedAt)}</span> <strong>{j.name}</strong>
                  <div style={{ color: 'var(--red)' }}>{j.detail ?? '（无详情）'}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
