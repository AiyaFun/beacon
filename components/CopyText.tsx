'use client';

import { useState } from 'react';
import { ensureAigcLabel, aigcHtmlPayload } from '@/lib/compliance/aigc';

// 通用「复制到剪贴板」按钮：发布后可随时把定稿正文重新复制回去二次分发。
//
// 复制是《人工智能生成合成内容标识办法》第四条明列的出口（「下载、复制、导出」），
// 因此**默认**追加 AIGC 显式标识，并在剪贴板 text/html flavor 里带上隐式标识元数据。
// 非 AI 生成的内容（如用户自己手打的原文）可显式传 aigc={false} 关掉。
export function CopyText({
  text,
  label = '复制内容',
  className,
  aigc = true,
}: {
  text: string;
  label?: string;
  className?: string;
  aigc?: boolean;
}) {
  const [done, setDone] = useState(false);

  async function copy() {
    const plain = aigc ? ensureAigcLabel(text) : text;
    try {
      // 优先写多 flavor：text/plain 带显式标识，text/html 额外带隐式标识元数据
      if (aigc && typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        const produceId = crypto.randomUUID();
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': new Blob([plain], { type: 'text/plain' }),
            'text/html': new Blob([aigcHtmlPayload(plain, produceId)], { type: 'text/html' }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(plain);
      }
    } catch {
      // 降级：不支持 clipboard 时用 textarea（显式标识仍在正文里，不丢合规）
      const ta = document.createElement('textarea');
      ta.value = plain;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '-9999px';
      ta.style.opacity = '0';
      ta.style.pointerEvents = 'none';
      ta.setAttribute('readonly', '');
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setDone(true);
    setTimeout(() => setDone(false), 1800);
  }

  return (
    <button className={className ?? 'btn btn-sm'} onClick={copy} disabled={!text} title={text ? '复制正文' : '暂无正文'}>
      {done ? '已复制 ✓' : label}
    </button>
  );
}
