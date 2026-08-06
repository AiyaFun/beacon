'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

// 通用异步动作按钮：调用 server action，带 loading 与结果提示。
// 成功提示绿色、2.5s 自动消失；失败提示红色、完整展示可换行（配额/权限文案里
// 带「升级套餐 / 配自己的 Key」的自救指引，截断了用户就不知道怎么办），手动关闭。
export function ActionButton({
  action,
  children,
  primary,
  className,
  loadingText = '处理中…',
  confirmText,
}: {
  action: () => Promise<unknown>;
  children: React.ReactNode;
  primary?: boolean;
  className?: string;
  loadingText?: string | string[];
  confirmText?: string;
}) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string>('');
  const [failed, setFailed] = useState(false);
  const [loadingIdx, setLoadingIdx] = useState(0);
  const seq = useRef(0); // 上一次成功的自动消失定时器，不能误清后一次的提示
  const router = useRouter();

  useEffect(() => {
    if (!pending || !Array.isArray(loadingText) || loadingText.length <= 1) {
      setLoadingIdx(0);
      return;
    }
    const timer = setInterval(() => {
      setLoadingIdx((i) => (i + 1) % loadingText.length);
    }, 8000);
    return () => clearInterval(timer);
  }, [pending, loadingText]);

  const displayLoading = Array.isArray(loadingText) ? loadingText[loadingIdx] || loadingText[0] : loadingText;

  function show(text: string, isFail: boolean) {
    const id = ++seq.current;
    setMsg(text);
    setFailed(isFail);
    if (!isFail) {
      setTimeout(() => {
        if (seq.current === id) setMsg('');
      }, 2500);
    }
  }

  function run() {
    if (confirmText && !window.confirm(confirmText)) return;
    setMsg('');
    start(async () => {
      try {
        const r = (await action()) as Record<string, unknown> | undefined;
        if (r && typeof r === 'object') {
          if (r.ok === false) {
            show(typeof r.error === 'string' && r.error ? r.error : '没成功，请稍后重试', true);
            return;
          }
          if ('created' in r) show(`已生成 ${r.created} 条`, false);
          else if ('inserted' in r) show(`已更新 ${r.inserted} 条`, false);
          else if ('posts' in r) show(`已采集 ${r.posts} 条`, false);
          else show('完成', false);
        } else show('完成', false);
        router.refresh();
      } catch (e) {
        show((e as Error).message || '没成功，请稍后重试', true);
      }
    });
  }

  return (
    <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
      <button className={className ?? `btn btn-sm${primary ? ' btn-primary' : ''}`} onClick={run} disabled={pending}>
        {pending ? displayLoading : children}
      </button>
      {msg &&
        (failed ? (
          <span
            className="small"
            style={{
              color: 'var(--red)',
              background: 'var(--red-soft)',
              borderRadius: 6,
              padding: '4px 8px',
              display: 'inline-flex',
              alignItems: 'flex-start',
              gap: 6,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxWidth: 480,
              textAlign: 'left',
            }}
          >
            {msg}
            <button
              onClick={() => setMsg('')}
              aria-label="关闭提示"
              style={{
                background: 'none',
                border: 'none',
                color: 'inherit',
                padding: 0,
                lineHeight: 1.2,
                fontSize: 14,
                flexShrink: 0,
              }}
            >
              ×
            </button>
          </span>
        ) : (
          <span className="small" style={{ color: 'var(--green)' }}>{msg}</span>
        ))}
    </span>
  );
}
