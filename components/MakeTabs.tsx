'use client';

import Link from 'next/link';
import { useI18n } from '@/lib/i18n';

export function MakeTabs({ active, inline }: { active: 'write' | 'images' | 'check' | 'publish'; inline?: boolean }) {
  const { lang } = useI18n();

  const tabs = [
    { key: 'write', label: lang === 'en' ? 'Draft' : '写稿', href: '/studio' },
    { key: 'images', label: lang === 'en' ? 'Images' : '配图', href: '/images' },
    { key: 'check', label: lang === 'en' ? 'Compliance' : '查红线', href: '/compliance' },
    { key: 'publish', label: lang === 'en' ? 'Publish' : '发出去', href: '/publish' },
  ] as const;

  return (
    <div className={`tabs${inline ? " tabs-inline" : ""}`} style={{ marginBottom: inline ? 0 : 14 }}>
      {tabs.map((t) => (
        <Link key={t.key} href={t.href} className={`tab${t.key === active ? ' active' : ''}`}>
          {t.label}
        </Link>
      ))}
    </div>
  );
}
