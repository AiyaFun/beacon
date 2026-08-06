import { fmtNum } from '@/lib/format';

// 单篇作品趋势图：零依赖手绘 SVG（项目惯例，无图表库），暗色靠 CSS 变量自适应。
// 上半累计折线 + 下半日增量柱。x 轴按 day 值定位（缺值会留出空档，诚实暴露数据不连续）。
// 数据点按来源分档着色：官方=实心、插件=空心、手填=灰。点少于 2 个不画曲线（由调用侧退化处理）。
//
// ⚠️ x 轴语义由调用方给（xUnit），**不许写死成 D+N**。自有作品的 day 是「发布后第几天」，
// 竞对作品的 day 是「第几次采集」（采集节奏不规律，没有逻辑日可言，见 lib/insight/competitor-trend.ts）。
// 图上标着 D+N、说明文字却写「第几次采集」，就是图在骗人——两者必须由同一个 prop 决定。
// 同理 showDelta：竞对没有可信的日增口径，日增量柱区就整块不画，而不是画一排 0。

export type TrendPoint = {
  day: number;
  value: number; // 累计值
  delta: number; // 日均增量（已折算）
  tier: 'official' | 'plugin' | 'manual';
  suspect?: boolean; // 数据回退存疑（淡化显示）
};

const W = 340;
const H_FULL = 150;
const H_LINE_ONLY = 110; // 不画日增量柱时收掉下半，避免留一块空白假装有内容
const PAD_L = 8;
const PAD_R = 8;
const LINE_TOP = 14;
const LINE_BOT = 92; // 折线区底
const BAR_TOP = 104;
const BAR_BOT = 138; // 柱区底

function tierFill(tier: TrendPoint['tier']): string {
  if (tier === 'official') return 'var(--brand)';
  if (tier === 'plugin') return 'var(--surface)';
  return 'var(--text-3)';
}

export function TrendChart({
  points,
  label,
  xUnit = 'day',
  showDelta = true,
}: {
  points: TrendPoint[];
  label: string;
  /** x 轴语义：'day'=发布后第 N 天（D+N）；'observation'=第 N 次观测（#N） */
  xUnit?: 'day' | 'observation';
  /** 是否画下半的日增量柱。无可信日增口径时传 false，整块不画。 */
  showDelta?: boolean;
}) {
  if (points.length < 2) return null;
  const days = points.map((p) => p.day);
  const minDay = Math.min(...days);
  const maxDay = Math.max(...days, minDay + 1);
  const maxVal = Math.max(1, ...points.map((p) => p.value));
  const maxDelta = Math.max(1, ...points.map((p) => p.delta));

  const H = showDelta ? H_FULL : H_LINE_ONLY;
  const xTick = (d: number) => (xUnit === 'observation' ? `#${d + 1}` : `D+${d}`);
  const x = (day: number) => PAD_L + ((day - minDay) / (maxDay - minDay)) * (W - PAD_L - PAD_R);
  const yLine = (v: number) => LINE_BOT - (v / maxVal) * (LINE_BOT - LINE_TOP);
  const barW = Math.max(6, ((W - PAD_L - PAD_R) / (maxDay - minDay + 1)) * 0.6);

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.day).toFixed(1)},${yLine(p.value).toFixed(1)}`).join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W, display: 'block' }} role="img" aria-label={`${label}趋势`}>
      {/* 折线区网格基线 */}
      <line x1={PAD_L} y1={LINE_BOT} x2={W - PAD_R} y2={LINE_BOT} stroke="var(--border)" strokeWidth="1" />
      {/* 累计折线 */}
      <path d={linePath} fill="none" stroke="var(--brand)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {/* 数据点：按来源分档 */}
      {points.map((p, i) => (
        <g key={i} opacity={p.suspect ? 0.4 : 1}>
          <circle
            cx={x(p.day)}
            cy={yLine(p.value)}
            r="3.5"
            fill={tierFill(p.tier)}
            stroke="var(--brand)"
            strokeWidth={p.tier === 'plugin' ? 1.5 : 0}
          />
        </g>
      ))}
      {/* 峰值标注 */}
      <text x={x(points[points.length - 1].day)} y={yLine(maxVal) - 4} fontSize="10" fill="var(--text-3)" textAnchor="end">
        {fmtNum(maxVal)}
      </text>

      {/* 日增量柱（无可信日增口径时整块不画） */}
      {showDelta && (
        <>
          <line x1={PAD_L} y1={BAR_BOT} x2={W - PAD_R} y2={BAR_BOT} stroke="var(--border)" strokeWidth="1" />
          {points.map((p, i) => {
            const h = (p.delta / maxDelta) * (BAR_BOT - BAR_TOP);
            return (
              <rect
                key={i}
                x={x(p.day) - barW / 2}
                y={BAR_BOT - h}
                width={barW}
                height={Math.max(0, h)}
                rx="1.5"
                fill="var(--accent)"
                opacity={p.suspect ? 0.35 : 0.75}
              />
            );
          })}
          <text x={PAD_L} y={BAR_TOP - 2} fontSize="9" fill="var(--text-3)">日增量</text>
        </>
      )}

      {/* x 轴标签（首末），语义由 xUnit 决定 */}
      <text x={x(minDay)} y={H - 2} fontSize="10" fill="var(--text-3)" textAnchor="start">{xTick(minDay)}</text>
      <text x={x(maxDay)} y={H - 2} fontSize="10" fill="var(--text-3)" textAnchor="end">{xTick(maxDay)}</text>
    </svg>
  );
}
