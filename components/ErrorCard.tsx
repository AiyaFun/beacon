'use client';

import type { CSSProperties, ReactNode } from 'react';

// 三处错误边界（(app)/error、根 error、global-error）共用的错误卡片主体。
// 各处差异通过 props 保留：卡片外框样式、消息空缺时的兜底文案、回首页按钮（Link vs 原生 a）、重试行为。
export function ErrorCard({
  error,
  blurb,
  emptyFallback,
  cardStyle,
  onRetry,
  homeButton,
}: {
  error: { message?: string; digest?: string };
  blurb: string;
  // 有值 → 消息为空时显示它（消息框恒在）；无值 → 消息为空时整块不渲染
  emptyFallback?: string;
  cardStyle?: CSSProperties;
  onRetry: () => void;
  homeButton: ReactNode;
}) {
  const msg = error?.message || emptyFallback;
  return (
    <div className="card" style={{ maxWidth: 520, width: '100%', textAlign: 'center', padding: 28, ...cardStyle }}>
      <div style={{ fontSize: 34, marginBottom: 10 }}>🧯</div>
      <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>出错了，你的内容还在</h1>
      <p className="small muted" style={{ marginBottom: 14 }}>{blurb}</p>
      {msg && (
        <p
          className="small"
          style={{
            color: 'var(--red)',
            background: 'var(--red-soft)',
            borderRadius: 8,
            padding: '10px 12px',
            textAlign: 'left',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            marginBottom: 16,
          }}
        >
          {msg}
        </p>
      )}
      <div className="row" style={{ justifyContent: 'center', gap: 10 }}>
        <button className="btn btn-primary" onClick={onRetry}>重试</button>
        {homeButton}
      </div>
      {error?.digest && (
        <p className="small muted" style={{ marginTop: 12 }}>错误编号：{error.digest}</p>
      )}
    </div>
  );
}
