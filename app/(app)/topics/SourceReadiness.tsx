import Link from 'next/link';
import { Card } from '@/components/ui';
import { Icon } from '@/components/icons';
import type { ReadinessReport, SourceReadiness as Row } from '@/lib/topic/readiness';

// 候选源就绪度（冷启动引导）。
//
// 冷启动实测：新用户第一天八个来源只有三个出货，差异化完全不可见。这块就是把「补什么数据能解锁什么」
// 明说出来，而不是指望用户自己悟。
//
// 三条呈现纪律：
//   1) **冷的时候默认展开，暖了自动收起**。它是 onboarding，不是常驻仪表盘——
//      全部解锁后还天天占着屏幕顶部就成了噪声。
//   2) **沉默的排在前面**，因为那才是用户能采取行动的部分；已激活的折叠在后面供核对。
//   3) **每条沉默都必须给出「为什么」和「怎么办」**。只说「未解锁」等于把锅甩给用户。

function StateRow({ r }: { r: Row }) {
  const dormant = r.state === 'dormant';
  return (
    <div className="row" style={{ gap: 10, alignItems: 'flex-start', padding: '8px 0' }}>
      <span style={{ flexShrink: 0, marginTop: 1 }}>
        {dormant ? <span className="small muted">⬜</span> : <Icon.check size={14} />}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="row wrap" style={{ gap: 8, alignItems: 'baseline' }}>
          <b className="small">{r.name}</b>
          <span className="small muted">{r.reason}</span>
        </div>
        {r.action && (
          <Link href={r.action.href} className="small" style={{ display: 'inline-block', marginTop: 2 }}>
            {r.action.text} →
          </Link>
        )}
      </div>
    </div>
  );
}

export function SourceReadinessCard({
  report,
}: {
  report: ReadinessReport & { material: Row | null };
}) {
  const dormant = report.sources.filter((s) => s.state === 'dormant');
  const active = report.sources.filter((s) => s.state === 'active');
  const allDone = dormant.length === 0 && !report.material;

  return (
    <Card
      title="推荐从哪儿来"
      sub={
        allDone
          ? `${report.active}/${report.total} 个来源都在为你工作`
          : `${report.active}/${report.total} 个来源在工作 —— 补齐下面这些，剩下的才会开口`
      }
      style={{ marginBottom: 16 }}
    >
      {allDone ? (
        <p className="small muted" style={{ margin: 0 }}>
          八个来源全部激活。每天的推荐会同时从热点、同行、你的历史作品、节点日历和收集箱里找机会。
        </p>
      ) : (
        <>
          {/* JSX 不解析 markdown，强调必须用 <b>——写 ** 会原样显示成星号（本文件踩过） */}
          <p className="small muted" style={{ marginTop: 0, marginBottom: 6, lineHeight: 1.7 }}>
            推荐的差异化（「为什么是你」「你做过这个题」「同行还没做」）
            <b>全都要靠你自己的数据</b>才算得出来。数据没进来之前，你看到的会接近一个普通热榜。
            下面每一条都写清了缺什么、去哪补。
          </p>
          <div className="stack" style={{ gap: 0 }}>
            {dormant.map((r) => (
              <StateRow key={r.key} r={r} />
            ))}
            {report.material && <StateRow r={report.material} />}
          </div>

          {active.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary className="small" style={{ cursor: 'pointer', color: 'var(--brand)' }}>
                已经在工作的 {active.length} 个来源
              </summary>
              <div className="stack" style={{ gap: 0, marginTop: 4 }}>
                {active.map((r) => (
                  <StateRow key={r.key} r={r} />
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </Card>
  );
}
