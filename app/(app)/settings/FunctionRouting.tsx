'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { actSetRouting } from './actions';

// 「按功能路由」那一栏的可操作版：每个功能一个下拉，选这个功能走哪条渠道。

export type RoutableProvider = { id: string; label: string; vendor: string; status: string };

export function FunctionRouting({
  fn,
  current,
  providers,
  /** 只能用火山方舟的功能（图像 / 视频）：读侧只在 doubao 里挑，别的选了也不会被采纳 */
  doubaoOnly,
}: {
  fn: string;
  current: string;
  providers: RoutableProvider[];
  doubaoOnly?: boolean;
}) {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState('');
  const options = doubaoOnly ? providers.filter((p) => p.vendor === 'doubao') : providers;

  function set(value: string) {
    setErr('');
    start(async () => {
      const r = await actSetRouting(fn, value);
      if (!r.ok) setErr(r.error ?? (isEn ? 'Setup failed' : '设置失败'));
      router.refresh();
    });
  }

  if (options.length === 0) {
    return (
      <span className="small muted">
        {doubaoOnly ? (isEn ? 'Requires a "Volcengine Doubao" channel' : '需要一条「火山引擎 豆包」渠道') : (isEn ? 'No channels available' : '还没有可选渠道')}
      </span>
    );
  }

  return (
    <span className="row" style={{ gap: 6, alignItems: 'center' }}>
      <select
        className="select"
        style={{ maxWidth: 190, fontSize: 12.5 }}
        value={current}
        disabled={pending}
        onChange={(e) => set(e.target.value)}
      >
        <option value="">{isEn ? 'Follow Default Channel' : '跟随默认渠道'}</option>
        {options.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
            {p.status === 'failed' ? (isEn ? ' (Failed)' : '（连通失败）') : ''}
          </option>
        ))}
      </select>
      {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
    </span>
  );
}
