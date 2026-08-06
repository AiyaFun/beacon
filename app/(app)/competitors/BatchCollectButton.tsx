'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

// 「对标账号」卡片里的一键采集按钮。
// 本身只发一条 window 消息；真正「依次打开各竞对主页→采集→关闭」由浏览器插件(采集助手)完成
// （插件在烽火台域名注入的 content/bridge.js 接收并转发给后台编排）。
// 未装/未启用插件时按钮禁用并给出提示——app 页无法自己驱动多标签采集（浏览器弹窗拦截），必须靠插件。
export function BatchCollectButton({ count }: { count: number }) {
  const [extPresent, setExtPresent] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current?: string | null } | null>(null);
  const [doneMsg, setDoneMsg] = useState('');
  const router = useRouter();
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.source !== window || !e.data || typeof e.data !== 'object') return;
      const d = e.data as {
        __beacon?: string;
        data?: { done: number; total: number; current?: string; collected?: number; busy?: boolean; notes?: string[] };
      };
      if (d.__beacon === 'ext-present') setExtPresent(true);
      else if (d.__beacon === 'batch-progress' && d.data && !d.data.busy) {
        setDoneMsg('');
        setProgress({ done: d.data.done, total: d.data.total, current: d.data.current });
      } else if (d.__beacon === 'batch-done' && d.data) {
        setProgress(null);
        // notes 是「哪些号没采成、为什么」——公众号有节流规则（24h 一次、每轮 5 个、撞频控停手），
        // 被拦下的必须说出来。只报「已采集 3/5」会让用户以为另外两个失败了，然后反复点。
        const notes = Array.isArray(d.data.notes) ? d.data.notes.filter(Boolean) : [];
        setDoneMsg(`已采集 ${d.data.collected}/${d.data.total} 个竞对${notes.length ? `｜${notes.join('；')}` : ''}`);
        router.refresh(); // 拉最新采集结果
        if (doneTimer.current) clearTimeout(doneTimer.current);
        // 有 notes 时留久一点：那是「为什么没采」，6 秒读不完就没意义了
        doneTimer.current = setTimeout(() => setDoneMsg(''), notes.length ? 20000 : 6000);
      }
    }
    window.addEventListener('message', onMsg);
    window.postMessage({ __beacon: 'ping' }, '*'); // 询问插件是否在场
    return () => {
      window.removeEventListener('message', onMsg);
      if (doneTimer.current) clearTimeout(doneTimer.current);
    };
  }, [router]);

  function run() {
    setDoneMsg('');
    setProgress({ done: 0, total: count });
    window.postMessage({ __beacon: 'batch-collect' }, '*');
  }

  if (!extPresent) {
    return (
      <a href="/extension" className="small" style={{ color: 'var(--brand)' }} title="需安装并重载「烽火台采集助手」浏览器插件；一键采集由插件驱动">
        一键采集需插件 · 去下载 →
      </a>
    );
  }

  return (
    <span className="row" style={{ gap: 8, alignItems: 'center' }}>
      {progress ? (
        <span className="small muted">
          采集中 {progress.done}/{progress.total}
          {progress.current ? ` · ${progress.current}` : ''}…
        </span>
      ) : doneMsg ? (
        <span className="small" style={{ color: 'var(--green)' }}>{doneMsg}</span>
      ) : null}
      <button className="btn btn-sm btn-primary" onClick={run} disabled={!!progress || count === 0}>
        ⚡ 一键采集
      </button>
    </span>
  );
}
