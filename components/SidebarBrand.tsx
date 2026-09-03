'use client';

import React from 'react';
import Image from 'next/image';
import { useI18n } from '@/lib/i18n';

export function SidebarBrand() {
  const { lang } = useI18n();

  return (
    <div className="brand">
      <Image
        src="/logo.png"
        alt={lang === 'en' ? 'Beacon' : '烽火台'}
        width={36}
        height={36}
        className="brand-logo-img"
      />
      <div>
        <div className="brand-name">{lang === 'en' ? 'Beacon' : '烽火台'}</div>
        <div className="brand-sub">{lang === 'en' ? 'Content Ops Deck' : '跨平台内容作战室'}</div>
      </div>
    </div>
  );
}
