import Link from 'next/link';
import { fmtNum, fmtDate } from '@/lib/format';
import { Card, Empty } from '@/components/ui';
import { ActionButton } from '@/components/ActionButton';
import { BattleStartDraft } from '@/components/BattleStartDraft';
import type { BattleReport as BattleReportData, Metric } from '@/lib/battle/report';
import { actGenerateRecommendations } from '@/app/(app)/actions';

// 本周作战报告的**渲染主体** —— 独立成组件，因为它有两个使用处：
//   · /battle 独立页
//   · 任务台首页（第一屏就是这份报告）
// 两处共用一份渲染，改口径/样式只改这里，不会两边漂。取数在 lib/battle/report.ts。

/** 指标值：null 一律显示「—」，绝不显示 0（0 会被当成真值，见 lib/battle/report.ts）。 */
function metricValue(m: Metric): string {
  if (m.value === null) return '—';
  if (m.kind === 'wan') return m.value >= 10000 ? `${(m.value / 10000).toFixed(1)}w` : fmtNum(m.value);
  if (m.kind === 'pct') return `${m.value.toFixed(1)}%`;
  return fmtNum(m.value);
}
function deltaText(m: Metric): { text: string; cls: string } | null {
  if (m.delta === null) return null;
  const up = m.delta >= 0;
  const unit = m.deltaUnit === 'pt' ? 'pt' : '%';
  const val = Math.abs(m.delta);
  return {
    text: `${up ? '↑' : '↓'} ${m.deltaUnit === 'pt' ? val.toFixed(1) : val.toFixed(0)}${unit}`,
    cls: up ? 'up' : 'down',
  };
}

const PLAT_ICON: Record<string, string> = {
  douyin: '📱', xiaohongshu: '📕', wechat: '📰', bilibili: '📺', shipinhao: '🎬',
  x: '𝕏', youtube: '▶', kuaishou: '⚡', weibo: '🔴', zhihu: '📘',
};

export function BattleReport({ report, personaBlank }: { report: BattleReportData; personaBlank: boolean }) {
  // 没有推荐 → 引导去生成（真链路：热榜 → 竞对 → 按人设排优先级）
  if (!report.hasRecommendations) {
    return (
      <Card>
        <Empty
          icon="🔥"
          text={
            personaBlank
              ? '先花 1 分钟建人设，Beacon 才知道该往谁头上匹配热点——建完这里就会排出本周该做的选题。'
              : '还没有本周选题。让 Beacon 跑一次全流程（热榜 → 竞对 → 按你的人设排优先级），出你的作战报告。'
          }
          action={
            personaBlank ? (
              <Link href="/persona" className="btn btn-sm btn-primary">去建人设 →</Link>
            ) : (
              <ActionButton action={actGenerateRecommendations} primary loadingText={['采集热榜…', '比对竞对…', '排优先级…']}>
                让 Beacon 出周报
              </ActionButton>
            )
          }
        />
      </Card>
    );
  }

  return (
    <>
      {/* 指标行 */}
      <div className="battle-metrics">
        {report.metrics.map((m) => {
          const d = deltaText(m);
          return (
            <div key={m.label} className="battle-m">
              <div className="k">{m.label}</div>
              <div className="v">{metricValue(m)}</div>
              {d ? <div className={`d ${d.cls}`}>{d.text}</div> : <div className="d muted">—</div>}
              <div className="sub">{m.sub}</div>
            </div>
          );
        })}
      </div>

      <div className="battle-grid">
        <div className="battle-main">
          {/* 第一步 · 高潜选题 */}
          {/* 「看全部选题」挂在卡片右上角，不挂每一行——它跟具体哪一条选题无关，
              而挂在行上的话有几条就重复几个一模一样的按钮（2026-08-26 用户指出的重复跳转）。
              行上只留「起稿」，那才是这一行独有的动作。 */}
          <Card
            title={<span><span className="battle-step a">1</span> 重点做 · 高潜选题</span>}
            sub="按人设匹配度与热度排序"
            action={<Link href="/topics" className="btn btn-sm">看全部选题</Link>}
          >
            <div className="stack" style={{ gap: 12 }}>
              {report.ideas.map((it) => (
                <div key={it.id} className="battle-row">
                  <div className="battle-row-body">
                    <div className="battle-tt">{it.title}</div>
                    <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
                      {it.personaFit !== null && <span className="badge badge-green">✓ 人设匹配 {it.personaFit}</span>}
                      {it.blueSeaPct !== null && <span className="badge badge-brand">🔥 蓝海度 {it.blueSeaPct}%</span>}
                      {it.windowHint && <span className="badge badge-amber">⏳ {it.windowHint}</span>}
                      {!it.windowHint && it.queue === 'today' && <span className="badge badge-amber">今日窗口</span>}
                    </div>
                    <div className="battle-why">
                      <b>切入角：</b>{it.angle}
                      {it.reason && <><br /><b>为什么给你：</b>{it.reason}</>}
                    </div>
                  </div>
                  <div className="battle-acts">
                    <BattleStartDraft topicId={it.id} title={it.title} />
                  </div>
                </div>
              ))}
            </div>
          </Card>

          {/* 第二步 · 拉回低表现作品 */}
          {report.fixes.length > 0 && (
            <Card
              title={<span><span className="battle-step b">2</span> 顺手优化 · 拉回低表现作品</span>}
              sub="完播/互动偏低但还有救的"
              style={{ marginTop: 16 }}
            >
              <div className="stack" style={{ gap: 12 }}>
                {report.fixes.map((f) => (
                  <div key={f.id} className="battle-row">
                    <div className="battle-row-body">
                      <div className="battle-tt">{PLAT_ICON[f.platform] ?? '•'} {f.title}</div>
                      <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
                        {f.completion !== null && <span className="badge badge-red">完播 {(f.completion * 100).toFixed(0)}%</span>}
                        {f.engagement !== null && <span className="badge badge-gray">互动率 {(f.engagement * 100).toFixed(2)}%</span>}
                      </div>
                      <div className="battle-why"><b>诊断：</b>{f.diagnosis}</div>
                    </div>
                    <div className="battle-acts">
                      <Link href="/studio" className="btn btn-sm btn-primary" style={{ width: '100%' }}>✎ 去改稿</Link>
                      <Link href="/data" className="btn btn-sm">看数据</Link>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>

        {/* 侧栏 */}
        <div className="battle-aside">
          <Card title="对标本周动向" sub={`盯着 ${report.counts.watchedRivals} 个`}>
            {report.rivals.length === 0 ? (
              <Empty icon="◇" text="还没采到对标数据。去竞对监控加账号、跑一次采集。" action={<Link href="/competitors" className="btn btn-sm">去竞对监控</Link>} />
            ) : (
              <div className="stack" style={{ gap: 0 }}>
                {report.rivals.map((r, i) => (
                  <div key={i} className="battle-rv">
                    <span className="rk">{i + 1}</span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="rvt">{r.url ? <a href={r.url} target="_blank" rel="noopener noreferrer">{r.title}</a> : r.title}</div>
                      <div className="rvs">{r.name}</div>
                    </div>
                    <span className="rvn">{r.views === null ? '—' : fmtNum(r.views)}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="本周新作" sub={`${report.counts.ownWorks7d} 条`} style={{ marginTop: 16 }}>
            {report.recentWorks.length === 0 ? (
              <Empty icon="📝" text="近 7 天还没登记发布。发完到「发布中心」登记，表现会回填到这里。" action={<Link href="/publish" className="btn btn-sm">去发布中心</Link>} />
            ) : (
              <div className="stack" style={{ gap: 0 }}>
                {report.recentWorks.map((w, i) => (
                  <div key={i} className="battle-rv">
                    <span className="rk">{PLAT_ICON[w.platform] ?? '•'}</span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="rvt">{w.title}</div>
                      <div className="rvs">{fmtDate(w.at)}</div>
                    </div>
                    <span className="rvn">{w.views === null ? '—' : fmtNum(w.views)}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      <p className="small muted" style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="badge badge-gray">建议基于你的公开数据</span>
        执行前请自行判断 · 数据源与口径见 <Link href="/runs">运行中心</Link> · 缺播放量的作品一律显示「—」，不按 0 计
      </p>
    </>
  );
}
