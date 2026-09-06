'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useI18n } from '@/lib/i18n';

const ITEMS = [
  { href: '/ops', labelZh: '总览', labelEn: 'Overview' },
  { href: '/ops/tenants', labelZh: '租户', labelEn: 'Tenants' },
  { href: '/ops/ai', labelZh: '全域 AI', labelEn: 'Global AI' },
  { href: '/ops/health', labelZh: '采集健康', labelEn: 'Ingest Health' },
  { href: '/ops/parser', labelZh: '解析自愈', labelEn: 'Parser Self-Healing' },
  { href: '/ops/audit', labelZh: '审计日志', labelEn: 'Audit Logs' },
  { href: '/ops/growth', labelZh: '增长漏斗', labelEn: 'Growth Funnel' },
];

export function OpsNav() {
  const path = usePathname();
  const { lang } = useI18n();
  const isEn = lang === 'en';
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
            {isEn ? it.labelEn : it.labelZh}
          </Link>
        );
      })}
    </nav>
  );
}
