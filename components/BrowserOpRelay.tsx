'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// AI 在你日常浏览器里操作页面：**页面中继 + 你看得见的那一块**（2026-09-17）。
//
// 【这个组件为什么是安全机制的一部分，而不只是界面】
// 这条路的动作全部经由它转发：服务端把下一步写进库 → 这里轮询取走 → postMessage 给插件 →
// 插件执行 → 结果原路送回。也就是说，**它在运行 = 用户打开着烽火台页面 = 他在场**。
// 他关掉标签页，轮询停止，lastSeenAt 不再刷新，服务端那条会话随即作废（180 秒）。
// 「只在你看着的时候才动」因此是一个物理事实，不是一句承诺。
//
// 【为什么不做成后台静默中继】做得到，但那恰好把这条路变成它最不该成为的东西：
// 一个可被远程驱动的、带着他全部登录态的浏览器。所以它必须显形——右下角那张卡片
// 一步一步写着刚才做了什么，随时可以按「停止」。
const IDLE_POLL_MS = 3000;
const BUSY_POLL_MS = 800;
/** 等插件回一步最多多久。超了就把失败如实交回服务端，别让模型干等 45 秒。 */
const STEP_WAIT_MS = 30_000;

type OpStep = { action: string; url?: string; ref?: string; text?: string; why?: string; direction?: string; seconds?: number; summary?: string };
type LogEntry = { at: string; what: string; ok: boolean; note?: string };
type SessionView = { id: string; origin: string; status: string; steps: number; log: LogEntry[]; awaitConfirm?: { label: string; why?: string } | null };

export function BrowserOpRelay() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [extPresent, setExtPresent] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const busy = useRef(false);
  const seq = useRef(0);

  // 插件在不在：bridge.js 加载时会 announce。没装插件的用户这个组件完全不轮询
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== window || !e.data || typeof e.data !== 'object') return;
      if ((e.data as { __beacon?: string }).__beacon === 'ext-present') setExtPresent(true);
    };
    window.addEventListener('message', onMsg);
    window.postMessage({ __beacon: 'ping' }, '*');
    return () => window.removeEventListener('message', onMsg);
  }, []);

  /** 把一步交给插件，等它的结果。id 配对，避免并发时串台。 */
  const runStep = useCallback((step: OpStep): Promise<Record<string, unknown>> => {
    const id = `op_${++seq.current}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        resolve({ ok: false, error: '插件 30 秒没有回应（可能被禁用了，或那一页卡住了）' });
      }, STEP_WAIT_MS);
      function onMsg(e: MessageEvent) {
        if (e.source !== window || !e.data || typeof e.data !== 'object') return;
        const d = e.data as { __beacon?: string; id?: string; result?: Record<string, unknown> };
        if (d.__beacon !== 'op-result' || d.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(d.result ?? { ok: false, error: '插件没有返回结果' });
      }
      window.addEventListener('message', onMsg);
      window.postMessage({ __beacon: 'op-step', id, step }, '*');
    });
  }, []);

  const tick = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const res = await fetch('/api/browser-op/relay', { cache: 'no-store' });
      // 【登录态过期时中间件会 307 到登录页】fetch 默认跟随重定向，于是 res.ok 为 true 而 body 是 HTML。
      // 不看 content-type 的话这里每一轮都会在 res.json() 上抛一次——功能不坏，但每 3 秒抛一个异常。
      // 认不出 JSON 就当「没有会话」，安静退到空闲轮询。
      if (!res.ok || !(res.headers.get('content-type') || '').includes('application/json')) {
        setSession(null);
        return;
      }
      const data = await res.json() as { session: SessionView | null; step: OpStep | null };
      setSession(data.session);
      if (!data.session || !data.step) return;

      const result = await runStep(data.step);
      // 结果原样交回服务端（页面内容是数据，这里不解释也不改写）
      await fetch('/api/browser-op/relay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: data.session.id,
          result,
          stepAction: data.step.action,
          what: data.step.action === 'click' && data.step.why
            ? `点「${String(result.clicked ?? data.step.ref)}」：${data.step.why}`
            : undefined,
        }),
      });
    } catch { /* 网络抖一下不该把中继打死，下一轮再来 */ } finally {
      busy.current = false;
    }
  }, [runStep]);

  useEffect(() => {
    if (!extPresent) return undefined;
    const ms = session ? BUSY_POLL_MS : IDLE_POLL_MS;
    const t = setInterval(tick, ms);
    return () => clearInterval(t);
  }, [extPresent, session, tick]);

  const post = useCallback(async (body: Record<string, unknown>) => {
    if (!session) return;
    await fetch('/api/browser-op/relay', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, ...body }),
    }).catch(() => {});
    await tick();
  }, [session, tick]);

  if (!session) return null;
  const log = session.log.slice(-6);
  const waiting = session.awaitConfirm;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed', right: 16, bottom: 16, zIndex: 900, width: collapsed ? 'auto' : 340,
        background: 'var(--card, #fff)', border: '1px solid var(--border, #e5e5e5)', borderRadius: 12,
        boxShadow: '0 8px 28px rgba(0,0,0,.14)', padding: 12, fontSize: 13, color: 'var(--text, #222)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: '#f26b3a', flexShrink: 0 }} />
        <b style={{ flex: 1, fontSize: 13 }}>
          AI 正在你的浏览器里操作
          <span style={{ fontWeight: 400, opacity: 0.7 }}>（第 {session.steps} 步）</span>
        </b>
        <button type="button" onClick={() => setCollapsed((c) => !c)} className="btn-ghost" style={{ fontSize: 12, padding: '2px 6px' }}>
          {collapsed ? '展开' : '收起'}
        </button>
      </div>

      {!collapsed && (
        <>
          <div style={{ opacity: 0.7, fontSize: 12, margin: '4px 0 8px' }}>{session.origin}</div>
          <ol style={{ margin: 0, padding: '0 0 0 16px', maxHeight: 150, overflowY: 'auto' }}>
            {log.map((e, i) => (
              <li key={`${e.at}-${i}`} style={{ marginBottom: 3, color: e.ok ? 'inherit' : 'var(--danger, #c33)' }}>
                {e.what}{e.note ? <span style={{ opacity: 0.7 }}>（{e.note}）</span> : null}
              </li>
            ))}
          </ol>

          {/* 不可逆动作：插件没点，停在这里。**默认让他自己点**，「替我点」要他主动选 */}
          {waiting ? (
            <div style={{ marginTop: 10, padding: 8, border: '1px solid var(--border, #e5e5e5)', borderRadius: 8, background: 'var(--bg-soft, #faf7f4)' }}>
              <div style={{ marginBottom: 6 }}>
                差最后一下：<b>「{waiting.label}」</b>是不可逆的动作，我不替你点。
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="btn-primary" style={{ fontSize: 12 }} onClick={() => post({ action: 'abort', reason: '用户选择自己点' })}>
                  我自己点（推荐）
                </button>
                <button type="button" className="btn-ghost" style={{ fontSize: 12 }} onClick={() => post({ action: 'confirm' })}>
                  确认，替我点这一下
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn-ghost" style={{ marginTop: 8, fontSize: 12 }} onClick={() => post({ action: 'abort', reason: '用户点了停止' })}>
              停止操作
            </button>
          )}
        </>
      )}
    </div>
  );
}
