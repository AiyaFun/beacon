import { getSession } from '@/lib/session';
import { loadGeneProfile } from '@/lib/insight/genes';
import { PageHead, Card, Stat, Meter, Empty } from '@/components/ui';
import { LinkButton } from '@/components/ui';

export const dynamic = 'force-dynamic';

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export default async function GenesPage() {
  const s = await getSession();
  const profile = await loadGeneProfile(s.accountId);

  return (
    <>
      <PageHead
        title="爆款基因"
        desc="这个账号什么样的内容真的跑得动——按已发布内容的真实数据算，不是评分也不是推测"
      />

      {profile.sample === 0 ? (
        <Empty
          icon="🧬"
          text="还没有带播放数据的已发布内容。发布几条并回流数据后，这里会长出你自己的基因画像。"
          action={<LinkButton href="/data">去数据看板登记发布</LinkButton>}
        />
      ) : (
        <>
          <div className="grid grid-3" style={{ marginBottom: 16 }}>
            <Stat label="参与统计" value={profile.sample} foot={`近 ${profile.windowDays} 天有播放数据的作品`} />
            <Stat
              label="最强的一项"
              value={profile.headline ? pct(profile.headline.winRate) : '—'}
              foot={
                profile.headline
                  ? `${profile.headline.dimension}：${profile.headline.label}（${profile.headline.sample} 条）`
                  : '样本还不够，暂不下结论'
              }
            />
            <Stat
              label="胜率口径"
              value="跑赢自己"
              foot="该条播放 ≥ 你在同平台的均播，才算赢"
            />
          </div>

          <Card style={{ marginBottom: 16, background: 'var(--surface-2)', boxShadow: 'none' }}>
            <p className="small" style={{ margin: 0, lineHeight: 1.8 }}>
              这一页的每个数都可以自己验算：胜率 = 该类里跑赢你同平台均播的条数 ÷ 该类总条数。
              <b> 不足 3 条的类别只报条数、不报胜率</b>——2 条里赢 1 条不是 50% 胜率，是没有结论。
              基线取的是同一窗口内你自己的作品，不拿半年前的高水位去比最近的内容。
            </p>
          </Card>

          <div className="stack" style={{ gap: 16 }}>
            {profile.dimensions.map((d) => (
              <Card key={d.key} title={d.name} sub={d.hint}>
                {d.buckets.length === 0 ? (
                  <p className="small muted" style={{ margin: 0 }}>
                    还没有可归类的数据。
                    {d.key === 'source' || d.key === 'angle'
                      ? '这一维需要发布时带上选题归因——从选题引擎采纳并发布的内容才有来源和切入角。'
                      : ''}
                  </p>
                ) : (
                  <div className="stack" style={{ gap: 10 }}>
                    {!d.conclusive && (
                      <p className="small muted" style={{ margin: 0 }}>
                        每一类都还不到 3 条，先只列条数，攒够再下结论。
                      </p>
                    )}
                    {d.buckets.map((b) => (
                      <div key={b.key}>
                        <div className="row-between" style={{ gap: 12, alignItems: 'baseline' }}>
                          <span className="small" style={{ flex: 1, minWidth: 0 }}>
                            {b.label}
                          </span>
                          <span className="small muted">
                            {b.sample} 条
                            {b.winRate === null ? '' : ` · 赢 ${b.wins}`}
                            {' · 平均 '}
                            {b.avgRatio.toFixed(2)} 倍均播
                          </span>
                          <b style={{ minWidth: 52, textAlign: 'right' }}>
                            {b.winRate === null ? (
                              <span className="small muted">样本不足</span>
                            ) : (
                              pct(b.winRate)
                            )}
                          </b>
                        </div>
                        {b.winRate !== null && (
                          <Meter
                            value={b.winRate * 100}
                            color={b.winRate >= 0.5 ? 'var(--green)' : 'var(--amber)'}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            ))}
          </div>
        </>
      )}
    </>
  );
}
