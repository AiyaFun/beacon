'use client';

import Link from 'next/link';
import { useI18n } from '@/lib/i18n';

// 「定选题」页顶三合一切换：挑选题 / 灵感箱 / 找角度（2026-08-25 合并）。
export function PickTabs({ active, inline }: { active: 'topics' | 'inspiration' | 'advisor'; /** 嵌进 HubHeader 行内时用，去掉整行下边框 */ inline?: boolean }) {
  const { dict } = useI18n();

  const views = [
    { key: 'topics', label: dict.tabs.topicsPick, href: '/topics' },
    { key: 'inspiration', label: dict.tabs.topicsInspiration, href: '/topics?view=inspiration' },
    { key: 'advisor', label: dict.tabs.topicsAdvisor, href: '/topics?view=advisor' },
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
