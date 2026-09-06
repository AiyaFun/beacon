'use client';

import Link from 'next/link';
import { Fold, Meter } from '@/components/ui';
import { useI18n } from '@/lib/i18n';

// 数据点亮进度：无插件/零数据用户进 /data 看到的是一整墙空态卡，不知道「差哪一步才能看到东西」。
export type IlluminationSignal = { key: string; label: string; lit: boolean; how: string };

export function DataIllumination({ signals }: { signals: IlluminationSignal[] }) {
  const { lang } = useI18n();
  const total = signals.length;
  const lit = signals.filter((s) => s.lit).length;
  if (total === 0 || lit === total) return null; // 全亮就不打扰

  const pct = Math.round((lit / total) * 100);

  return (
    <div style={{ marginBottom: 16 }}>
      <Fold
        title={
          <div className="row wrap" style={{ gap: 10, alignItems: 'center' }}>
            <span>{lang === 'en' ? '💡 Data Progress' : '💡 数据点亮进度'}</span>
            <span className="badge badge-amber" style={{ fontSize: '0.78rem' }}>
              {lang === 'en' ? `Lit ${lit}/${total} (${pct}%)` : `已点亮 ${lit}/${total} 项 (${pct}%)`}
            </span>
          </div>
        }
        sub={lang === 'en' ? 'Connect more data sources for sharper analytics and AI insights' : '点亮更多数据源，看板分析与 AI 诊断越准'}
        note={
          <span className="badge badge-gray" style={{ fontSize: '0.75rem' }}>
            {lang === 'en' ? 'Expand Guide ▼' : '点击展开指引 ▼'}
          </span>
        }
        defaultOpen={false}
      >
        <div style={{ marginBottom: 12 }}>
          <Meter value={pct} color={lit === 0 ? 'var(--amber)' : 'var(--brand)'} />
        </div>

        <div className="stack" style={{ gap: 10 }}>
          {signals.map((sig) => (
            <div key={sig.key} className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
              <span
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  flexShrink: 0,
                  marginTop: 1,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 11,
                  fontWeight: 'bold',
                  background: sig.lit ? 'var(--green)' : 'var(--border)',
                  color: sig.lit ? '#fff' : 'var(--muted)',
                }}
              >
                {sig.lit ? '✓' : '○'}
              </span>
              <div className="small" style={{ lineHeight: 1.6, flex: 1 }}>
                <b style={{ color: sig.lit ? 'var(--text)' : 'var(--text-2, var(--text))' }}>{sig.label}</b>
                {sig.lit ? (
                  <span className="muted">{lang === 'en' ? ' · Connected' : ' · 已点亮'}</span>
                ) : (
                  <span className="muted"> · {sig.how}</span>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="row-between wrap" style={{ marginTop: 14, paddingTop: 10, borderTop: '1px solid var(--border)', gap: 8 }}>
          <span className="small muted">
            {lang === 'en' ? 'Tip: Install browser extension to auto-sync analytics from creator centers' : '提示：安装采集助手插件即可在创作者后台一键回填数据'}
          </span>
          <Link href="/extension" className="btn btn-sm btn-primary" style={{ textDecoration: 'none' }}>
            {lang === 'en' ? 'Install Extension →' : '装插件一键回填 →'}
          </Link>
        </div>
      </Fold>
    </div>
  );
}
