'use client';

import { useEffect, useState } from 'react';
import { isChunkLoadError, recoverFromChunkError } from '@/lib/chunk-error';

/**
 * 挂在根 layout：兜住**没有**冒泡到 React 错误边界的分片加载失败。
 * 典型是 <script> 标签自身的 onerror、以及被 reject 但没人 catch 的动态 import——
 * 这两种不会触发 error.tsx，页面通常表现为「点了没反应」，比报错更难查。
 * 冒泡到错误边界的那一份由 useChunkErrorAutoReload 处理（三个 error.tsx 各自调用）。
 */
export function ChunkErrorRecovery() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      // event.error 在跨域脚本报错时为 null，退回用 message 文本判断
      if (isChunkLoadError(event.error) || isChunkLoadError(event.message)) {
        recoverFromChunkError();
      }
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      if (isChunkLoadError(event.reason)) recoverFromChunkError();
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  return null;
}

/**
 * 给三个错误边界用：错误若是分片加载失败就自动刷新一次。
 * @returns true = 正在刷新，调用方应渲染过渡态而不是错误卡片；
 *          false = 普通业务错误，或已经刷过一次仍失败，照常显示错误卡片。
 */
export function useChunkErrorAutoReload(error: unknown): boolean {
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    if (!isChunkLoadError(error)) return;
    if (recoverFromChunkError()) setReloading(true);
  }, [error]);

  return reloading;
}

/**
 * 自动刷新期间的过渡态。刻意做得极轻：这一瞬间页面就要被 reload 掉，
 * 放个加载动画反而会闪一下，不如一句安静的说明。
 */
export function ChunkReloadingNotice() {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <p className="small muted">页面正在更新到最新版本，马上就好…</p>
    </div>
  );
}
