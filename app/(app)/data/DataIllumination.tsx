import Link from 'next/link';
import { Card, Meter } from '@/components/ui';

// 数据点亮进度：无插件/零数据用户进 /data 看到的是一整墙空态卡，不知道「差哪一步才能看到东西」。
// 这张卡把「还需要点亮哪些数据源」摊在最上面，每项给一句可照做的点亮方式。
// 诚实口径：signals 全是真实布尔（有没有那类数据），不编造进度。
// 全部点亮后整卡不再渲染（litCount===total 时返回 null）——它是引导，不是常驻装饰。

export type IlluminationSignal = { key: string; label: string; lit: boolean; how: string };

export function DataIllumination({ signals }: { signals: IlluminationSignal[] }) {
  const total = signals.length;
  const lit = signals.filter((s) => s.lit).length;
  if (total === 0 || lit === total) return null; // 全亮就不打扰

  const pct = Math.round((lit / total) * 100);

  return (
    <Card
      title={`数据点亮进度 ${lit}/${total}`}
      sub="点亮越多，下面的看板和 AI 诊断越准"
      style={{ marginBottom: 16, background: 'var(--surface-2)', boxShadow: 'none', border: '1px solid var(--border)' }}
      action={
        <Link href="/extension" className="btn btn-sm btn-ghost">
          装插件一键回填 →
        </Link>
      }
    >
      <Meter value={pct} color={lit === 0 ? 'var(--amber)' : 'var(--brand)'} />
      <div className="stack" style={{ gap: 8, marginTop: 12 }}>
        {signals.map((sig) => (
          <div key={sig.key} className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
            <span
              style={{
                width: 18,
                height: 18,
                borderRadius: '50%',
                flexShrink: 0,
                marginTop: 1,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 11,
                background: sig.lit ? 'var(--green)' : 'var(--border)',
                color: sig.lit ? '#fff' : 'var(--muted)',
              }}
            >
              {sig.lit ? '✓' : '○'}
            </span>
            <div className="small" style={{ lineHeight: 1.55 }}>
              <b style={{ color: sig.lit ? 'var(--text)' : 'var(--text-2, var(--text))' }}>{sig.label}</b>
              {sig.lit ? (
                <span className="muted"> · 已点亮</span>
              ) : (
                <span className="muted"> · {sig.how}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
