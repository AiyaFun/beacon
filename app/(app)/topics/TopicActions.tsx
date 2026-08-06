'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actAccept, actReject } from './actions';
import { publishAccepted } from './accepted-bus';

// 已推荐选题卡片底部的「采纳 / 拒绝」操作。
// 拒绝展开内联小面板收集原因（快捷理由或自由输入）；原因原文传给
// actReject，回写偏好记忆，让后续推荐更懂用户。
const QUICK_REASONS = ['不感兴趣', '做过了', '不合人设'];

export function TopicActions({ topicId, title }: { topicId: string; title: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [rejecting, setRejecting] = useState(false); // 拒因面板展开中
  const [custom, setCustom] = useState(false); // 「其他」自由输入展开中
  const [reason, setReason] = useState('');
  const seq = useRef(0); // 成功提示的自动消失定时器，不能误清后一次的提示
  const router = useRouter();

  // 成功提示自动消失；失败提示常驻到下次操作（用户得看完原因）
  function show(ok: boolean, text: string) {
    const id = ++seq.current;
    setMsg({ ok, text });
    if (ok) {
      setTimeout(() => {
        if (seq.current === id) setMsg(null);
      }, 2500);
    }
  }

  function accept() {
    setMsg(null);
    start(async () => {
      try {
        const r = await actAccept(topicId);
        if (!r.ok) {
          show(false, '没能采纳：这条选题可能已被处理过，刷新页面再看看');
          return;
        }
        // 后续入口交给页面级的 AcceptedBar：这张卡片马上就要被重渲染卸载了，
        // 「去工坊起这篇稿」放在这里用户点不到（见 accepted-bus.ts）。
        publishAccepted({ id: topicId, title });
        setRejecting(false);
      } catch (e) {
        show(false, (e as Error).message || '没成功，请稍后重试');
      }
    });
  }

  function reject(reasonText: string) {
    setMsg(null);
    start(async () => {
      try {
        const r = await actReject(topicId, reasonText);
        if (!r.ok) {
          show(false, '没能拒绝：这条选题可能已被处理过，刷新页面再看看');
          return;
        }
        show(true, '已拒绝，理由已记入偏好');
        setRejecting(false);
        setCustom(false);
        setReason('');
        router.refresh();
      } catch (e) {
        show(false, (e as Error).message || '没成功，请稍后重试');
      }
    });
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <button className="btn btn-sm btn-primary" onClick={accept} disabled={pending}>
          采纳
        </button>
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => { setRejecting((v) => !v); setMsg(null); }}
          disabled={pending}
        >
          {rejecting ? '先不拒了' : '拒绝'}
        </button>
        {msg?.ok && <span className="small" style={{ color: 'var(--green)' }}>{msg.text}</span>}
      </div>

      {rejecting && (
        <div style={{ background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)', padding: 10 }}>
          <div className="small muted" style={{ marginBottom: 8 }}>
            这条哪里不合适？说一声，之后的推荐会更懂你
          </div>
          <div className="wrap">
            {QUICK_REASONS.map((q) => (
              <button key={q} className="btn btn-sm" onClick={() => reject(q)} disabled={pending}>
                {q}
              </button>
            ))}
            {!custom && (
              <button className="btn btn-sm btn-ghost" onClick={() => setCustom(true)} disabled={pending}>
                其他…
              </button>
            )}
          </div>
          {custom && (
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <input
                className="input"
                autoFocus
                placeholder="随便说说，比如：话题过时了"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !pending) reject(reason); }}
                disabled={pending}
              />
              <button className="btn btn-sm btn-primary" onClick={() => reject(reason)} disabled={pending} style={{ flexShrink: 0 }}>
                {pending ? '提交中…' : '提交'}
              </button>
            </div>
          )}
        </div>
      )}

      {msg && !msg.ok && (
        <div
          className="small"
          style={{
            color: 'var(--red)',
            background: 'var(--red-soft)',
            borderRadius: 'var(--radius-sm)',
            padding: '6px 10px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}
