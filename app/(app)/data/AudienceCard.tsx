import { Card, Empty, Meter } from '@/components/ui';
import { fmtNum } from '@/lib/format';
import { platformName } from '@/lib/constants';
import { topBuckets, type FollowerPoint, type AudienceBuckets } from '@/lib/ingest/own-account';

// 账号级数据卡：粉丝增长 + 受众画像。两者都只有创作者后台给得到，作品级数据推不出来。
//
// 退化形态是这张卡的重点：粉丝曲线 <2 个观测点不画线、受众画像没数据就直说没数据 +
// 指路怎么拿到，绝不用「暂无数据」四个字打发人（用户不知道该做什么才能有数据）。

const DIMS: { key: keyof Omit<AudienceBuckets, 'updatedAt'>; label: string }[] = [
  { key: 'gender', label: '性别' },
  { key: 'age', label: '年龄' },
  { key: 'region', label: '地域' },
  { key: 'interest', label: '兴趣' },
];

export function AudienceCard({
  platform,
  series,
  audience,
}: {
  platform: string;
  series: FollowerPoint[];
  audience: AudienceBuckets | null;
}) {
  const withFollowers = series.filter((p) => p.followers !== null);
  const latest = withFollowers[withFollowers.length - 1] ?? null;
  const first = withFollowers[0] ?? null;
  // 净增优先用后台直接给的 delta 合计（去重后的真实值），没有才退回首末差
  const deltaSum = series.reduce((s, p) => s + (p.delta ?? 0), 0);
  const hasDelta = series.some((p) => p.delta !== null);
  const netGrowth = hasDelta
    ? deltaSum
    : latest && first && latest.followers !== null && first.followers !== null
      ? latest.followers - first.followers
      : null;

  const hasAudience =
    audience && DIMS.some((d) => Object.keys(audience[d.key] ?? {}).length > 0);

  if (withFollowers.length === 0 && !hasAudience) {
    return (
      <Card title="👥 粉丝与受众" sub={`${platformName(platform)} · 只有创作者后台给得到`} style={{ marginBottom: 16 }}>
        <Empty
          icon="📈"
          text="还没有账号级数据——用插件在你自己的创作者后台点一次「这是我的作品」，粉丝曲线与受众画像会一起回填；在自己的主页上点同一个按钮，也能记下当天的粉丝数（受众画像仍只有后台给得到）。也可以到「数据看板」手动回填基础受众数据"
        />
      </Card>
    );
  }

  return (
    <Card
      title="👥 粉丝与受众"
      sub={`${platformName(platform)} · 来自创作者后台回填，非推测`}
      style={{ marginBottom: 16 }}
    >
      {/* 粉丝 */}
      {withFollowers.length > 0 && (
        <div style={{ marginBottom: hasAudience ? 18 : 0 }}>
          <div className="row wrap" style={{ gap: 20, marginBottom: 10 }}>
            <div>
              <div className="small muted">当前粉丝</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{fmtNum(latest?.followers ?? 0)}</div>
            </div>
            {netGrowth !== null && (
              <div>
                <div className="small muted">{withFollowers.length} 天累计净增</div>
                <div
                  style={{
                    fontSize: 22,
                    fontWeight: 700,
                    // 掉粉是真实信号，如实标红，不粉饰
                    color: netGrowth > 0 ? 'var(--green)' : netGrowth < 0 ? 'var(--red)' : undefined,
                  }}
                >
                  {netGrowth > 0 ? '+' : ''}
                  {fmtNum(netGrowth)}
                </div>
              </div>
            )}
          </div>

          {withFollowers.length < 2 ? (
            <div className="small muted">
              只有 1 个观测点，画不出曲线——再回填一次即可看到增长趋势。
            </div>
          ) : (
            <FollowerBars series={withFollowers} />
          )}
        </div>
      )}

      {/* 受众画像 */}
      {hasAudience ? (
        <div className="stack" style={{ gap: 14 }}>
          {DIMS.map((d) => {
            const top = topBuckets(audience![d.key] ?? {}, 4);
            if (top.length === 0) return null;
            return (
              <div key={d.key}>
                <div className="small muted" style={{ marginBottom: 6 }}>{d.label}分布</div>
                <div className="stack" style={{ gap: 6 }}>
                  {top.map((t) => (
                    <div key={t.name}>
                      <div className="row-between" style={{ marginBottom: 3 }}>
                        <span className="small">{t.name}</span>
                        <span className="small mono">{Math.round(t.share * 100)}%</span>
                      </div>
                      <Meter value={t.share * 100} color="var(--brand)" />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
          <div className="small muted" style={{ lineHeight: 1.6 }}>
            这份分布已注入 AI 的选题精排与智囊团会诊——判断「选题跟你的读者对不对得上」时以它为准，
            与人设卡里写的受众不一致时 AI 会直接指出差异。
          </div>
        </div>
      ) : (
        <div className="small muted" style={{ lineHeight: 1.6 }}>
          受众画像还没回填。在创作者后台的「粉丝/受众分析」页再点一次插件按钮即可——
          有了它，AI 判断选题匹配度时就不必再靠人设卡里手写的那句话推测。
        </div>
      )}
    </Card>
  );
}

// 粉丝净增柱状图：零依赖手绘 SVG（项目惯例）。
// 画的是**净增**不是总数：总数曲线在基数大时看不出变化，净增才是「这周做得怎么样」。
// 缺失的日期**不补齐**——后台没给的那天就是没数据，插值会让「你多久回填一次」看起来像增长节奏。
function FollowerBars({ series }: { series: FollowerPoint[] }) {
  const pts = series.slice(-30);
  const deltas = pts.map((p, i) => {
    if (p.delta !== null) return p.delta;
    const prev = pts[i - 1];
    if (prev && prev.followers !== null && p.followers !== null) return p.followers - prev.followers;
    return 0;
  });
  const max = Math.max(1, ...deltas.map((d) => Math.abs(d)));
  const W = 340;
  const H = 72;
  const MID = H / 2;
  const barW = Math.max(2, (W / pts.length) * 0.6);

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W, display: 'block' }} role="img" aria-label="粉丝净增">
        <line x1={0} y1={MID} x2={W} y2={MID} stroke="var(--border)" strokeWidth="1" />
        {deltas.map((d, i) => {
          const h = (Math.abs(d) / max) * (MID - 4);
          const x = (i / Math.max(1, pts.length - 1)) * (W - barW) ;
          return (
            <rect
              key={i}
              x={x}
              y={d >= 0 ? MID - h : MID}
              width={barW}
              height={Math.max(1, h)}
              rx="1"
              fill={d >= 0 ? 'var(--brand)' : 'var(--red)'}
              opacity={0.8}
            />
          );
        })}
      </svg>
      <div className="row-between small muted" style={{ marginTop: 2 }}>
        <span>{pts[0]?.date}</span>
        <span>每日净增（↑涨 ↓掉）</span>
        <span>{pts[pts.length - 1]?.date}</span>
      </div>
    </div>
  );
}
