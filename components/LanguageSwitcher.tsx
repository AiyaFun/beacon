'use client';

import React from 'react';
import { useI18n } from '@/lib/i18n';

interface LanguageSwitcherProps {
  compact?: boolean;
  className?: string;
}

export function LanguageSwitcher({ compact = false, className = '' }: LanguageSwitcherProps) {
  const { lang, setLang } = useI18n();

  return (
    <div
      className={`inline-flex items-center rounded-full p-0.5 border ${className}`}
      style={{
        background: 'var(--surface-2, rgba(127,127,127,0.08))',
        borderColor: 'var(--line, rgba(127,127,127,0.15))',
      }}
      role="group"
      aria-label="Switch Language"
    >
      <button
        type="button"
        onClick={() => setLang('zh')}
        className="btn-pill"
        style={{
          padding: compact ? '2px 7px' : '3px 10px',
          fontSize: compact ? '11px' : '12px',
          fontWeight: lang === 'zh' ? 600 : 400,
          borderRadius: 9999,
          border: 'none',
          cursor: 'pointer',
          background: lang === 'zh' ? 'var(--brand, #ff6a42)' : 'transparent',
          color: lang === 'zh' ? '#ffffff' : 'var(--text-2, #64748b)',
          transition: 'all 0.15s ease',
        }}
        title="切换为简体中文"
      >
        中文
      </button>
      <button
        type="button"
        onClick={() => setLang('en')}
        className="btn-pill"
        style={{
          padding: compact ? '2px 7px' : '3px 10px',
          fontSize: compact ? '11px' : '12px',
          fontWeight: lang === 'en' ? 600 : 400,
          borderRadius: 9999,
          border: 'none',
          cursor: 'pointer',
          background: lang === 'en' ? 'var(--brand, #ff6a42)' : 'transparent',
          color: lang === 'en' ? '#ffffff' : 'var(--text-2, #64748b)',
          transition: 'all 0.15s ease',
        }}
        title="Switch to English"
      >
        EN
      </button>
    </div>
  );
}
