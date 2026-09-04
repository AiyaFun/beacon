'use client';

import React from 'react';
import Link from 'next/link';
import { Icon } from '@/components/icons';
import { useI18n } from '@/lib/i18n';

export function PersonaGuideBanner() {
  const { dict } = useI18n();

  return (
    <div className="alert-gradient-brand" style={{ padding: '16px 20px', marginBottom: 20 }}>
      <div className="row-between wrap" style={{ gap: 12, alignItems: 'center' }}>
        <div className="row" style={{ gap: 12, alignItems: 'center' }}>
          <div className="icon-box-brand">
            <Icon.sparkles size={18} />
          </div>
          <div>
            <b style={{ color: 'var(--brand)', fontSize: 15 }}>{dict.today.aiNotKnowYou}</b>
            <div className="small" style={{ marginTop: 2, opacity: 0.9 }}>
              {dict.today.aiNotKnowYouDesc}
            </div>
          </div>
        </div>
        <Link href="/persona" className="btn btn-primary" style={{ fontSize: 14, padding: '8px 18px' }}>
          {dict.today.createPersonaBtn}
        </Link>
      </div>
    </div>
  );
}
