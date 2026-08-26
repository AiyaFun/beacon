import Link from 'next/link';

// 「定选题」页顶三合一切换：挑选题 / 灵感箱 / 找角度（2026-08-25 合并）。
// 服务端 view 参数切换、只渲染当前 tab（同 /data 看效果的早返回模式）。
const VIEWS = [
  { key: 'topics', label: '挑选题', href: '/topics' },
  { key: 'inspiration', label: '灵感箱', href: '/topics?view=inspiration' },
  { key: 'advisor', label: '找角度（智囊团）', href: '/topics?view=advisor' },
] as const;

export function PickTabs({ active, inline }: { active: 'topics' | 'inspiration' | 'advisor'; /** 嵌进 HubHeader 行内时用，去掉整行下边框 */ inline?: boolean }) {
  return (
    <div className={`tabs${inline ? " tabs-inline" : ""}`} style={{ marginBottom: inline ? 0 : 16 }}>
      {VIEWS.map((v) => (
        <Link key={v.key} href={v.href} className={`tab${v.key === active ? ' active' : ''}`}>
          {v.label}
        </Link>
      ))}
    </div>
  );
}
