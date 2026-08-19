import { prisma } from '@/lib/db';
import { PageHead, Card, Stat, Empty } from '@/components/ui';
import { fmtDateTime, fmtNum } from '@/lib/format';
import { platformName } from '@/lib/constants';
import { sourceHealthBoard } from '@/lib/adapters/registry';

export const dynamic = 'force-dynamic';

// 采集健康（跨租户）：数据源通道 + 最近失败任务 + 带 note 的采集批次。
//
// 「带 note 的批次」是这一页的核心信号：CollectionRun.note 只在**降级/节流/没采到**时才有值
//（lib/ingest/parser-health.ts 写的降级说明也落在这里）。它变多 = 某个平台大概率改版了。
// 这一页只做「看见」，自愈闭环是另一件事（见 /ops/parser）。
export default async function OpsHealthPage() {
  const since = new Date(Date.now() - 7 * 86_400_000);

  const [board, failedJobs, notedRuns, runCount] = await Promise.all([
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
  ]);

  const notedByPlatform = new Map<string, number>();
  for (const r of notedRuns) notedByPlatform.set(r.platform, (notedByPlatform.get(r.platform) ?? 0) + 1);

  return (
    <>
      <PageHead title="采集健康" desc="近 7 天 · 跨租户视角" />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
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
