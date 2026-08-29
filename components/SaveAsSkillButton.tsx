'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { actDistillProcedure } from '@/app/(app)/skills/procedure-actions';

/**
 * 「把这次的做法存成技能」——只在自己派的、已跑完的执行上出现。
 *
 * 【为什么不自动存】跑完就自动提炼，技能库会迅速被一堆一次性任务塞满
 * （「帮我看下昨天那条数据」这种存下来毫无用处）。值不值得复用只有人知道，
 * 所以做成一次点击。
 *
 * 【为什么存完不跳走】用户此刻在看执行结果，把他弹到技能页是打断。
 * 存完就地变成一行「已存为技能 · 去看看」，想去再去。
 */
export function SaveAsSkillButton({ runId }: { runId: string }) {
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (done) {
    return (
      <div className="small muted" style={{ marginTop: 12 }}>
        已存为技能 ·{' '}
        <Link href="/skills" style={{ color: 'var(--brand)', fontWeight: 600 }}>去技能库看看</Link>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 12 }}>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        disabled={pending}
        onClick={() => {
          setErr(null);
          start(async () => {
            const r = await actDistillProcedure(runId);
            if (r.ok) setDone(true);
            else setErr(r.error ?? '存不下来');
          });
        }}
      >
        {pending ? '提炼中…' : '把这次的做法存成技能'}
      </button>
      {err && <span className="small" style={{ marginLeft: 8, color: 'var(--red)' }}>{err}</span>}
    </div>
  );
}
