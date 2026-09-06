'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actGuestLogin } from './actions';
import { useI18n } from '@/lib/i18n';

// 游客访问：一键进入只读演示租户（含跨模块假数据），无需注册。仅在非邀请登录时展示。
export function GuestButton() {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const [pending, start] = useTransition();
  const router = useRouter();

  function go() {
    start(async () => {
      const r = await actGuestLogin();
      if (r.ok) {
        router.replace('/');
        router.refresh();
      }
    });
  }

  return (
    <div style={{ marginTop: 18 }}>
      <div className="row" style={{ alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{ flex: 1, height: 1, background: '#e2e8f0' }} />
        <span style={{ fontSize: 12, color: '#94a3b8' }}>{isEn ? 'or' : '或'}</span>
        <div style={{ flex: 1, height: 1, background: '#e2e8f0' }} />
      </div>
      <button
        onClick={go}
        disabled={pending}
        style={{
          width: '100%',
          padding: '11px 0',
          borderRadius: 8,
          border: '1px solid #e2e8f0',
          background: '#fff',
          color: '#0f172a',
          fontSize: 14,
          fontWeight: 600,
          cursor: pending ? 'default' : 'pointer',
        }}
      >
        {pending ? (isEn ? 'Entering demo…' : '进入演示中…') : (isEn ? '👀 Guest Access · Try Demo' : '👀 游客访问 · 免注册体验')}
      </button>
      <div style={{ fontSize: 12, color: '#94a3b8', textAlign: 'center', marginTop: 8 }}>
        {isEn
          ? 'No registration needed. Explore demo workspace with sample data (read-only)'
          : '无需注册，直接进入含示例数据的演示工作台（只读）'}
      </div>
    </div>
  );
}
