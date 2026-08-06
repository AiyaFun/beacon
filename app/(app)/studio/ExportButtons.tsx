'use client';

import { useState, useTransition } from 'react';
import { actExportDeliverable } from './actions';
import { AIGC_LABEL } from '@/lib/compliance/aigc';

// 两种格式都能**真校验** AIGC 标识（OOXML=zip+XML，服务端解得开、没检出即 fail closed），
// 且都有本地零依赖渲染器（Word 见 lib/llm/skills.ts，演示文稿见 lib/deliverable/pptx.ts）——
// **不再依赖任何大模型 Key**，标准版即开即用。租户配了 Claude 渠道时才自动改走排版更丰富的 Agent Skills。
// beta：演示文稿的**本地渲染**是这轮新写的（骨架部件全部手拼），单测与 python-pptx/QuickLook
// 都验过，但没经过大量真实稿件的真机验证；Word 的本地生成器上线更早，不标。
const FORMATS = [
  { key: 'docx', label: 'Word', beta: false },
  { key: 'pptx', label: '演示文稿', beta: true },
] as const;

const BETA_HINT = '本地排版新功能，尚未经过大量真实稿件验证。导出后请先打开看一眼版面，遇到异常欢迎反馈。';

// 导出成交付物并下载。
// 导出件须内置 AIGC 显式标识（《标识办法》第四条），第七条禁止恶意删除该标识——
// 故在按钮上明示，避免用户拿到文件后顺手删掉标识而担责。
export function ExportButtons({ draftId }: { draftId: string }) {
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
        setMsg('已导出');
        setTimeout(() => setMsg(''), 2500);
      } else {
        // 红线拦截 / 标识校验未通过的原因较长，不自动消失，留给用户读完
        setMsg(r.error ?? '导出失败');
      }
    });
  }

  return (
    <span className="row" style={{ gap: 6 }}>
      {FORMATS.map((f) => (
        <span key={f.key} className="row" style={{ gap: 4 }}>
          <button
            className="btn btn-sm"
            onClick={() => run(f.key)}
            disabled={pending}
            title={`导出为 ${f.label}：导出前会校验文件中确含「${AIGC_LABEL}」标识，未检出则中止导出。标识请勿删除。${f.beta ? `\n\nBeta：${BETA_HINT}` : ''}`}
          >
            {pending ? '导出中…' : `导出${f.label}`}
          </button>
          {f.beta && <span className="badge badge-amber" title={BETA_HINT}>Beta</span>}
        </span>
      ))}
      {msg && <span className="small" style={{ color: msg === '已导出' ? 'var(--green)' : 'var(--red)' }}>{msg}</span>}
    </span>
  );
}
