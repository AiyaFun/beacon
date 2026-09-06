'use client';

import { useState } from 'react';
import { parseJson, type Metrics } from '@/lib/json';
import { toDailySeries, dailyDeltas } from '@/lib/insight/timeseries';
import { sourceTier } from '@/lib/insight/csv';
import { TrendChart, type TrendPoint } from '@/components/TrendChart';
import { useI18n } from '@/lib/i18n';

type RawSnap = { takenAt: string | Date; metrics: string; source: string | null; milestone: string | null };

const METRIC_LABELS: Record<string, { zh: string; en: string }> = {
  views: { zh: '播放', en: 'Views' },
  likes: { zh: '点赞', en: 'Likes' },
  comments: { zh: '评论', en: 'Comments' },
  shares: { zh: '转发', en: 'Shares' },
  collects: { zh: '收藏', en: 'Collects' },
};

const METRIC_KEYS: (keyof Metrics)[] = ['views', 'likes', 'comments', 'shares', 'collects'];

// 单篇趋势的行内展开。用已随页面取回的快照本地计算逐日序列，不额外查库。
export function TrendCell({ publishedAt, snapshots }: { publishedAt: string | Date | null; snapshots: RawSnap[] }) {
  const { lang } = useI18n();
  const [open, setOpen] = useState(false);
  const [metric, setMetric] = useState<keyof Metrics>('views');

  if (snapshots.length === 0) {
    return <span className="small muted">—</span>;
  }
  // 【没有发布时间就没有「发布后第 N 天」这条轴】画不了逐日趋势。
  // 如实说破，而不是从今天起画一条假的曲线——那正是 2026-08-30 之前
  // 把回填时间当发布时间存下来所导致的（D+0 上挂着全生命周期的累计播放，
  // 一律被判成「首日爆发」）。
  if (!publishedAt) {
    return (
      <span
        className="small muted"
        title={lang === 'en' ? 'No publish date recorded, cannot calculate days post-publication' : '这条作品没有采到发布时间，算不出「发布后第 N 天」'}
      >
        {lang === 'en' ? 'No Publish Date' : '没有发布时间'}
      </span>
    );
  }

  return (
    <div className="stack" style={{ gap: 6 }}>
      <button className="btn btn-sm btn-ghost" onClick={() => setOpen((v) => !v)}>
        {open
          ? (lang === 'en' ? 'Hide Trend' : '收起趋势')
          : (lang === 'en' ? `View Trend · ${snapshots.length} pts` : `看趋势 · ${snapshots.length}点`)}
      </button>
      {open && <TrendBody publishedAt={publishedAt} snapshots={snapshots} metric={metric} setMetric={setMetric} lang={lang} />}
    </div>
  );
}

function TrendBody({
  publishedAt,
  snapshots,
  metric,
  setMetric,
  lang,
}: {
  publishedAt: string | Date;
  snapshots: RawSnap[];
  metric: keyof Metrics;
  setMetric: (m: keyof Metrics) => void;
  lang: string;
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
        <div className="small muted" style={{ marginBottom: 4 }}>
          {lang === 'en'
            ? 'Accumulating data points (connect extension to increase density)'
            : '数据点积累中（连接插件或授权后自动加密度）'}
        </div>
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

  const label = (lang === 'en' ? METRIC_LABELS[metric]?.en : METRIC_LABELS[metric]?.zh) ?? '';

  return (
    <div className="card" style={{ padding: 10, boxShadow: 'none', background: 'var(--surface-2)', minWidth: 300 }}>
      <div className="row wrap" style={{ gap: 4, marginBottom: 6 }}>
        {METRIC_KEYS.map((k) => (
          <button
            key={k}
            className={`badge ${metric === k ? 'badge-brand' : 'badge-gray'}`}
            style={{ cursor: 'pointer', border: 'none' }}
            onClick={() => setMetric(k)}
          >
            {lang === 'en' ? METRIC_LABELS[k]?.en : METRIC_LABELS[k]?.zh}
          </button>
        ))}
      </div>
      <TrendChart points={points} label={label} />
      <div className="row wrap small muted" style={{ gap: 10, marginTop: 4 }}>
        <span>● {lang === 'en' ? 'Official' : '官方'}</span>
        <span>○ {lang === 'en' ? 'Extension' : '插件'}</span>
        <span style={{ color: 'var(--text-3)' }}>● {lang === 'en' ? 'Manual' : '手填'}</span>
      </div>
    </div>
  );
}
