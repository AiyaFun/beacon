'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/icons';
import { actConvene } from './actions';
import { useI18n } from '@/lib/i18n';

// P1-7 体检联动：六维体检的结论里写着「建议就这一维召开专项会诊」
export function WeakDimConvene({ dimName, score }: { dimName: string; score: number }) {
  const { lang } = useI18n();
  const [err, setErr] = useState('');
  const [pending, start] = useTransition();
  const router = useRouter();

  const seed =
    lang === 'en'
      ? `Convene a focused council on the weakest audit dimension "${dimName}" (${score} pts): Propose topic angles from your perspective to directly improve this dimension.`
      : `针对账号体检最弱的一维「${dimName}」（${score} 分）召开专项会诊：请从你的视角给出能直接改善这一维的选题方向`;

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
              setErr((e as Error).message || (lang === 'en' ? 'Failed to start consultation, please try again' : '会诊没开起来，请稍后重试'));
            }
          });
        }}
      >
        <Icon.gauge size={13} />{' '}
        {pending
          ? (lang === 'en' ? 'Convening…' : '会诊进行中…')
          : (lang === 'en' ? `Focus Council on "${dimName}"` : `就「${dimName}」开专项会诊`)}
      </button>
      {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
    </div>
  );
}
