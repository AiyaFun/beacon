'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/icons';
import { actIssueIngestToken } from '../settings/actions';

// 「一键把令牌写进插件」。与 app/login/ExtUnlink.tsx 的 clear-token 对称：一个下发、一个收回。
//
// 令牌**在点击的那一刻现签**，不再由页面预先渲染一个 token 属性传进来：
//   · 按设备签发之后，页面并不知道「当前这台设备该用哪一枚」——现签才拿得到本机那一枚；
//   · 顺带把令牌从服务端渲染的 HTML 里拿掉了。它此前会出现在每一次 /extension 的页面源码里，
//     哪怕用户根本没打算配置插件。
export function ExtAutoConfig({ host }: { host: string }) {
  const [extPresent, setExtPresent] = useState(false);
  const [status, setStatus] = useState<'idle' | 'sending' | 'done' | 'fail'>('idle');
  const [label, setLabel] = useState('');

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.source !== window || !e.data || typeof e.data !== 'object') return;
      if (e.data.__beacon === 'ext-present') setExtPresent(true);
      if (e.data.__beacon === 'config-token-done') setStatus('done');
    }
    window.addEventListener('message', onMessage);
    window.postMessage({ __beacon: 'ping' }, '*');
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  if (!extPresent) return null;

  async function send() {
    setStatus('sending');
    // 签发失败也要说破：静默回到 idle 的话，用户只会看到按钮闪了一下什么都没发生
    let issued;
    try {
      issued = await actIssueIngestToken();
    } catch {
      setStatus('fail');
      return;
    }
    setLabel(issued.label);
    window.postMessage({ __beacon: 'config-token', host, token: issued.token }, '*');
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setStatus((prev) => (prev === 'sending' ? 'fail' : prev)), 5000);
  }

  return (
    <div className="alert-gradient-green" style={{ padding: '10px 14px', marginTop: 12 }}>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <span style={{ color: 'var(--green)', flexShrink: 0 }}><Icon.check size={16} /></span>
        <span className="small" style={{ flex: 1 }}>
          检测到已安装烽火台插件
          {status === 'done' && `　·　已为「${label || '这台设备'}」签发令牌并写入插件`}
          {status === 'fail' && ' · 写入超时，请用下方令牌手动配置'}
        </span>
        {status === 'idle' && (
          <button className="btn btn-sm btn-primary" onClick={send}>
            一键配置这台设备
          </button>
        )}
        {status === 'sending' && <button className="btn btn-sm" disabled>签发并写入中…</button>}
        {status === 'done' && <span className="badge badge-green">已完成</span>}
      </div>
    </div>
  );
}
