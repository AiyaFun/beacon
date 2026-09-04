'use client';

import { useEffect, useState } from 'react';
import { actIssueIngestToken } from '@/app/(app)/settings/actions';

// 桌面客户端的「浏览器操作」权限提示（2026-09-04）。
//
// 【为什么要有它】此前登记执行器的入口是设置组（默认折叠、钉在侧栏最底下）里的一张卡——
// 用户装了 1.2.6 客户端、派了三次「采我的 X」，全都停在「插件版本旧了，去登记客户端」，
// 而他从头到尾不知道那张卡在哪。用户的原话：「没有插件的时候，应该直接用 Browser use 去执行」。
// 他要的心智模型是 Claude Code 的权限设置：第一次需要时弹一条「允许吗？」，点允许就一直有效。
//
// 所以：只在桌面壳里（window.__TAURI_INTERNALS__ 在）、且还没登记时，在每一页顶部横一条；
// 点「允许」= 签一枚采集令牌交给壳（与设置页那张卡同一条链路），点「以后再说」记在本机 7 天。
// 登记之后它不再出现；执行器报错（最常见：Chrome 开着没带调试端口）时改为显示那条错误，
// 因为那是用户唯一需要动手的时刻——而且只能他自己动手（我们不替他关 Chrome）。
//
// 🔒 令牌不经过页面存储：签出后直接 invoke 交给壳。

type Status = { registered: boolean; base?: string; lastPollAt?: string; lastError?: string };
type TauriWin = Window & { __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };

const SNOOZE_KEY = 'beacon.desktop.browserUse.snoozedUntil';
const SNOOZE_MS = 7 * 24 * 3600 * 1000;

export function DesktopBrowserUsePrompt() {
  const [status, setStatus] = useState<Status | null>(null);
  const [inDesktop, setInDesktop] = useState(false);
  const [snoozed, setSnoozed] = useState(true); // 先当作已推迟，等读到本机值再决定，避免闪一下
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = async () => {
    const w = window as TauriWin;
    if (!w.__TAURI_INTERNALS__) return;
    try {
      setStatus((await w.__TAURI_INTERNALS__.invoke('executor_status')) as Status);
    } catch {
      // 旧客户端没有这个命令：不弹（弹了也做不了），设置页那张卡会说「先更新客户端」
      setStatus(null);
    }
  };

  useEffect(() => {
    const w = window as TauriWin;
    if (!w.__TAURI_INTERNALS__) return;
    setInDesktop(true);
    try {
      const until = Number(localStorage.getItem(SNOOZE_KEY) ?? 0);
      setSnoozed(until > Date.now());
    } catch { setSnoozed(false); }
    void refresh();
    // 登记后每分钟看一眼有没有报错（执行器自己就是每分钟领一次活）
    const t = setInterval(() => { void refresh(); }, 60_000);
    return () => clearInterval(t);
  }, []);

  if (!inDesktop || !status) return null;

  // 已登记且没报错：什么都不显示，权限已经给过了
  if (status.registered && !status.lastError) return null;

  // 已登记但执行器报错：说破那一条（多半是 Chrome 开着没带端口，只有用户能处理）
  if (status.registered && status.lastError) {
    return (
      <div className="card" role="status" data-testid="desktop-browser-use-error"
        style={{ margin: '0 0 12px', padding: '10px 14px', borderLeft: '3px solid var(--red)' }}>
        <div className="small" style={{ lineHeight: 1.7 }}>
          <b>浏览器操作暂时跑不动：</b>{status.lastError}
        </div>
      </div>
    );
  }

  if (snoozed) return null;

  const allow = async () => {
    setBusy(true); setMsg(null);
    try {
      const issued = await actIssueIngestToken(false, { agent: 'desktop' });
      const token = (issued as { token?: string }).token;
      if (!token) throw new Error('没签出令牌');
      await (window as TauriWin).__TAURI_INTERNALS__!.invoke('register_executor', { base: location.origin, token });
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };
  const snooze = () => {
    try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS)); } catch { /* 私密模式 */ }
    setSnoozed(true);
  };

  return (
    <div className="card" role="dialog" aria-label="浏览器操作权限" data-testid="desktop-browser-use-prompt"
      style={{ margin: '0 0 12px', padding: '12px 14px', borderLeft: '3px solid var(--brand, #f26b3a)' }}>
      <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>允许这台客户端操作浏览器采集？</div>
          <div className="small muted" style={{ lineHeight: 1.7 }}>
            不装插件也能采：AI 派的采集任务（采竞对主页、回填你自己的 X / TikTok 主页、读网页）由客户端在后台用你自己的 Chrome 打开页面读取，结果直接交回。
            <b>只读</b>：不点击、不填写、不提交，不替你登录。Chrome 需要带调试端口——客户端会自己拉起；已经开着的话第一次要完全退出（⌘Q）再让它起一次。
          </div>
          {msg && <div className="small" style={{ color: 'var(--red)', marginTop: 4 }}>{msg}</div>}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} data-act="allow-browser-use" onClick={allow}>
            {busy ? '登记中…' : '允许'}
          </button>
          <button type="button" className="btn btn-sm" disabled={busy} data-act="snooze-browser-use" onClick={snooze}>以后再说</button>
        </div>
      </div>
    </div>
  );
}
