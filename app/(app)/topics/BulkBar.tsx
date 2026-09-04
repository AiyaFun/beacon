'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actBulkAccept, actBulkReject } from './actions';

// 「已推荐」分区的批量处理条。
// 此前只有单条采纳/拒绝：一次生成十条推荐，清空它要点十次。
//
// 设计取舍：批量拒绝**必须填一个共同原因**。拒绝原因会写进偏好记忆用于纠偏，
// 允许空原因批量拒绝＝往记忆里灌一堆「未说明原因」的噪声，让推荐越用越差。
import { useI18n } from '@/lib/i18n';

export function BulkBar({ ids }: { ids: string[] }) {
  const { lang } = useI18n();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState('');
  const [pending, start] = useTransition();
  const router = useRouter();

  const allOn = ids.length > 0 && selected.size === ids.length;

  function toggleAll() {
    setSelected(allOn ? new Set() : new Set(ids));
  }

  function done(r: { done: number; failed: number }, verb: string) {
    setSelected(new Set());
    setRejecting(false);
    setReason('');
    const vText = lang === 'en' ? (verb === '采纳' ? 'accepted' : 'rejected') : verb;
    const feedback = lang === 'en'
      ? (r.failed ? `${vText} ${r.done}, ${r.failed} failed` : `${vText} ${r.done} topics`)
      : (r.failed ? `已${verb} ${r.done} 条，${r.failed} 条未成功（可能已被处理，刷新看看）` : `已${verb} ${r.done} 条`);
    setMsg(feedback);
    router.refresh();
  }

  function accept() {
    setMsg('');
    start(async () => done(await actBulkAccept([...selected]), '采纳'));
  }

  function reject() {
    setMsg('');
    start(async () => done(await actBulkReject([...selected], reason), '拒绝'));
  }

  if (ids.length === 0) return null;

  return (
    <div
      className="card"
      style={{ padding: '10px 14px', marginBottom: 12, boxShadow: 'none', background: 'var(--surface-2)' }}
    >
      <div className="row wrap" style={{ gap: 10, alignItems: 'center' }}>
        <label className="row small" style={{ gap: 6, cursor: 'pointer', alignItems: 'center' }}>
          <input type="checkbox" checked={allOn} onChange={toggleAll} />
          {lang === 'en' ? `Select all ${ids.length} topics` : `全选本区 ${ids.length} 条`}
        </label>

        {selected.size > 0 && (
          <>
            <span className="badge badge-brand">{lang === 'en' ? `Selected ${selected.size}` : `已选 ${selected.size}`}</span>
            <button className="btn btn-sm btn-primary" onClick={accept} disabled={pending}>
              {pending ? (lang === 'en' ? 'Processing…' : '处理中…') : (lang === 'en' ? `Batch Accept (${selected.size})` : `批量采纳 ${selected.size} 条`)}
            </button>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => setRejecting((v) => !v)}
              disabled={pending}
            >
              {rejecting ? (lang === 'en' ? 'Cancel' : '先不拒了') : (lang === 'en' ? 'Batch Reject…' : '批量拒绝…')}
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())} disabled={pending}>
              {lang === 'en' ? 'Deselect All' : '取消选择'}
            </button>
          </>
        )}
        {msg && <span className="small" style={{ color: 'var(--green)' }}>{msg}</span>}
      </div>

      {rejecting && selected.size > 0 && (
        <div className="row wrap" style={{ gap: 8, marginTop: 10, alignItems: 'center' }}>
          <input
            className="input"
            autoFocus
            style={{ maxWidth: 320 }}
            placeholder={lang === 'en' ? 'Why reject these? (Tunes future recommendations)' : '这批为什么不合适？（会记进偏好，让后续推荐更准）'}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && reason.trim() && !pending) reject(); }}
          />
          <button className="btn btn-sm btn-primary" onClick={reject} disabled={pending || !reason.trim()}>
            {lang === 'en' ? `Confirm Reject (${selected.size})` : `确认拒绝 ${selected.size} 条`}
          </button>
          <span className="small muted">{lang === 'en' ? 'Reason required to tune preference memory' : '批量拒绝必须写原因——空原因会往记忆里灌噪声'}</span>
        </div>
      )}

      {/* 逐条勾选框：与卡片同源渲染太重，这里用一行紧凑的复选列表承载选择状态 */}
      <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
        {ids.map((id, i) => {
          const on = selected.has(id);
          return (
            <button
              key={id}
              type="button"
              className={`badge ${on ? 'badge-brand' : 'badge-gray'}`}
              style={{ cursor: 'pointer', border: 'none' }}
              title={on ? '取消选择这一条' : '选择这一条'}
              onClick={() =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
            >
              {on ? '✓ ' : ''}#{i + 1}
            </button>
          );
        })}
      </div>
    </div>
  );
}
