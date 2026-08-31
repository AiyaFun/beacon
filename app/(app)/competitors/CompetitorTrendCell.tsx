'use client';

import { useState } from 'react';
import type { MetricCountKey } from '@/lib/json';
import { competitorTrend, growthSummary, observationRecords, type ObservationRow } from '@/lib/insight/competitor-trend';
import { TrendChart, type TrendPoint } from '@/components/TrendChart';
import { fmtNum, fmtDate } from '@/lib/format';

type RawSnap = { takenAt: string | Date; metrics: string; source?: string | null };

const METRICS: { key: MetricCountKey; label: string }[] = [
  { key: 'views', label: '播放' },
  { key: 'likes', label: '点赞' },
  { key: 'comments', label: '评论' },
  { key: 'shares', label: '转发' },
  { key: 'collects', label: '收藏' },
];

// 竞对作品趋势的行内展开。快照随页面一起取回，本地算，不额外查库。
//
// 与自有作品的 TrendCell 有意长得不同：这里 X 轴是**观测序号**而不是「发布后第 N 天」，
// 且不画日增量柱。原因见 lib/insight/competitor-trend.ts——竞对的采集节奏由用户决定，
// 把散点按日排出来会把「你多久采一次」冒充成「它涨得多快」。
export function CompetitorTrendCell({ snapshots }: { snapshots: RawSnap[] }) {
  const [open, setOpen] = useState(false);
  const [metric, setMetric] = useState<MetricCountKey>('views');

  const trend = competitorTrend(snapshots.map((s) => ({ takenAt: new Date(s.takenAt), metrics: s.metrics })));

  // 一个观测点画不出趋势，也不值得给个能点开的空壳按钮
  if (trend.sample === 0) return <span className="small muted">—</span>;
  if (trend.sample < 2) {
    return (
      <span className="small muted" title="再采集一次即可看到变化——趋势需要至少两次观测">
        仅 1 次观测
      </span>
    );
  }

  const summary = growthSummary(trend, 'views');
  // 数据记录：每次采集摊成一行（含来源与相对上次的增量）。与图同源，不额外查库。
  const records = observationRecords(
    snapshots.map((x) => ({ takenAt: new Date(x.takenAt), metrics: x.metrics, source: x.source })),
    METRICS.map((m) => m.key),
  );

  return (
    <div className="stack" style={{ gap: 4 }}>
      <button className="btn btn-sm btn-ghost" onClick={() => setOpen((v) => !v)}>
        {open ? '收起趋势' : `看趋势 · ${trend.sample}次`}
      </button>
      {!open && summary && <span className="small" style={{ color: 'var(--green)' }}>{summary}</span>}
      {open && <TrendBody trend={trend} records={records} metric={metric} setMetric={setMetric} />}
    </div>
  );
}

function TrendBody({
  trend,
  records,
  metric,
  setMetric,
}: {
  trend: ReturnType<typeof competitorTrend>;
  records: ObservationRow[];
  metric: MetricCountKey;
  setMetric: (m: MetricCountKey) => void;
}) {
  let prevVal = -1;
  const points: TrendPoint[] = trend.points.map((p) => {
    const value = p.metrics[metric] ?? 0;
    const suspect = prevVal >= 0 && value < prevVal * 0.9; // 平台回收流量 → 淡化而不是当成真跌
    prevVal = Math.max(prevVal, value);
    // delta 传 0：竞对没有可信的「日增」口径（采集间隔不规律），日增柱一律不画
    return { day: p.index, value, delta: 0, tier: 'plugin', suspect };
  });

  const label = METRICS.find((m) => m.key === metric)?.label ?? '';
  // 【?? 0 会把「算不出来」印成「没涨」】首末观测有一端没采到这一项时，
  // competitorTrend 刻意不写这个键——那表示「这段时间涨了多少，我们不知道」。
  // 印成 0 就又把缺席说成了一个确定的结论。
  const growth = trend.growth?.[metric] ?? null;
  const irregular = trend.points.some((p) => p.gapDays !== null && p.gapDays > 3);

  return (
    <div className="card" style={{ padding: 10, boxShadow: 'none', background: 'var(--surface-2)', minWidth: 300 }}>
      <div className="row wrap" style={{ gap: 4, marginBottom: 6 }}>
        {METRICS.map((m) => (
          <button
            key={m.key}
            className={`badge ${metric === m.key ? 'badge-brand' : 'badge-gray'}`}
            style={{ cursor: 'pointer', border: 'none' }}
            onClick={() => setMetric(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>
      {/* 横轴是观测序号、且不画日增量柱：竞对采集节奏不规律，没有可信的「发布后第 N 天」
          与「日增」口径。图上的标注必须和下面那句说明一致，不能一个说 D+N 一个说第几次采集。 */}
      <TrendChart points={points} label={label} xUnit="observation" showDelta={false} />
      <div className="small muted" style={{ marginTop: 4, lineHeight: 1.6 }}>
        横轴是<b>第几次采集</b>（不是发布后第几天）：{trend.sample} 次观测跨 {trend.spanDays} 天，
        {growth === null
          ? <>首末两次观测里有一次没采到{label}，<b>这段时间涨了多少算不出来</b>。</>
          : <>{label}净增 <b className="mono">{fmtNum(growth)}</b>。</>}
        {irregular && '采集间隔不均匀，两点之间的落差是这段时间的累计变化，不代表日增。'}
      </div>
      {/* 数据记录：每次采集一行，标明**从哪采的**、这次多少、比上次多多少。
          图回答「大致在涨还是在停」，这张表回答「哪一次采到了什么、这段时间涨了多少」。
          ⚠️ 原来这里是 `p.metrics[metric] ?? 0` —— 把「这次没采到这一项」印成 0，
          于是抖音主页采的那几次评论数全是 0，看起来像「这条作品没人评论」。 */}
      <div className="stack" style={{ gap: 3, marginTop: 8 }}>
        <div className="small muted" style={{ fontWeight: 600 }}>数据记录 · {label}</div>
        {records.map((r, i) => {
          const c = r.cells.find((x) => x.key === metric)!;
          return (
            <div key={i} className="row-between small" style={{ gap: 8 }}>
              <span className="muted" style={{ whiteSpace: 'nowrap' }}>
                {fmtDate(r.takenAt)}
                <span style={{ opacity: 0.7 }}> · {r.sourceText}</span>
                {r.gapDays !== null && r.gapDays > 0 && <span style={{ opacity: 0.7 }}>（隔 {r.gapDays} 天）</span>}
              </span>
              <span className="row" style={{ gap: 8, whiteSpace: 'nowrap' }}>
                <b className="mono">{c.value === null ? '—' : fmtNum(c.value)}</b>
                {c.delta !== null ? (
                  <span className="mono" style={{ color: c.delta > 0 ? 'var(--green)' : c.delta < 0 ? 'var(--red)' : 'var(--text-3)' }}>
                    {c.delta > 0 ? '+' : ''}{fmtNum(c.delta)}
                  </span>
                ) : (
                  <span className="muted" title={c.note ?? ''} style={{ fontSize: 11 }}>{c.note}</span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
