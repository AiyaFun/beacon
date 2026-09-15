'use client';

import { useState } from 'react';
import { fmtNum } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export type PerformancePoint = {
  id: string;
  title: string;
  date: string;
  views: number | null;
  engagements: number | null;
};

/** Both series are counts, so every bar uses the same zero-based scale. */
export function PerformanceChart({ points }: { points: PerformancePoint[] }) {
  const { lang } = useI18n();
  const en = lang === 'en';
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const active = points.find((point) => point.id === selectedId) ?? points.at(-1);
  const hasValues = points.some((point) => point.views !== null || point.engagements !== null);
  const peak = Math.max(0, ...points.flatMap((point) => [point.views ?? 0, point.engagements ?? 0]));
  const magnitude = peak > 0 ? 10 ** Math.floor(Math.log10(peak / 4)) : 1;
  const step = Math.max(1, Math.ceil(peak / 4 / magnitude) * magnitude);
  const ceiling = step * 4;
  const format = (value: number | null) => value === null ? '—' : fmtNum(value);
  const exact = (value: number | null) => value === null ? (en ? 'Unavailable' : '未回流') : value.toLocaleString(en ? 'en-US' : 'zh-CN');
  const viewsLabel = en ? 'Views' : '播放';
  const engagementsLabel = en ? 'Engagements' : '互动';

  return (
    <section className="surface performance-chart" aria-label={en ? 'Recent post performance' : '近期作品表现'}>
      <div className="surface-head">
        <div>
          <strong>{en ? 'Recent Post Performance' : '近期作品表现'}</strong>
          <div className="meta">{en ? `Latest ${points.length} posts · By publication date` : `最近 ${points.length} 篇 · 按发布时间`}</div>
        </div>
        <div className="performance-legend">
          <span><i className="views" aria-hidden="true" />{viewsLabel}</span>
          <span><i className="engagements" aria-hidden="true" />{engagementsLabel}</span>
        </div>
      </div>
      {hasValues && active ? (
        <>
          <div className="performance-plot">
            <div className="performance-axis" aria-hidden="true">
              {[4, 3, 2, 1, 0].map((tick) => <span key={tick}>{format(step * tick)}</span>)}
            </div>
            <div className="performance-plot-body">
              <div className="performance-gridlines" aria-hidden="true">{[0, 1, 2, 3, 4].map((tick) => <span key={tick} />)}</div>
              <div className="performance-columns" style={{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }}>
                {points.map((point) => {
                  const description = `${point.date} · ${point.title} · ${viewsLabel} ${exact(point.views)} · ${engagementsLabel} ${exact(point.engagements)}`;
                  return (
                    <button key={point.id} type="button" className="performance-column" aria-label={description} title={description}
                      aria-pressed={active.id === point.id} onClick={() => setSelectedId(point.id)} onFocus={() => setSelectedId(point.id)}>
                      <span className="performance-bars" aria-hidden="true">
                        <span className="performance-bar views" data-value={point.views ?? undefined} style={{ height: `${(point.views ?? 0) / ceiling * 100}%` }} />
                        <span className="performance-bar engagements" data-value={point.engagements ?? undefined} style={{ height: `${(point.engagements ?? 0) / ceiling * 100}%` }} />
                      </span>
                      <span className="performance-date">{point.date}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="performance-detail" aria-live="polite" aria-atomic="true">
            <div className="performance-work"><span className="meta">{active.date} · {en ? 'Selected post' : '选中作品'}</span><strong title={active.title}>{active.title}</strong></div>
            <dl>
              <div><dt>{viewsLabel}</dt><dd title={exact(active.views)}>{format(active.views)}</dd></div>
              <div><dt>{engagementsLabel}</dt><dd title={exact(active.engagements)}>{format(active.engagements)}</dd></div>
            </dl>
          </div>
          <p className="performance-note">{en ? 'Select a bar group for details. Engagements = synced likes + comments + saves + shares; unavailable values show —.' : '点选柱组查看明细。互动为已回流的赞、评、藏、转之和；缺失项显示 —。'}</p>
        </>
      ) : (
        <div className="performance-empty"><strong>{en ? 'No performance data yet' : '暂无作品表现数据'}</strong><p>{en ? 'Sync post metrics or change the filters to see the comparison.' : '回流作品数据或调整筛选后，这里会显示真实对比。'}</p></div>
      )}
    </section>
  );
}
