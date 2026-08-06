'use client';

import { useState, useTransition, useRef } from 'react';
import { Icon } from '@/components/icons';
import { PLATFORM_LIST } from '@/lib/constants';
import { actImportOwnPosts, type ImportResult } from './actions';

const TEMPLATE = `platform,title,publishedAt,views,likes,comments,shares,collects,completion
douyin,我的第一条视频,2025-03-15,12000,350,42,18,65,0.45
xiaohongshu,春季穿搭分享,2025-04-01,8500,620,85,12,230,`;

export function ImportPosts() {
  const [mode, setMode] = useState<'idle' | 'input'>('idle');
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [pending, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setCsv(reader.result as string);
      setMode('input');
    };
    reader.readAsText(file);
  }

  function submit() {
    if (!csv.trim()) return;
    setResult(null);
    start(async () => {
      const r = await actImportOwnPosts(csv);
      setResult(r);
      if (r.ok) setCsv('');
    });
  }

  if (mode === 'idle') {
    return (
      <div className="stack" style={{ gap: 12 }}>
        <div className="small muted" style={{ lineHeight: 1.7 }}>
          导入你在各平台的历史作品数据（CSV 格式），让学习引擎有更多样本计算你的真实基线。
          导入的数据用于对比分析，不会代发或操作任何平台。
        </div>
        <div className="row" style={{ gap: 10 }}>
          <button className="btn btn-sm" onClick={() => setMode('input')}>
            <Icon.edit size={13} /> 粘贴 CSV
          </button>
          <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
            <Icon.upload size={13} /> 选择文件
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              style={{ display: 'none' }}
              onChange={handleFile}
            />
          </label>
        </div>
        <details style={{ marginTop: 4 }}>
          <summary className="small muted" style={{ cursor: 'pointer' }}>CSV 格式说明</summary>
          <pre className="mono small" style={{ marginTop: 8, padding: 10, background: 'var(--surface-2)', borderRadius: 6, overflowX: 'auto', whiteSpace: 'pre-wrap' }}>
            {TEMPLATE}
          </pre>
          <div className="small muted" style={{ marginTop: 6, lineHeight: 1.7 }}>
            {/* 从 PLATFORM_LIST 现取，别手写——手写的那份每加一个平台就漏一次 */}
            platform: {PLATFORM_LIST.map((p) => p.key).join(' / ')}<br />
            completion: 完播率 0-1（或 0-100 自动折算），选填<br />
            每次最多导入 200 条
          </div>
        </details>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 12 }}>
      <textarea
        className="textarea mono"
        rows={8}
        placeholder="粘贴 CSV 内容…第一行为表头"
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
        style={{ fontSize: 12 }}
      />
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <button className="btn btn-primary btn-sm" onClick={submit} disabled={pending || !csv.trim()}>
          <Icon.arrow size={13} /> {pending ? '导入中…' : '确认导入'}
        </button>
        <button className="btn btn-sm" onClick={() => { setMode('idle'); setResult(null); }} disabled={pending}>
          取消
        </button>
        {result && (
          <span className="small" style={{ color: result.ok ? 'var(--green)' : 'var(--red)' }}>
            成功 {result.imported} 条{result.skipped > 0 ? `，跳过 ${result.skipped} 条` : ''}
          </span>
        )}
      </div>
      {result && result.errors.length > 0 && (
        <div className="small" style={{ color: 'var(--red)', lineHeight: 1.6 }}>
          {result.errors.map((e, i) => <div key={i}>{e}</div>)}
        </div>
      )}
    </div>
  );
}
