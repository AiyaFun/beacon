'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/icons';
import { actConvene } from './actions';

// P1-7 体检联动：六维体检的结论里写着「建议就这一维召开专项会诊」，
// 此前那只是一句文案——这里把它变成一个真按钮，把最弱维度作为议题直接下发给全席。
export function WeakDimConvene({ dimName, score }: { dimName: string; score: number }) {
  const [err, setErr] = useState('');
  const [pending, start] = useTransition();
  const router = useRouter();

  const seed = `针对账号体检最弱的一维「${dimName}」（${score} 分）召开专项会诊：请从你的视角给出能直接改善这一维的选题方向`;

  return (
    <div className="stack" style={{ gap: 6, alignItems: 'flex-start' }}>
      <button
        type="button"
        className="btn btn-sm"
        disabled={pending}
        onClick={() => {
          setErr('');
          start(async () => {
            try {
              await actConvene(seed);
              router.refresh();
            } catch (e) {
              setErr((e as Error).message || '会诊没开起来，请稍后重试');
            }
          });
        }}
      >
        <Icon.gauge size={13} /> {pending ? '会诊进行中…' : `就「${dimName}」开专项会诊`}
      </button>
      {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
    </div>
  );
}
