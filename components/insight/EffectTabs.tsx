'use client';

import Link from 'next/link';
import { useI18n } from '@/lib/i18n';

// 「看效果」页顶部的三合一切换：数据看板 / 什么跑得动 / 平台怎么想。
export function EffectTabs({ active, inline }: { active: 'data' | 'genes' | 'algorithm'; /** 嵌进 HubHeader 行内时用，去掉整行下边框 */ inline?: boolean }) {
  const { lang } = useI18n();

  const views = [
    { key: 'data', label: lang === 'en' ? 'Analytics Dashboard' : '数据看板', href: '/data' },
    { key: 'genes', label: lang === 'en' ? 'What Performs' : '什么跑得动', href: '/data?view=genes' },
    { key: 'algorithm', label: lang === 'en' ? 'Platform Algorithm' : '平台怎么想', href: '/data?view=algorithm' },
  ];

  return (
    <div className={`tabs${inline ? " tabs-inline" : ""}`} style={{ marginBottom: inline ? 0 : 16 }}>
      {views.map((v) => (
        <Link key={v.key} href={v.href} className={`tab${v.key === active ? ' active' : ''}`}>
          {v.label}
        </Link>
      ))}
    </div>
  );
}
