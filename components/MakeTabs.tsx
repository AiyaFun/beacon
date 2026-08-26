import Link from 'next/link';

// 「做内容」页顶标签：写稿 / 配图 / 查红线 / 发出去 四处互切（2026-08-26，
// 与 IntelTabs / RoleTabs 同款——侧栏收成一条，跨页由这条标签承担）。
// 四页是从选题到发出去的同一段路，用户原话「能否把这几块也放在一起」。
const TABS = [
  { key: 'write', label: '写稿', href: '/studio' },
  { key: 'images', label: '配图', href: '/images' },
  { key: 'check', label: '查红线', href: '/compliance' },
  { key: 'publish', label: '发出去', href: '/publish' },
] as const;

export function MakeTabs({ active, inline }: { active: 'write' | 'images' | 'check' | 'publish'; /** 嵌进 HubHeader 行内时用，去掉整行下边框 */ inline?: boolean }) {
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
