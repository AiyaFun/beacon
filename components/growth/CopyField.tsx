'use client';

import { useState } from 'react';

/** 只读输入框 + 复制按钮。复制失败（非 https / 权限）时退回选中文本让用户手动复制。 */
export function CopyField({ value, lang }: { value: string; lang: string }) {
  const [done, setDone] = useState(false);
  const en = lang === 'en';
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    } catch {
      const el = document.getElementById('copy-field-input') as HTMLInputElement | null;
      el?.select();
    }
  }
  return (
    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
      <input id="copy-field-input" className="input" readOnly value={value} style={{ flex: 1, minWidth: 220, fontFamily: 'var(--font-mono)', fontSize: 12.5 }} onFocus={(e) => e.currentTarget.select()} />
      <button type="button" className="btn btn-sm btn-primary" onClick={copy}>{done ? (en ? 'Copied' : '已复制') : (en ? 'Copy link' : '复制链接')}</button>
    </div>
  );
}
