'use client';

import { useState, useTransition } from 'react';
import { actRescoreTopic } from './actions';
import { useI18n } from '@/lib/i18n';

// 「重新评分」：只对 degraded（接了真模型但这次调用失败/超时被兜底）的选题出现。
// 没接真模型时重试必然拿到同样的 Mock 结果，那种情况不给按钮——按不动的按钮比没有更糟。
export function TopicRescore({ topicId }: { topicId: string }) {
  const { lang } = useI18n();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState('');

  function go() {
    setMsg('');
    start(async () => {
      const r = await actRescoreTopic(topicId);
      if (!r.ok) setMsg(r.error);
      // 成功但仍然降级：如实说，不要让用户对着一个「已重试」的假象反复点
      else if (r.stillDegraded) {
        setMsg(lang === 'en' ? 'AI has not responded yet, please try again later' : 'AI 仍未返回，稍后再试');
      }
    });
  }

  return (
    <span className="row" style={{ gap: 6, alignItems: 'center', marginTop: 6 }}>
      <button
        className="btn btn-sm btn-ghost"
        onClick={go}
        disabled={pending}
        title={
          lang === 'en'
            ? 'Re-invoke AI to score this topic without affecting other recommendations'
            : '重新调用 AI 给这条选题打分，不影响其他推荐'
        }
      >
        {pending
          ? (lang === 'en' ? 'Rescoring…' : '重新评分中…')
          : (lang === 'en' ? 'Rescore' : '重新评分')}
      </button>
      {msg && <span className="small" style={{ color: 'var(--red)' }}>{msg}</span>}
    </span>
  );
}
