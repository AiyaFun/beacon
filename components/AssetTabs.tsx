'use client';

import Link from 'next/link';
import { useI18n } from '@/lib/i18n';

// 「记忆与素材」页顶标签：记忆与人设 / 我的素材 两处互切（2026-08-26）。
export function AssetTabs({ active, inline }: { active: 'persona' | 'material'; /** 嵌进 HubHeader 行内时用，去掉整行下边框 */ inline?: boolean }) {
  const { lang } = useI18n();

  const tabs = [
    { key: 'persona', label: lang === 'en' ? 'Persona & Memory' : '记忆与人设', href: '/persona' },
    { key: 'material', label: lang === 'en' ? 'My Assets' : '我的素材', href: '/material' },
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
