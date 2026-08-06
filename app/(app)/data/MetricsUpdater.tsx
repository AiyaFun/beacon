'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/icons';
import { actUpdateMetrics } from './actions';

type Insight = { kind: string; text: string };

// 发布回流表的行内「更新数据」：回填最新流量 → 滚动快照 → 触发账号属性学习
export function MetricsUpdater({
  publishId,
  initial,
}: {
  publishId: string;
  initial: { views?: number; likes?: number; comments?: number; shares?: number; collects?: number; completion?: number };
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [err, setErr] = useState('');
  const [insights, setInsights] = useState<Insight[] | null>(null);
  const [form, setForm] = useState({
    views: initial.views ?? 0,
    likes: initial.likes ?? 0,
    comments: initial.comments ?? 0,
    shares: initial.shares ?? 0,
    collects: initial.collects ?? 0,
    completion: initial.completion ? Math.round(initial.completion * 100) : 0,
  });
  const router = useRouter();

  function submit() {
    setErr('');
    start(async () => {
      const r = await actUpdateMetrics(publishId, { ...form, completion: form.completion });
      if (!r.ok) {
        setErr(r.error ?? '更新失败');
        return;
      }
      setInsights(r.insights ?? []);
      setOpen(false);
      router.refresh();
    });
  }

  const num = (key: keyof typeof form, label: string, width = 84) => (
    <label className="small muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {label}
      <input
        className="input"
        type="number"
        min={0}
        style={{ width }}
        value={form[key] || ''}
        placeholder="0"
        onKeyDown={(e) => { if (['e', 'E', '+', '-'].includes(e.key)) e.preventDefault(); }}
        onChange={(e) => {
          const val = Math.max(0, Number(e.target.value) || 0);
          setForm({ ...form, [key]: key === 'completion' ? Math.min(100, val) : val });
        }}
      />
    </label>
  );

  return (
    <div>
      {!open ? (
        <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-sm btn-ghost" onClick={() => { setOpen(true); setInsights(null); }}>
            <Icon.refresh size={13} /> 更新数据
          </button>
          {insights && insights.length > 0 && (
            <span className="small" style={{ color: 'var(--brand)' }} title="本次回流触发的账号学习">
              <Icon.sparkles size={12} /> {insights[0].text}
            </span>
          )}
        </div>
      ) : (
        <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
          {num('views', '播放')}
          {num('likes', '赞', 68)}
          {num('comments', '评', 68)}
          {num('shares', '转', 68)}
          {num('collects', '藏', 68)}
          {num('completion', '完播%', 68)}
          <button className="btn btn-sm btn-primary" onClick={submit} disabled={pending || !form.views}>
            {pending ? '学习中…' : '保存并学习'}
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setOpen(false)} disabled={pending}>
            取消
          </button>
          {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
        </div>
      )}
    </div>
  );
}
