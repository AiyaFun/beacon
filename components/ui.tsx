import Link from 'next/link';
import { scoreColor } from '@/lib/format';
import { CONFIDENCE_LEVELS, COMPLIANCE_TIERS } from '@/lib/constants';
import { Icon } from '@/components/icons';

export function PageHead({ title, desc, action }: { title: string; desc?: string; action?: React.ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        {desc && <p className="page-desc">{desc}</p>}
      </div>
      {action}
    </div>
  );
}

export function Card({
  title,
  sub,
  action,
  children,
  className = '',
  style,
}: {
  title?: React.ReactNode;
  sub?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div className={`card ${className}`} style={style}>
      {(title || action) && (
        // 换行：卡片标题旁边常挂着长徽标/动作（如工坊的「当前选中：⋯」），
        // 不换行就会把标题硬挤成断词的两行。
        <div className="row-between wrap" style={{ marginBottom: 14 }}>
          <div className="card-title">
            {title} {sub && <span className="card-sub">{sub}</span>}
          </div>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * 折叠卡：`.card` 的 <details> 版，零 JS（服务端组件里直接用，收起时只占一行标题）。
 *
 * 用来收纳「要用的时候才需要看」的区块——采集说明、添加表单、长名单。摊开在页面上
 * 它们会把真正要看的数据挤到屏幕外，收起来页面才回到「一屏看得完」。
 *
 * ⚠️ summary 里只放文字/徽标，**不要放按钮**：点按钮的 click 会冒泡到 summary，
 * 顺带把折叠状态切掉（用户体感是「点一下采集，面板自己收起来了」）。动作放 body 里或页头。
 */
export function Fold({
  title,
  sub,
  note,
  children,
  defaultOpen = false,
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  /** 收起时也要看见的一句话（如「3 个未采集」），跟在标题右侧 */
  note?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="card fold" open={defaultOpen}>
      <summary>
        <span className="card-title" style={{ flex: 1, minWidth: 0 }}>
          {title} {sub && <span className="card-sub">{sub}</span>}
        </span>
        {note}
        <span className="fold-caret" aria-hidden="true">
          <Icon.chevron size={16} />
        </span>
      </summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}

export function Stat({ label, value, foot, href }: { label: string; value: React.ReactNode; foot?: React.ReactNode; href?: string }) {
  const content = (
    <div className="stat" style={href ? { cursor: 'pointer' } : undefined}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {foot && <div className="stat-foot">{foot}</div>}
    </div>
  );

  if (href) {
    return (
      <Link href={href} style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
        {content}
      </Link>
    );
  }

  return content;
}

export function Meter({ value, max = 100, color }: { value: number; max?: number; color?: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="meter">
      <div className="meter-fill" style={{ width: `${pct}%`, background: color ?? scoreColor(value) }} />
    </div>
  );
}

export function ScorePill({ label, value }: { label: string; value: number }) {
  return (
    <div className="score-pill">
      <span className="v" style={{ color: scoreColor(value) }}>{value}</span>
      <span className="k">{label}</span>
    </div>
  );
}

export function ConfidenceBadge({ level }: { level: string }) {
  const c = (CONFIDENCE_LEVELS as Record<string, { name: string; color: string }>)[level];
  if (!c) return null;
  return <span className="badge" style={{ background: 'var(--surface-2)', color: c.color }}>{c.name}</span>;
}

export function TierBadge({ tier }: { tier: string }) {
  const t = (COMPLIANCE_TIERS as Record<string, { name: string; color: string }>)[tier];
  if (!t) return <span className="badge badge-gray">{tier}</span>;
  return <span className="badge" style={{ background: 'var(--surface-2)', color: t.color }}>{t.name}</span>;
}

export function Empty({ icon = '📭', text, action }: { icon?: string; text: string; action?: React.ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-ic">{icon}</div>
      <div>{text}</div>
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}

export function LinkButton({ href, children, primary }: { href: string; children: React.ReactNode; primary?: boolean }) {
  return (
    <Link href={href} className={`btn btn-sm${primary ? ' btn-primary' : ''}`}>
      {children}
    </Link>
  );
}
