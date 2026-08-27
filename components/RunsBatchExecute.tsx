'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

// 运行中心「等你处理」卡的一键执行（2026-08-26 用户指定加在卡右上）。
//
// 【它怎么做到「执行」浏览器任务的】服务端推不动插件（三推论），但插件的内容脚本
// bridge.js 就注入在本站页面里，监听 window.postMessage 的 batch-collect——
// 这正是竞对页「批量采集」按钮走的同一条通道。点一下＝唤醒用户自己浏览器里的插件
// 立即把监控竞对采一遍，队列里那几条「去采一个竞对」要干的就是这件事。
// 插件不在场（没装/没连）时按钮如实降级成「先装插件 →」。
export function RunsBatchExecute() {
  const router = useRouter();
  const [present, setPresent] = useState(false);
  const [state, setState] = useState<'idle' | 'running' | 'done'>('idle');
  const [progress, setProgress] = useState('');

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== window || !e.data || typeof e.data !== 'object') return;
      const d = e.data as { __beacon?: string; data?: { done?: number; total?: number } };
      if (d.__beacon === 'ext-present') setPresent(true);
      if (d.__beacon === 'batch-progress' && d.data) {
        setState('running');
        setProgress(`${d.data.done ?? '?'}/${d.data.total ?? '?'}`);
      }
      if (d.__beacon === 'batch-done') {
        setState('done');
        // 采完刷新：等你处理那几条会被插件交活闭环掉
        router.refresh();
      }
    };
    window.addEventListener('message', onMsg);
    // 问一声插件在不在（bridge 加载即宣告，但本组件可能晚于它挂载）
    window.postMessage({ __beacon: 'ping' }, '*');
    return () => window.removeEventListener('message', onMsg);
  }, [router]);

  if (!present) {
    return (
      <Link href="/extension" className="btn btn-sm btn-ghost" title="一键执行需要浏览器插件在场：装好并连上后，这里就能直接唤醒它采集">
        一键执行需要插件 →
      </Link>
    );
  }
  if (state === 'running') {
    return <span className="small muted"><span className="run-live-spinner" style={{ display: 'inline-block', verticalAlign: -3, marginRight: 6 }} />插件采集中… {progress}</span>;
  }
  if (state === 'done') {
    return <span className="badge badge-green">✓ 这一轮采完了</span>;
  }
  return (
    <button
      type="button"
      className="btn btn-sm btn-primary"
      title="唤醒你浏览器里的插件，立刻把监控的竞对采一遍"
      onClick={() => { setState('running'); setProgress('启动中'); window.postMessage({ __beacon: 'batch-collect' }, '*'); }}
    >
      ⚡ 一键执行
    </button>
  );
}
