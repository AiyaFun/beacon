'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui';
import { actIssueIngestToken } from '@/app/(app)/settings/actions';

// 把这台桌面客户端登记为采集执行器（2026-09-03）。
//
// 【为什么有这张卡】用户在 Mac 客户端里连的是云端账号：服务在机房，够不到他的 Chrome；
// 整机版那条「本机浏览器」路在这里不存在。他要的是「像 Claude Code 一样给个 Browser use 的权限」——
// 那个权限的载体只能是客户端本身：签一枚采集令牌交给壳，壳在后台领活、用本机 Chrome 采、交回。
// 与插件是**同一套令牌、同一条任务队列、同一份解析器**，只是执行者从内容脚本换成了 CDP。
//
// 只在桌面壳里渲染（window.__TAURI_INTERNALS__ 在才是）：浏览器里看到这张卡只会困惑。
// 令牌**不经过页面存储**：签发后直接 invoke 交给壳，页面不留副本。

type TauriWin = Window & { __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };

export function DesktopExecutorCard() {
  const [inDesktop, setInDesktop] = useState(false);
  const [status, setStatus] = useState<{ registered: boolean; base?: string; label?: string; lastPollAt?: string; lastError?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = async () => {
    const w = window as TauriWin;
    if (!w.__TAURI_INTERNALS__) return;
    try {
      setStatus((await w.__TAURI_INTERNALS__.invoke('executor_status')) as typeof status);
    } catch (e) {
      setMsg(`客户端版本太旧，还没有执行器能力（${e instanceof Error ? e.message : String(e)}）。先更新桌面客户端。`);
    }
  };

  useEffect(() => {
    const w = window as TauriWin;
    if (!w.__TAURI_INTERNALS__) return;
    setInDesktop(true);
    void refresh();
  }, []);

  if (!inDesktop) return null;

  return (
    <Card title="浏览器操作 · 让这台客户端替你采" sub="不装插件也能采：客户端在后台用你自己的 Chrome 跑" style={{ marginBottom: 16 }}>
      <p className="small muted" style={{ lineHeight: 1.8, margin: '0 0 10px' }}>
        登记后，AI 派出的采集任务（采竞对主页、回填你自己的 X / TikTok 主页、读网页）由<b>这台电脑上的客户端</b>领走，
        用你的 Chrome（带调试端口）打开页面读取，结果直接交回工作区。<b>只读</b>：不点击、不填写、不提交，不替你登录。
        Chrome 需要带调试端口启动——客户端会自己拉起；已经开着的话第一次要完全退出再让它起一次。
      </p>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {status?.registered ? (
          <>
            <span className="badge badge-ok">已登记</span>
            <span className="small muted">
              {status.base}{status.lastPollAt ? ` · 最近领活 ${status.lastPollAt}` : ' · 还没轮询过'}
              {status.lastError ? <span style={{ color: 'var(--red)' }}> · {status.lastError}</span> : null}
            </span>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={async () => {
              setBusy(true); setMsg(null);
              try { await (window as TauriWin).__TAURI_INTERNALS__!.invoke('unregister_executor'); await refresh(); setMsg('已解除。令牌仍在「已授权设备」里，不用了可以吊销。'); }
              catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
              setBusy(false);
            }}>解除登记</button>
          </>
        ) : (
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} data-act="register-desktop-executor" onClick={async () => {
            setBusy(true); setMsg(null);
            try {
              const issued = await actIssueIngestToken();
              const token = (issued as { token?: string }).token;
              if (!token) throw new Error('没签出令牌');
              await (window as TauriWin).__TAURI_INTERNALS__!.invoke('register_executor', { base: location.origin, token });
              await refresh();
              setMsg('已登记。现在派「采我的 X」这类任务，客户端会在一分钟内领走并跑完。');
            } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
            setBusy(false);
          }}>{busy ? '登记中…' : '把这台客户端登记为采集执行器'}</button>
        )}
      </div>
      {msg && <p className="small" style={{ marginTop: 8, lineHeight: 1.7 }}>{msg}</p>}
    </Card>
  );
}
