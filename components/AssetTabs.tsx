import Link from 'next/link';

// 「记忆与素材」页顶标签：记忆与人设 / 我的素材 两处互切（2026-08-26）。
// 两者都是「越用越懂你」的资产——AI 写东西时喂进去的那部分。
const TABS = [
  { key: 'persona', label: '记忆与人设', href: '/persona' },
  { key: 'material', label: '我的素材', href: '/material' },
] as const;

export function AssetTabs({ active, inline }: { active: 'persona' | 'material'; /** 嵌进 HubHeader 行内时用，去掉整行下边框 */ inline?: boolean }) {
  return (
    <div className={`tabs${inline ? " tabs-inline" : ""}`} style={{ marginBottom: inline ? 0 : 14 }}>
      {TABS.map((t) => (
        <Link key={t.key} href={t.href} className={`tab${t.key === active ? ' active' : ''}`}>
          {t.label}
        </Link>
      ))}
    </div>
  );
}
