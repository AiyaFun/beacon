'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui';
import { actIssueIngestToken } from '@/app/(app)/settings/actions';
import { useI18n } from '@/lib/i18n';

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
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const [inDesktop, setInDesktop] = useState(false);
  const [status, setStatus] = useState<{ registered: boolean; base?: string; label?: string; lastPollAt?: string; lastError?: string; host?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = async () => {
    const w = window as TauriWin;
    if (!w.__TAURI_INTERNALS__) return;
    try {
      setStatus((await w.__TAURI_INTERNALS__.invoke('executor_status')) as typeof status);
    } catch (e) {
      setMsg(isEn ? `Client version too old, lacking executor support (${e instanceof Error ? e.message : String(e)}). Please update desktop client first.` : `客户端版本太旧，还没有执行器能力（${e instanceof Error ? e.message : String(e)}）。先更新桌面客户端。`);
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
    <Card
      title={isEn ? 'Browser Use · Let this client collect for you' : '浏览器操作 · 让这台客户端替你采'}
      sub={isEn ? 'Collect without browser extensions: client runs an isolated collection browser in background' : '不装插件也能采：客户端在后台用一个独立的采集浏览器跑'}
      style={{ marginBottom: 16 }}
    >
      <p className="small muted" style={{ lineHeight: 1.8, margin: '0 0 10px' }}>
        {isEn ? (
          <>
            After registration, collection tasks dispatched by AI (collecting competitor profiles, backfilling your own X/TikTok profiles, reading webpages) are claimed by <b>this desktop client</b>,
            opened and read in an <b>isolated collection browser</b>, and returned directly to your workspace. It runs separately from your daily Chrome without interference—<b>no need to close or quit anything</b>.
            The only setup is logging into each platform once: the first time a platform is accessed, a window will appear on the login page; session state persists afterward.
            <b> Read-only</b>: does not click, fill, submit, or handle passwords for you.
          </>
        ) : (
          <>
            登记后，AI 派出的采集任务（采竞对主页、回填你自己的 X / TikTok 主页、读网页）由<b>这台电脑上的客户端</b>领走，
            用一个<b>独立的采集浏览器</b>打开页面读取，结果直接交回工作区。它跟你日常的 Chrome 分开、互不影响，<b>你不用退出任何东西</b>。
            代价是每个平台要各登录一次：首次采某平台时窗口会摆到你面前停在登录页，登完之后登录态长期留着。
            <b>只读</b>：不点击、不填写、不提交，不替你输账号密码。
          </>
        )}
      </p>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {status?.registered ? (
          <>
            <span className="badge badge-ok">{isEn ? 'Registered' : '已登记'}</span>
            <span className="small muted">
              {status.base}{status.lastPollAt ? (isEn ? ` · Last polled ${status.lastPollAt}` : ` · 最近领活 ${status.lastPollAt}`) : (isEn ? ' · Never polled' : ' · 还没轮询过')}
              {status.lastError ? <span style={{ color: 'var(--red)' }}> · {status.lastError}</span> : null}
            </span>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={async () => {
              setBusy(true); setMsg(null);
              try {
                await (window as TauriWin).__TAURI_INTERNALS__!.invoke('unregister_executor');
                await refresh();
                setMsg(isEn ? 'Unregistered. Token remains in Authorized Devices and can be revoked if no longer needed.' : '已解除。令牌仍在「已授权设备」里，不用了可以吊销。');
              } catch (e) {
                setMsg(e instanceof Error ? e.message : String(e));
              }
              setBusy(false);
            }}>{isEn ? 'Unregister' : '解除登记'}</button>
          </>
        ) : (
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} data-act="register-desktop-executor" onClick={async () => {
            setBusy(true); setMsg(null);
            try {
              const issued = await actIssueIngestToken(false, { agent: 'desktop', host: status?.host });
              const token = (issued as { token?: string }).token;
              if (!token) throw new Error(isEn ? 'Failed to issue token' : '没签出令牌');
              await (window as TauriWin).__TAURI_INTERNALS__!.invoke('register_executor', { base: location.origin, token });
              await refresh();
              setMsg(isEn ? 'Registered. Tasks like "Collect my X" will be claimed and completed by the client within a minute.' : '已登记。现在派「采我的 X」这类任务，客户端会在一分钟内领走并跑完。');
            } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
            setBusy(false);
          }}>{busy ? (isEn ? 'Registering…' : '登记中…') : (isEn ? 'Register this client as collector' : '把这台客户端登记为采集执行器')}</button>
        )}
      </div>
      {msg && <p className="small" style={{ marginTop: 8, lineHeight: 1.7 }}>{msg}</p>}
    </Card>
  );
}
