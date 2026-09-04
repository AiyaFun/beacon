'use client';

import { useState, useTransition } from 'react';
import { actAnalyzeHotFit } from '@/app/(app)/actions';
import type { HotFitAnalysis } from '@/lib/topic/combine';
import { useI18n } from '@/lib/i18n';

// 「账号内容 × 实时热点」结合分析：选一个实时热点，看它跟你的账号怎么结合。
// ⚠️ 仅对登录用户渲染（见 page.tsx）：actAnalyzeHotFit 走 LLM + getSession()+requireRole 守卫。
export function HotFitAnalyzer({ options }: { options: string[] }) {
  const [selected, setSelected] = useState('');
  const [custom, setCustom] = useState('');
  const [result, setResult] = useState<HotFitAnalysis | null>(null);
  const [err, setErr] = useState('');
  const [pending, start] = useTransition();
  const { dict } = useI18n();

  function run() {
    const hot = custom.trim() || selected;
    if (!hot) { setErr(dict.intel.fitSelectErr); return; }
    setErr('');
    start(async () => {
      const r = await actAnalyzeHotFit(hot);
      if (r.ok && r.analysis) setResult(r.analysis);
      else setErr(r.error ?? dict.intel.fitFailedErr);
    });
  }

  const fitColor = (n: number) => (n >= 75 ? 'var(--green)' : n >= 55 ? 'var(--amber)' : 'var(--red)');

  return (
    <div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <select className="select" style={{ maxWidth: 320 }} value={selected} onChange={(e) => { setSelected(e.target.value); setCustom(''); }}>
          <option value="">{dict.intel.fitSelectTopic}</option>
          {options.map((o) => (
            <option key={o} value={o}>{o.length > 26 ? o.slice(0, 26) + '…' : o}</option>
          ))}
        </select>
        <input
          className="input"
          style={{ maxWidth: 240 }}
          placeholder={dict.intel.fitCustomPlaceholder}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
        />
        <button className="btn btn-primary btn-sm" onClick={run} disabled={pending}>
          {pending ? dict.intel.fitPending : dict.intel.fitBtn}
        </button>
        {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
      </div>

      {result && (
        <div style={{ marginTop: 16 }}>
          <div className="row-between" style={{ marginBottom: 10 }}>
            <b className="small">「{result.hotTitle.length > 30 ? result.hotTitle.slice(0, 30) + '…' : result.hotTitle}」</b>
            <span className="row" style={{ gap: 6 }}>
              <span className="small muted">{dict.intel.fitScore}</span>
              <span style={{ fontSize: 20, fontWeight: 750, color: fitColor(result.fit) }}>{result.fit}</span>
              {result.mocked && <span className="badge badge-gray">Mock</span>}
            </span>
          </div>
          <div className="small" style={{ marginBottom: 12, padding: '8px 12px', background: 'var(--surface-2)', borderRadius: 8 }}>
            💡 {result.verdict}
          </div>

          <div className="field-label">结合切入角（差异化）</div>
          <div className="stack" style={{ gap: 8, marginBottom: 12 }}>
            {result.angles.map((a, i) => (
              <div key={i} className="card" style={{ padding: 10, boxShadow: 'none', background: 'var(--surface-2)' }}>
                <b className="small">{i + 1}. {a.angle}</b>
                <div className="small muted" style={{ marginTop: 3 }}>{a.why}</div>
              </div>
            ))}
          </div>

          {result.production.length > 0 && (
            <>
              <div className="field-label">制作建议</div>
              <ul className="small" style={{ margin: '0 0 12px', paddingLeft: 18, lineHeight: 1.8 }}>
                {result.production.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            </>
          )}

          <div className="small" style={{ color: 'var(--amber)' }}>⚠ {result.risk}</div>
        </div>
      )}
    </div>
  );
}
