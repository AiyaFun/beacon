'use client';

import { useState, useTransition } from 'react';
import { actExportData } from './actions';

// CSV 导出：调 server action 拿 base64，浏览器侧解码触发下载。导出=当前筛选所见即所得。
export function ExportButton({ range, platform }: { range: string; platform: string }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState('');

  function download(scope: 'publish' | 'snapshot') {
    setErr('');
    start(async () => {
      const r = await actExportData(scope, { range, platform });
      if (!r.ok || !r.dataBase64) {
        setErr(r.error ?? '导出失败');
        return;
      }
      const bin = atob(r.dataBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = r.filename ?? 'export.csv';
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  return (
    <div className="row" style={{ gap: 6, alignItems: 'center' }}>
      <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => download('publish')}>
        {pending ? '导出中…' : '导出明细'}
      </button>
      <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => download('snapshot')}>
        导出逐日
      </button>
      {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
    </div>
  );
}
