'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ITEMS = [
  { href: '/ops', label: '总览' },
  { href: '/ops/tenants', label: '租户' },
  { href: '/ops/ai', label: '全域 AI' },
  { href: '/ops/health', label: '采集健康' },
  { href: '/ops/parser', label: '解析自愈' },
  { href: '/ops/audit', label: '审计日志' },
];

export function OpsNav() {
  const path = usePathname();
  return (
    <nav className="row" style={{ gap: 4 }}>
      {ITEMS.map((it) => {
        // 「/ops」只在完全相等时高亮，否则每个子页都会把它一起点亮
        const active = it.href === '/ops' ? path === '/ops' : path.startsWith(it.href);
        return (
          <Link
            key={it.href}
            href={it.href}
            className={`btn btn-sm ${active ? 'btn-primary' : 'btn-ghost'}`}
          >
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}
