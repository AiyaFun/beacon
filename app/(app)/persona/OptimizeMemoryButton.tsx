'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actOptimizeMemory } from './actions';

// 「立即优化」：手动跑一次记忆学习优化，回显本轮小结。
// 定时任务每天也会自动跑（optimize_memory），这颗按钮给用户即时手感。
export function OptimizeMemoryButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState('');

  function run() {
    start(async () => {
      const r = await actOptimizeMemory();
      setMsg(r.ok ? r.summary ?? '已优化' : '优化失败');
      router.refresh();
      setTimeout(() => setMsg(''), 6000);
    });
  }

  return (
    <div className="row wrap" style={{ gap: 10, alignItems: 'center' }}>
      <button className="btn btn-sm btn-primary" onClick={run} disabled={pending}>
        {pending ? '优化中…' : '⚡ 立即优化记忆'}
      </button>
      {msg && <span className="small muted">{msg}</span>}
    </div>
  );
}
