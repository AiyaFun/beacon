'use client';

import { useState, useTransition } from 'react';
import { actExportDeliverable } from './actions';
import { AIGC_LABEL } from '@/lib/compliance/aigc';
import { useI18n } from '@/lib/i18n';

const FORMATS = [
  { key: 'docx', label: 'Word', enLabel: 'Word', beta: false },
  { key: 'pptx', label: '演示文稿', enLabel: 'Slides', beta: true },
] as const;

const BETA_HINT = '本地排版新功能，尚未经过大量真实稿件验证。导出后请先打开看一眼版面，遇到异常欢迎反馈。';

// 导出成交付物并下载。
export function ExportButtons({ draftId }: { draftId: string }) {
  const { lang } = useI18n();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState('');

  function run(format: (typeof FORMATS)[number]['key']) {
    setMsg('');
    start(async () => {
      const r = await actExportDeliverable(draftId, format);
      if (r.ok && r.dataBase64) {
        // base64 → Blob → 触发下载
        const bytes = Uint8Array.from(atob(r.dataBase64), (c) => c.charCodeAt(0));
        const blob = new Blob([bytes]);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = r.filename ?? `export.${format}`;
        a.click();
        URL.revokeObjectURL(url);
        setMsg(lang === 'en' ? 'Exported' : '已导出');
        setTimeout(() => setMsg(''), 2500);
      } else {
        // 红线拦截 / 标识校验未通过的原因较长，不自动消失，留给用户读完
        setMsg(r.error ?? (lang === 'en' ? 'Export failed' : '导出失败'));
      }
    });
  }

  return (
    <span className="row" style={{ gap: 6 }}>
      {FORMATS.map((f) => {
        const displayLabel = lang === 'en' ? f.enLabel : f.label;
        const btnText = pending
          ? (lang === 'en' ? 'Exporting…' : '导出中…')
          : (lang === 'en' ? `Export ${displayLabel}` : `导出${f.label}`);
        return (
          <span key={f.key} className="row" style={{ gap: 4 }}>
            <button
              className="btn btn-sm"
              onClick={() => run(f.key)}
              disabled={pending}
              title={lang === 'en' ? `Export as ${displayLabel}` : `导出为 ${f.label}：导出前会校验文件中确含「${AIGC_LABEL}」标识，未检出则中止导出。标识请勿删除。${f.beta ? `\n\nBeta：${BETA_HINT}` : ''}`}
            >
              {btnText}
            </button>
            {f.beta && <span className="badge badge-amber" title={BETA_HINT}>Beta</span>}
          </span>
        );
      })}
      {msg && <span className="small" style={{ color: msg === '已导出' || msg === 'Exported' ? 'var(--green)' : 'var(--red)' }}>{msg}</span>}
    </span>
  );
}
