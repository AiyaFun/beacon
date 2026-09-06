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
      className={`inline-flex items-center ${className}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        background: 'var(--surface-2, #f0f2f5)',
        border: '1px solid var(--border, #e5e7eb)',
        borderRadius: '20px',
        padding: '2px',
        height: '28px',
        userSelect: 'none',
      }}
      role="group"
      aria-label="Switch Language"
    >
      <button
        type="button"
        onClick={() => setLang('zh')}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '22px',
          padding: compact ? '0 8px' : '0 10px',
          fontSize: '11.5px',
          fontWeight: lang === 'zh' ? 650 : 500,
          borderRadius: '16px',
          border: 'none',
          cursor: 'pointer',
          background: lang === 'zh' ? 'var(--surface, #ffffff)' : 'transparent',
          color: lang === 'zh' ? 'var(--text, #1a1d21)' : 'var(--text-3, #8a919e)',
          boxShadow: lang === 'zh' ? '0 1px 3px rgba(0, 0, 0, 0.08), 0 1px 1px rgba(0, 0, 0, 0.04)' : 'none',
          transition: 'all 0.18s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
        title="切换为简体中文"
      >
        中文
      </button>
      <button
        type="button"
        onClick={() => setLang('en')}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '22px',
          padding: compact ? '0 8px' : '0 10px',
          fontSize: '11.5px',
          fontWeight: lang === 'en' ? 650 : 500,
          borderRadius: '16px',
          border: 'none',
          cursor: 'pointer',
          background: lang === 'en' ? 'var(--surface, #ffffff)' : 'transparent',
          color: lang === 'en' ? 'var(--text, #1a1d21)' : 'var(--text-3, #8a919e)',
          boxShadow: lang === 'en' ? '0 1px 3px rgba(0, 0, 0, 0.08), 0 1px 1px rgba(0, 0, 0, 0.04)' : 'none',
          transition: 'all 0.18s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
        title="Switch to English"
      >
        EN
      </button>
    </div>
  );
}

