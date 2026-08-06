'use client';

import { useState } from 'react';
import { parseJson, type Metrics } from '@/lib/json';
import { toDailySeries, dailyDeltas } from '@/lib/insight/timeseries';
import { sourceTier } from '@/lib/insight/csv';
import { TrendChart, type TrendPoint } from '@/components/TrendChart';

type RawSnap = { takenAt: string | Date; metrics: string; source: string | null; milestone: string | null };

const METRICS: { key: keyof Metrics; label: string }[] = [
  { key: 'views', label: '播放' },
  { key: 'likes', label: '点赞' },
  { key: 'comments', label: '评论' },
  { key: 'shares', label: '转发' },
  { key: 'collects', label: '收藏' },
];

// 单篇趋势的行内展开。用已随页面取回的快照本地计算逐日序列，不额外查库。
export function TrendCell({ publishedAt, snapshots }: { publishedAt: string | Date; snapshots: RawSnap[] }) {
  const [open, setOpen] = useState(false);
  const [metric, setMetric] = useState<keyof Metrics>('views');

  if (snapshots.length === 0) {
    return <span className="small muted">—</span>;
  }

  return (
    <div className="stack" style={{ gap: 6 }}>
      <button className="btn btn-sm btn-ghost" onClick={() => setOpen((v) => !v)}>
        {open ? '收起趋势' : `看趋势 · ${snapshots.length}点`}
      </button>
      {open && <TrendBody publishedAt={publishedAt} snapshots={snapshots} metric={metric} setMetric={setMetric} />}
    </div>
  );
}

function TrendBody({
  publishedAt,
  snapshots,
  metric,
  setMetric,
}: {
  publishedAt: string | Date;
  snapshots: RawSnap[];
  metric: keyof Metrics;
  setMetric: (m: keyof Metrics) => void;
}) {
  const pub = new Date(publishedAt);
  const series = toDailySeries(
    snapshots.map((s) => ({
      takenAt: new Date(s.takenAt),
      milestone: s.milestone,
      metrics: parseJson<Metrics>(s.metrics, {}),
      source: s.source,
    })),
    pub,
  );
  const deltas = dailyDeltas(series);

  // 退化形态：不足 2 个数据点不画曲线，改为里程碑数值列表 + 补数据引导（诚实，不拿散点伪装趋势）
  if (series.length < 2) {
    return (
      <div className="card" style={{ padding: 10, boxShadow: 'none', background: 'var(--surface-2)' }}>
        <div className="small muted" style={{ marginBottom: 4 }}>数据点积累中（连接插件或授权后自动加密度）</div>
        {series.map((p) => (
          <div key={p.day} className="row-between small">
            <span className="muted">D+{p.day}</span>
            <span className="mono">{(p.metrics[metric] as number) ?? 0}</span>
          </div>
        ))}
      </div>
    );
  }

  let prevVal = -1;
  const points: TrendPoint[] = series.map((sp) => {
    const value = (sp.metrics[metric] as number) ?? 0;
    const perDay = deltas.find((d) => d.day === sp.day)?.perDay[metric];
    const suspect = prevVal >= 0 && value < prevVal * 0.9;
    prevVal = Math.max(prevVal, value);
    return { day: sp.day, value, delta: (perDay as number) ?? 0, tier: sourceTier(sp.source), suspect };
  });

  const label = METRICS.find((m) => m.key === metric)?.label ?? '';

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
      <TrendChart points={points} label={label} />
      <div className="row wrap small muted" style={{ gap: 10, marginTop: 4 }}>
        <span>● 官方</span>
        <span>○ 插件</span>
        <span style={{ color: 'var(--text-3)' }}>● 手填</span>
      </div>
    </div>
  );
}
