import Link from 'next/link';
import { Card, Meter } from '@/components/ui';
import { Icon } from '@/components/icons';
import type { TrialProgress } from '@/lib/pay/trial';

// 试用运营节奏卡：把「注册即送 30 天」的静默倒计时，变成有进度、有里程碑、临期有续费入口的动线。
// 只在 isTrial 时渲染（由 trialProgress 判定），到期后交给 billing 的到期提示，不在这里重复。
export function TrialProgressCard({ trial }: { trial: TrialProgress }) {
  if (!trial.isTrial) return null;

  const near = trial.nearingEnd;
  const accent = near ? 'var(--amber)' : 'var(--brand)';

  return (
    <Card
      style={{
        marginBottom: 16,
        background: 'var(--surface-2)',
        boxShadow: 'none',
        border: near ? '1px solid var(--amber)' : '1px solid var(--border)',
      }}
    >
      <div className="row-between" style={{ alignItems: 'center', marginBottom: 10, gap: 12 }}>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span style={{ color: accent, display: 'inline-flex' }}><Icon.sparkles size={16} /></span>
          <b style={{ fontSize: 14.5 }}>试用中 · 第 {trial.dayNumber} / {trial.totalDays} 天</b>
          {near ? (
            <span className="badge badge-amber">仅剩 {trial.remaining} 天</span>
          ) : (
            <span className="small muted">还剩 {trial.remaining} 天</span>
          )}
        </div>
        <Link href="/billing" className={`btn btn-sm ${near ? 'btn-primary' : 'btn-ghost'}`}>
          {near ? '立即续费，别断档 →' : '查看套餐'}
        </Link>
      </div>

      <Meter value={trial.pct} color={accent} />

      {/* 三个里程碑：已到达打勾，未到达灰点。回答「这 30 天该按什么节奏用」 */}
      <div className="row wrap" style={{ gap: 14, marginTop: 12 }}>
        {trial.milestones.map((m) => (
          <div key={m.day} className="row" style={{ gap: 6, alignItems: 'center' }}>
            <span
              style={{
                width: 16,
                height: 16,
                borderRadius: '50%',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                background: m.reached ? 'var(--green)' : 'var(--border)',
                color: m.reached ? '#fff' : 'var(--muted)',
                fontSize: 10,
              }}
            >
              {m.reached ? '✓' : m.day}
            </span>
            <span
              className="small"
              style={{ color: m.reached ? 'var(--text)' : 'var(--muted)', textDecoration: m.reached ? 'none' : 'none' }}
            >
              <b style={{ fontWeight: 600 }}>Day {m.day}</b> · {m.label}
            </span>
          </div>
        ))}
      </div>

      {near && (
        <div className="small" style={{ marginTop: 10, color: 'var(--amber)', lineHeight: 1.6 }}>
          试用快结束了——到「套餐与计费」看这一个月的<b>产出账本</b>（推荐/成稿/发布/拦截都在里面），再决定要不要续。断档后按免费版额度算。
        </div>
      )}
    </Card>
  );
}
