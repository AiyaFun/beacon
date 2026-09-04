'use client';

import Link from 'next/link';
import { useI18n } from '@/lib/i18n';

// 「看情报」页顶标签：看热点 / 看同行 / 我存的资料 三处互切（2026-08-26 情报三合一）。
export function IntelTabs({ active, inline }: { active: 'hot' | 'rivals' | 'library'; /** 嵌进 HubHeader 行内时用，去掉整行下边框 */ inline?: boolean }) {
  const { dict } = useI18n();

  const tabs = [
    { key: 'hot', label: dict.tabs.intelHot, href: '/hotlists' },
    { key: 'rivals', label: dict.tabs.intelRivals, href: '/competitors' },
    { key: 'library', label: dict.tabs.intelLibrary, href: '/library' },
  ];

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
