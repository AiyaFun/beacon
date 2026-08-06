'use client';

import { useState, useTransition } from 'react';
import { Icon } from '@/components/icons';
import { TierBadge } from '@/components/ui';
import { useRouter } from 'next/navigation';
import { actSubmitFeedback, actResolveFeedback, type FeedbackItem } from './actions';

// canResolve：当前成员是否有 compliance.resolve 权限（owner/admin）。由服务端算好传进来，
// 客户端不做权限判断——这里只决定「要不要渲染按钮」，真正的闸门在 server action 里。
type Props = { items: FeedbackItem[]; canResolve?: boolean };

const STATUS_BADGE: Record<string, { cls: string; label: string }> = {
  pending: { cls: 'badge-amber', label: '待处理' },
  accepted: { cls: 'badge-green', label: '已采纳' },
  rejected: { cls: 'badge-gray', label: '已驳回' },
};

export function FeedbackPanel({ items, canResolve = false }: Props) {
  const [word, setWord] = useState('');
  const [context, setContext] = useState('');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState('');
  const [submitting, start] = useTransition();
  const [resolving, startResolve] = useTransition();
  const router = useRouter();

  function resolve(id: string, status: 'accepted' | 'rejected') {
    setMsg('');
    startResolve(async () => {
      const r = await actResolveFeedback(id, status);
      if (!r.ok) {
        setMsg(r.error ?? '处理失败');
        return;
      }
      // 采纳且确实停用了自定义词时说清楚——否则「已采纳」只是个标签，用户不知道下次还拦不拦
      setMsg(
        status === 'accepted'
          ? r.disabledWord
            ? '已采纳，并已停用该自定义词（下次检测不再拦）'
            : '已采纳。该词属全局词库（法律/平台/行业级），本工作区无法单独停用，将走词库运营流程复核'
          : '已驳回，维持拦截',
      );
      router.refresh();
    });
  }

  function submit() {
    setMsg('');
    start(async () => {
      const r = await actSubmitFeedback({ word, tier: 'unknown', context, reason });
      if (r.ok) {
        setWord('');
        setContext('');
        setReason('');
        setMsg('反馈已提交，我们会尽快处理');
      } else {
        setMsg(r.error ?? '提交失败');
      }
    });
  }

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="grid grid-2" style={{ gap: 10 }}>
        <div className="field">
          <label className="field-label">误报词条</label>
          <input
            className="input"
            placeholder="被误判的词或表达"
            value={word}
            onChange={(e) => setWord(e.target.value)}
            maxLength={50}
          />
        </div>
        <div className="field">
          <label className="field-label">原文上下文</label>
          <input
            className="input"
            placeholder="该词在原文中的前后语境"
            value={context}
            onChange={(e) => setContext(e.target.value)}
            maxLength={200}
          />
        </div>
      </div>
      <div className="field">
        <label className="field-label">反馈原因</label>
        <textarea
          className="textarea"
          rows={2}
          placeholder="说明为什么认为这是误报，或提供替代建议…"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
        />
      </div>
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <button className="btn btn-primary btn-sm" onClick={submit} disabled={submitting || !word.trim() || !reason.trim()}>
          <Icon.arrow size={13} /> {submitting ? '提交中…' : '提交反馈'}
        </button>
        {msg && (
          <span className="small" style={{ color: msg.includes('失败') ? 'var(--red)' : 'var(--green)' }}>
            {msg}
          </span>
        )}
      </div>

      {items.length > 0 && (
        <>
          <div className="divider" />
          <div className="small muted">历史反馈</div>
          <div className="stack" style={{ gap: 8 }}>
            {items.map((f) => {
              const badge = STATUS_BADGE[f.status] ?? STATUS_BADGE.pending;
              return (
                <div key={f.id} className="list-row" style={{ alignItems: 'center' }}>
                  <span className="mono" style={{ minWidth: 80, fontWeight: 600 }}>{f.word}</span>
                  <TierBadge tier={f.tier} />
                  <span className={`badge ${badge.cls}`} style={{ fontSize: 10 }}>{badge.label}</span>
                  <span className="small muted" style={{ flex: 1 }}>{f.reason.slice(0, 60)}</span>
                  {/* 待处理 + 有权处理 → 给出结论入口。
                      此前这里没有任何动作能改 status，三个徽章里只有「待处理」可达。 */}
                  {canResolve && f.status === 'pending' && (
                    <span className="row" style={{ gap: 6 }}>
                      <button
                        className="btn btn-sm btn-ghost"
                        disabled={resolving}
                        onClick={() => resolve(f.id, 'accepted')}
                        title="确认是误报。若是本工作区的自定义词，会顺手停用它"
                        style={{ fontSize: 11 }}
                      >
                        采纳
                      </button>
                      <button
                        className="btn btn-sm btn-ghost"
                        disabled={resolving}
                        onClick={() => resolve(f.id, 'rejected')}
                        title="确认不是误报，维持拦截"
                        style={{ fontSize: 11 }}
                      >
                        驳回
                      </button>
                    </span>
                  )}
                  <span className="small muted">{new Date(f.createdAt).toLocaleDateString('zh-CN')}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
