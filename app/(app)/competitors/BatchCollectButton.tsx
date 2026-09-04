'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { useI18n } from '@/lib/i18n';

// 「对标账号」卡片里的一键采集按钮。
export function BatchCollectButton({ count }: { count: number }) {
  const { lang, dict } = useI18n();
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
        const notes = Array.isArray(d.data.notes) ? d.data.notes.filter(Boolean) : [];
        const msg = lang === 'en'
          ? `Collected ${d.data.collected}/${d.data.total} rivals${notes.length ? ` | ${notes.join('; ')}` : ''}`
          : `已采集 ${d.data.collected}/${d.data.total} 个竞对${notes.length ? `｜${notes.join('；')}` : ''}`;
        setDoneMsg(msg);
        router.refresh();
        if (doneTimer.current) clearTimeout(doneTimer.current);
        doneTimer.current = setTimeout(() => setDoneMsg(''), notes.length ? 20000 : 6000);
      }
    }
    window.addEventListener('message', onMsg);
    window.postMessage({ __beacon: 'ping' }, '*');
    return () => {
      window.removeEventListener('message', onMsg);
      if (doneTimer.current) clearTimeout(doneTimer.current);
    };
  }, [router, lang]);

  function run() {
    setDoneMsg('');
    setProgress({ done: 0, total: count });
    window.postMessage({ __beacon: 'batch-collect' }, '*');
  }

  if (!extPresent) {
    return (
      <a href="/extension" className="small" style={{ color: 'var(--brand)' }} title={lang === 'en' ? 'Requires Beacon extension' : '需安装并重载「烽火台采集助手」浏览器插件'}>
        {lang === 'en' ? 'Batch collect needs extension · Download →' : '一键采集需插件 · 去下载 →'}
      </a>
    );
  }

  return (
    <span className="row" style={{ gap: 8, alignItems: 'center' }}>
      {progress ? (
        <span className="small muted">
          {lang === 'en' ? 'Collecting ' : '采集中 '}
          {progress.done}/{progress.total}
          {progress.current ? ` · ${progress.current}` : ''}…
        </span>
      ) : doneMsg ? (
        <span className="small" style={{ color: 'var(--green)' }}>{doneMsg}</span>
      ) : null}
      <button className="btn btn-sm btn-primary" onClick={run} disabled={!!progress || count === 0}>
        {lang === 'en' ? '⚡ One-Click Collect' : '⚡ 一键采集'}
      </button>
    </span>
  );
}
