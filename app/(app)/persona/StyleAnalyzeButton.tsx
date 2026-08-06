'use client';

import { useTransition, useState } from 'react';
import { Icon } from '@/components/icons';
import { actAnalyzeStyle } from './actions';

export function StyleAnalyzeButton() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState('');

  function run() {
    setMsg('');
    start(async () => {
      const r = await actAnalyzeStyle();
      if (r.ok) {
        setMsg(r.mocked ? '提取完成（Mock 模式）' : '风格指纹已更新');
      } else {
        setMsg(r.error ?? '提取失败');
      }
    });
  }

  return (
    <div className="row" style={{ gap: 10, alignItems: 'center' }}>
      <button className="btn btn-sm" onClick={run} disabled={pending}>
        <Icon.bulb size={13} /> {pending ? '分析中…' : '从作品提取风格'}
      </button>
      {msg && (
        <span className="small" style={{ color: msg.includes('失败') ? 'var(--red)' : 'var(--green)' }}>
          {msg}
        </span>
      )}
    </div>
  );
}
