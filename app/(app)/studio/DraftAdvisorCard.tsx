'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Icon } from '@/components/icons';
import { actConveneDraft } from '../advisor/actions';
import { actReviseByAdvice } from './actions';

// W-6 草稿会诊入口：把智囊团从「只评选题方向」扩到「评已成稿的正文」。
// 两步一条链：① 开会诊（12-16 席各提 1 条修改意见，去智囊团页逐条采纳/否决）
//            ② 按已采纳的意见定向改一版（落新 draftVersion，原版本不动）。
export function DraftAdvisorCard({
  draftId,
  adoptedCount,
  sessionCount,
}: {
  draftId: string;
  adoptedCount: number;
  sessionCount: number;
}) {
  const [seed, setSeed] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [pending, start] = useTransition();
  const router = useRouter();

  function run(fn: () => Promise<void>) {
    setErr('');
    setMsg('');
    start(async () => {
      try {
        await fn();
        router.refresh();
      } catch (e) {
        setErr((e as Error).message || '操作失败，请稍后重试');
      }
    });
  }

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="small muted">
        让 12 位人物读完这篇正文，各提 1 条最该改的意见——受众侧说读感，专家侧挑毛病。
        意见到智囊团页逐条采纳，再回来一键按采纳的意见改一版。
      </div>
      <div className="row wrap" style={{ gap: 8 }}>
        <input
          className="input"
          style={{ flex: 1, minWidth: 180 }}
          placeholder="想让他们重点看什么（选填），如：开头留不住人"
          value={seed}
          onChange={(e) => setSeed(e.target.value)}
          disabled={pending}
        />
        <button
          type="button"
          className="btn btn-sm"
          disabled={pending}
          onClick={() =>
            run(async () => {
              await actConveneDraft(draftId, seed);
              setSeed('');
              setMsg('会诊完成——去「选题智囊团」页逐条采纳意见');
            })
          }
        >
          <Icon.sparkles size={13} /> {pending ? '进行中…' : '开草稿会诊'}
        </button>
      </div>
      <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={pending || adoptedCount === 0}
          title={adoptedCount === 0 ? '先在智囊团页采纳至少 1 条意见' : undefined}
          onClick={() =>
            run(async () => {
              const r = await actReviseByAdvice(draftId);
              if (!r.ok) throw new Error(r.error ?? '改稿失败');
              setMsg(`已按 ${r.applied} 条采纳意见生成第 ${r.seq} 版${r.mocked ? '（演示内容：AI 未接入）' : ''}`);
            })
          }
        >
          <Icon.arrow size={13} /> 按已采纳意见改一版（{adoptedCount}）
        </button>
        {sessionCount > 0 && (
          <Link className="small" href="/advisor">
            已开 {sessionCount} 场草稿会诊 →
          </Link>
        )}
      </div>
      {msg && <div className="small" style={{ color: 'var(--brand)' }}>{msg}</div>}
      {err && <div className="small" style={{ color: 'var(--red)' }}>{err}</div>}
    </div>
  );
}
