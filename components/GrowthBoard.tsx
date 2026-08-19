'use client';

import { useState } from 'react';
import { TrendChart, type TrendPoint } from '@/components/TrendChart';
import { fmtNum } from '@/lib/format';
import { platformName } from '@/lib/constants';

// 增长页的渲染层。所有数字都在服务端算好传进来（见 page.tsx），这里只负责展示与切换。
//
// 展示纪律和今天定的口径一致：**算不出来就画占位并说明原因，绝不显示 0**。
// 「涨了 0」和「这段时间没采集/这项没数据」在用户眼里必须长得不一样。

export type GrowthRow = {
  id: string;
  name: string;
  platform: string;
  scope: 'self' | 'rival';
  /** 区间净增；键缺席 = 这一项算不出来 */
  delta: Partial<Record<string, number>>;
  /** 起点观测值，用于算增长率 */
  baseline: Partial<Record<string, number>>;
  status: 'ok' | 'single-point' | 'no-data';
  /** 基准点落在窗口内 = 只是下界，要标注 */
  partial: boolean;
  /** 因某端没采到而算不出的键 */
  unavailable: string[];
  /** 时点序列（每次采集一个点） */
  points: { at: string; value: number | null }[];
  /** 这一行用哪个指标当主轴（有播放量的平台用播放，没有的用点赞） */
  primaryKey: string;
  primaryLabel: string;
  /** 这个平台只给约数（B站「1.0亿」这种），小于展示精度的变化看不出来 */
  approximate: boolean;
};

const NA = '—';

function pct(delta: number | undefined, base: number | undefined): string | null {
  if (typeof delta !== 'number' || typeof base !== 'number' || base <= 0) return null;
  return `${delta >= 0 ? '+' : ''}${((delta / base) * 100).toFixed(1)}%`;
}

function DeltaValue({ v }: { v: number | undefined }) {
  if (typeof v !== 'number') {
    return <span className="muted" title="这一项在区间两端没有都采到，算不出增长（不是没涨）">{NA}</span>;
  }
  const color = v > 0 ? 'var(--green)' : v < 0 ? 'var(--red)' : 'inherit';
  return <b style={{ color }}>{v > 0 ? '+' : ''}{fmtNum(v)}</b>;
}

// 主指标之外还要摆哪些增量。抽成常量：原来这串写死在 JSX 里，
// 判断「有没有可展开的内容」时还得再抄一遍同样的过滤条件，两处一定会漂移。
const OTHER_METRICS: [string, string][] = [
  ['views', '播放'], ['likes', '点赞'], ['comments', '评论'],
  ['collects', '收藏'], ['shares', '转发'], ['followers', '粉丝'],
];

function statusNote(row: GrowthRow): string | null {
  if (row.status === 'no-data') return '这个时间窗内没有采集记录';
  if (row.status === 'single-point') return '窗口内只采了一次，两点才算得出增长';
  if (row.partial) return '窗口开始前没有观测，下面是「首次采集→现在」的增长，实际涨幅只多不少';
  return null;
}

// 约数提醒。**只在增长为 0 时才说**——那正是会被误读成「不涨了」的时刻；
// 有明确涨幅时再挂一句只会变成噪音。
function approxNote(row: GrowthRow): string | null {
  if (!row.approximate || row.status !== 'ok') return null;
  const d = row.delta[row.primaryKey];
  if (d !== 0) return null;
  return `这个平台的公开页面只给约数（如「1.0亿」），${row.primaryLabel}的变化没到展示精度就看不出来——「+0」不等于真的没涨`;
}

function RowCard({ row }: { row: GrowthRow }) {
  const [open, setOpen] = useState(false);
  const note = statusNote(row);
  const approx = approxNote(row);
  const d = row.delta[row.primaryKey];
  const rate = pct(d, row.baseline[row.primaryKey]);

  // 时点曲线：x 轴是「第 N 次采集」，不是「发布后第 N 天」——这一页问的是日历时间上的增长
  const points: TrendPoint[] = row.points
    .filter((p) => p.value != null)
    .map((p, i) => ({ day: i + 1, value: p.value as number, delta: 0, tier: 'plugin' as const }));

  // 除主指标外还有几项能给出增量。没有的话就别摆一个点开是空的折叠头。
  const others = OTHER_METRICS.filter(
    ([k]) => k !== row.primaryKey && (row.delta[k] !== undefined || row.unavailable.includes(k)),
  );
  const expandable = others.length > 0 || points.length >= 2 || !!approx;

  return (
    <div className="card" style={{ padding: 12 }}>
      {/* 收起态只留一行结论：平台 · 名称 · 主指标增量。
          账号一多的时候，每行都摊开细节会让这张卡吃掉整屏，而用户先要的只是
          「谁在涨、涨了多少」——细节点开再看。 */}
      <div
        className="row-between"
        style={{ gap: 8, flexWrap: 'wrap', cursor: expandable ? 'pointer' : 'default' }}
        onClick={expandable ? () => setOpen((v) => !v) : undefined}
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : undefined}
        onKeyDown={expandable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); } } : undefined}
        aria-expanded={expandable ? open : undefined}
      >
        <div className="row" style={{ gap: 8, minWidth: 0 }}>
          {expandable && (
            <span className="small muted" aria-hidden="true" style={{ flex: 'none', width: 10 }}>
              {open ? '▾' : '▸'}
            </span>
          )}
          <span className="badge" style={{ flex: 'none' }}>{platformName(row.platform)}</span>
          <b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name}</b>
        </div>
        <div className="row" style={{ gap: 12, flex: 'none' }}>
          <span className="small muted">{row.primaryLabel}</span>
          <DeltaValue v={d} />
          {rate && <span className="small muted">{rate}</span>}
        </div>
      </div>

      {/* 状态说明（「窗口内只采了一次」这类）**收起时也要显示**：
          它就是这一行当下唯一的结论，藏进折叠里等于什么都没说。 */}
      {note && <div className="small muted" style={{ marginTop: 6 }}>{note}</div>}

      {open && (
        <>
          {approx && <div className="small muted" style={{ marginTop: 6 }}>⚠️ {approx}</div>}

          {others.length > 0 && (
            <div className="row wrap small" style={{ gap: 14, marginTop: 8 }}>
              {others.map(([k, label]) => (
                <span key={k}>
                  {label} <DeltaValue v={row.delta[k]} />
                </span>
              ))}
            </div>
          )}

          {points.length >= 2 && (
            <div style={{ marginTop: 8 }}>
              {/* 每次采集一个点。showDelta=false：这一页的点之间间隔不均匀
                  （采集是手动触发的），画「日增量柱」会把跨 5 天的增量当一天画。 */}
              <TrendChart points={points} label={row.primaryLabel} xUnit="observation" showDelta={false} />
              <div className="small muted" style={{ marginTop: 4 }}>
                横轴是第几次采集（不是日历天）：共 {points.length} 次观测。
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * 增长看板。**一个页面只看一侧**：数据看板看自有、竞对监控看竞对
 * （用户 2026-08-10 定的分工：各页只管自己的域，不并排）。
 * 所以这里不再自己分组，rows 传进来是哪一侧就渲染哪一侧。
 */
export function GrowthBoard({
  windowKey,
  rows,
  windowHrefs,
  empty,
}: {
  windowKey: string;
  rows: GrowthRow[];
  /**
   * 各时间窗对应的链接，形如 `{ '24h': '/data?...', '7d': …, '30d': … }`。
   *
   * ⚠️ **必须是纯数据，不能是 `(k) => string` 这样的函数**。本组件带 'use client'，
   * 而两个调用页都是服务端组件——Next 不允许跨这个边界传函数，会在**渲染时**抛
   * 「Functions cannot be passed directly to Client Components」。
   * 构建期查不出来（2026-08-11 就是这样把 /data 打挂在生产上的），所以这里写死约定。
   *
   * 由调用页算好：链接要带上本页自己的 query（竞对页的 platform、数据看板的 range+platform），
   * 写死在组件里的话，一点就把用户在本页的筛选清掉了。
   */
  windowHrefs: Record<string, string>;
  empty: string;
}) {
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row-between wrap" style={{ gap: 8 }}>
        <div className="row" style={{ gap: 6 }}>
          {[['24h', '24 小时'], ['7d', '7 天'], ['30d', '30 天']].map(([k, label]) => (
            <a
              key={k}
              href={windowHrefs[k] ?? '#'}
              className={`btn btn-sm ${windowKey === k ? 'btn-primary' : 'btn-ghost'}`}
            >
              {label}
            </a>
          ))}
        </div>
        <span className="small muted">{rows.length} 项</span>
      </div>

      {rows.length === 0 ? (
        <div className="small muted">{empty}</div>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          {rows.map((r) => <RowCard key={`${r.scope}-${r.id}`} row={r} />)}
        </div>
      )}
    </div>
  );
}
