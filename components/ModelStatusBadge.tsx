'use client';

import React from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';

interface ModelStatusBadgeProps {
  isDemo: boolean;
  rawLabel: string;
}

export function ModelStatusBadge({ isDemo, rawLabel }: ModelStatusBadgeProps) {
  const { lang, dict } = useI18n();

  let displayLabel = rawLabel;
  if (lang === 'en') {
    if (rawLabel === '演示数据模式' || isDemo) {
      displayLabel = dict.shell.demoModel;
    } else if (rawLabel === '平台默认模型') {
      displayLabel = dict.shell.defaultModel;
    }
  }

  const tip = isDemo ? dict.shell.demoModelTip : dict.shell.activeModelTip;

  return (
    <Link
      href="/settings/keys"
      className="badge badge-gray hide-mobile"
      title={tip}
    >
      <span className={`dot ${isDemo ? 'dot-amber' : 'dot-green'}`} /> {displayLabel}
    </Link>
  );
}
