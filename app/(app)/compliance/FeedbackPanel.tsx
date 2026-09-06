'use client';

import { useState, useTransition } from 'react';
import { Icon } from '@/components/icons';
import { TierBadge } from '@/components/ui';
import { useRouter } from 'next/navigation';
import { actSubmitFeedback, actResolveFeedback, type FeedbackItem } from './actions';
import { fmtDateFull } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

type Props = { items: FeedbackItem[]; canResolve?: boolean };

const STATUS_BADGE: Record<string, { cls: string; labelZh: string; labelEn: string }> = {
  pending: { cls: 'badge-amber', labelZh: '待处理', labelEn: 'Pending' },
  accepted: { cls: 'badge-green', labelZh: '已采纳', labelEn: 'Accepted' },
  rejected: { cls: 'badge-gray', labelZh: '已驳回', labelEn: 'Rejected' },
};

export function FeedbackPanel({ items, canResolve = false }: Props) {
  const { lang } = useI18n();
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
        setMsg(r.error ?? (lang === 'en' ? 'Action failed' : '处理失败'));
        return;
      }
      setMsg(
        status === 'accepted'
          ? r.disabledWord
            ? (lang === 'en'
                ? 'Accepted and disabled this custom term (will no longer be flagged)'
                : '已采纳，并已停用该自定义词（下次检测不再拦）')
            : (lang === 'en'
                ? 'Accepted. This word belongs to the global rulebook and has been queued for rulebook review.'
                : '已采纳。该词属全局词库（法律/平台/行业级），本工作区无法单独停用，将走词库运营流程复核')
          : (lang === 'en' ? 'Rejected, blocking maintained' : '已驳回，维持拦截'),
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
        setMsg(lang === 'en' ? 'Feedback submitted, we will review it shortly' : '反馈已提交，我们会尽快处理');
      } else {
        setMsg(r.error ?? (lang === 'en' ? 'Submission failed' : '提交失败'));
      }
    });
  }

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="grid grid-2" style={{ gap: 10 }}>
        <div className="field">
          <label className="field-label">{lang === 'en' ? 'Flagged Term' : '误报词条'}</label>
          <input
            className="input"
            placeholder={lang === 'en' ? 'Misidentified term or phrase' : '被误判的词或表达'}
            value={word}
            onChange={(e) => setWord(e.target.value)}
            maxLength={50}
          />
        </div>
        <div className="field">
          <label className="field-label">{lang === 'en' ? 'Original Context' : '原文上下文'}</label>
          <input
            className="input"
            placeholder={lang === 'en' ? 'Surrounding sentence in the text' : '该词在原文中的前后语境'}
            value={context}
            onChange={(e) => setContext(e.target.value)}
            maxLength={200}
          />
        </div>
      </div>
      <div className="field">
        <label className="field-label">{lang === 'en' ? 'Reason for Feedback' : '反馈原因'}</label>
        <textarea
          className="textarea"
          rows={2}
          placeholder={
            lang === 'en'
              ? 'Explain why this is a false positive or suggest alternatives…'
              : '说明为什么认为这是误报，或提供替代建议…'
          }
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
        />
      </div>
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <button className="btn btn-primary btn-sm" onClick={submit} disabled={submitting || !word.trim() || !reason.trim()}>
          <Icon.arrow size={13} /> {submitting ? (lang === 'en' ? 'Submitting…' : '提交中…') : (lang === 'en' ? 'Submit Feedback' : '提交反馈')}
        </button>
        {msg && (
          <span className="small" style={{ color: msg.includes('失败') || msg.includes('failed') ? 'var(--red)' : 'var(--green)' }}>
            {msg}
          </span>
        )}
      </div>

      {items.length > 0 && (
        <>
          <div className="divider" />
          <div className="small muted">{lang === 'en' ? 'Feedback History' : '历史反馈'}</div>
          <div className="stack" style={{ gap: 8 }}>
            {items.map((f) => {
              const badge = STATUS_BADGE[f.status] ?? STATUS_BADGE.pending;
              const statusLabel = lang === 'en' ? badge.labelEn : badge.labelZh;
              return (
                <div key={f.id} className="list-row" style={{ alignItems: 'center' }}>
                  <span className="mono" style={{ minWidth: 80, fontWeight: 600 }}>{f.word}</span>
                  <TierBadge tier={f.tier} />
                  <span className={`badge ${badge.cls}`} style={{ fontSize: 10 }}>{statusLabel}</span>
                  <span className="small muted" style={{ flex: 1 }}>{f.reason.slice(0, 60)}</span>
                  {canResolve && f.status === 'pending' && (
                    <span className="row" style={{ gap: 6 }}>
                      <button
                        className="btn btn-sm btn-ghost"
                        disabled={resolving}
                        onClick={() => resolve(f.id, 'accepted')}
                        title={
                          lang === 'en'
                            ? 'Confirm as false positive. If custom term, it will be disabled.'
                            : '确认是误报。若是本工作区的自定义词，会顺手停用它'
                        }
                        style={{ fontSize: 11 }}
                      >
                        {lang === 'en' ? 'Accept' : '采纳'}
                      </button>
                      <button
                        className="btn btn-sm btn-ghost"
                        disabled={resolving}
                        onClick={() => resolve(f.id, 'rejected')}
                        title={lang === 'en' ? 'Confirm violation, keep blocking' : '确认不是误报，维持拦截'}
                        style={{ fontSize: 11 }}
                      >
                        {lang === 'en' ? 'Dismiss' : '驳回'}
                      </button>
                    </span>
                  )}
                  <span className="small muted">{fmtDateFull(f.createdAt)}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
