'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/icons';
import { actConvene } from './actions';

// 召集智囊团：可带本次议题（seed），空议题=开放式会诊。
// 失败（权限不足 / AI 额度用尽等）红字完整展示——配额文案里带
// 「升级套餐 / 配自己的 Key」的自救指引，不截断。
import { useI18n } from '@/lib/i18n';

export function ConveneForm({ panelSize }: { panelSize: number }) {
  const { lang } = useI18n();
  const [seed, setSeed] = useState('');
  const [err, setErr] = useState('');
  const [pending, start] = useTransition();
  const router = useRouter();

  function run() {
    setErr('');
    start(async () => {
      try {
        await actConvene(seed);
        setSeed('');
        router.refresh();
      } catch (e) {
        setErr((e as Error).message || (lang === 'en' ? 'Session failed to start, please try again later' : '会诊没开起来，请稍后重试'));
      }
    });
  }

  return (
    <div className="stack" style={{ gap: 8, alignItems: 'flex-end' }}>
      <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
        <input
          className="input"
          style={{ width: 260 }}
          placeholder={lang === 'en' ? 'Topic prompt (optional), e.g. holiday trend hook' : '本次议题（选填），如：五一假期蹭什么热点'}
          value={seed}
          onChange={(e) => setSeed(e.target.value)}
          disabled={pending}
        />
        <button className="btn btn-primary" onClick={run} disabled={pending}>
          <Icon.users size={15} /> {pending ? (lang === 'en' ? 'Council in session…' : `${panelSize} 人物会诊中…`) : (lang === 'en' ? `Convene Council (${panelSize})` : `召集智囊团（${panelSize} 席）`)}
        </button>
      </div>
      {err && (
        <div
          className="small"
          style={{
            color: 'var(--red)',
            background: 'var(--red-soft)',
            borderRadius: 'var(--radius-sm)',
            padding: '6px 10px',
            maxWidth: 420,
            textAlign: 'left',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {err}
        </div>
      )}
    </div>
  );
}
