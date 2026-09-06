'use client';

import { useTransition, useState } from 'react';
import { Icon } from '@/components/icons';
import { actAnalyzeStyle } from './actions';
import { useI18n } from '@/lib/i18n';

export function StyleAnalyzeButton() {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState('');

  function run() {
    setMsg('');
    start(async () => {
      const r = await actAnalyzeStyle();
      if (r.ok) {
        setMsg(r.mocked ? (isEn ? 'Extraction complete (Mock mode)' : '提取完成（Mock 模式）') : (isEn ? 'Style fingerprint updated' : '风格指纹已更新'));
      } else {
        setMsg(r.error ?? (isEn ? 'Extraction failed' : '提取失败'));
      }
    });
  }

  return (
    <div className="row" style={{ gap: 10, alignItems: 'center' }}>
      <button className="btn btn-sm" onClick={run} disabled={pending}>
        <Icon.bulb size={13} /> {pending ? (isEn ? 'Analyzing…' : '分析中…') : (isEn ? 'Extract style from works' : '从作品提取风格')}
      </button>
      {msg && (
        <span className="small" style={{ color: msg.includes('失败') || msg.includes('failed') ? 'var(--red)' : 'var(--green)' }}>
          {msg}
        </span>
      )}
    </div>
  );
}
