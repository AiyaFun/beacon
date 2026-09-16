'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { Card } from '@/components/ui';
import { Icon } from '@/components/icons';
import { actChatgptStartLogin, actChatgptPollLogin, actChatgptImportFromCli, actChatgptSetModel, actChatgptDisconnect } from './chatgpt-actions';
// 只引纯类型/常量文件：provider/auth/channel 带着 node:fs 与 prisma，进不了浏览器包（第一次部署就栽在这）
import { CHATGPT_REASONING_EFFORTS, type ReasoningEffort, type ChatgptChannelView } from '@/lib/llm/chatgpt/types';

// 「用 ChatGPT 订阅跑模型」那张卡（2026-09-15，只在整机版/私有化渲染，见 keys/page.tsx）。
//
// 登录是 device-code：点一下 → 这里显示一串码和 OpenAI 的链接 → 用户在浏览器里登录并输码 →
// 这里每几秒问一次服务端「好了没」→ 好了就刷新。密码永远不经过我们。
// 另一条路「从本机 Codex CLI 导入」：用户机器上 `codex login` 过就直接读它的登录态。

/** device-code 最多等多久（与 Codex CLI 同：15 分钟） */
const LOGIN_MAX_MS = 15 * 60_000;

type Props = { view: ChatgptChannelView | null; cliAvailable: boolean; readOnly: boolean };

export function ChatgptSubscriptionCard({ view, cliAvailable, readOnly }: Props) {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState('');
  const [failed, setFailed] = useState(false);
  const [login, setLogin] = useState<{ deviceAuthId: string; userCode: string; verifyUrl: string; intervalSec: number; startedAt: number } | null>(null);
  const [model, setModel] = useState(view?.model ?? '');
  const [effort, setEffort] = useState<ReasoningEffort>(view?.effort ?? 'medium');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setModel(view?.model ?? '');
    setEffort(view?.effort ?? 'medium');
  }, [view?.model, view?.effort]);

  function say(text: string, bad = false) {
    setMsg(text);
    setFailed(bad);
  }

  function stopPolling() {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }

  useEffect(() => () => stopPolling(), []);

  // 每 intervalSec 问一次；15 分钟没输码就放弃（OpenAI 那边的码也过期了）
  useEffect(() => {
    if (!login) return;
    stopPolling();
    timer.current = setInterval(async () => {
      if (Date.now() - login.startedAt > LOGIN_MAX_MS) {
        stopPolling();
        setLogin(null);
        say(isEn ? 'Login timed out (15 min). Start again.' : '登录超时（15 分钟没完成），重新点一次。', true);
        return;
      }
      const r = await actChatgptPollLogin(login.deviceAuthId, login.userCode);
      if (!r.ok) {
        stopPolling();
        setLogin(null);
        say(r.error, true);
        return;
      }
      if (r.status === 'done') {
        stopPolling();
        setLogin(null);
        say(isEn ? `Signed in${r.view?.email ? ` as ${r.view.email}` : ''}. Click "Test Connection" on the channel row to verify.` : `已登录${r.view?.email ? `（${r.view.email}）` : ''}。到下面渠道列表点「连通性测试」验一下。`);
        router.refresh();
      }
    }, Math.max(2, login.intervalSec) * 1000);
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [login]);

  function startLogin() {
    say('');
    start(async () => {
      const r = await actChatgptStartLogin();
      if (!r.ok) return say(r.error, true);
      setLogin({ ...r, startedAt: Date.now() });
    });
  }

  function importCli() {
    say('');
    start(async () => {
      const r = await actChatgptImportFromCli();
      if (!r.ok) return say(r.error, true);
      say(isEn ? `Imported from Codex CLI${r.view?.email ? ` (${r.view.email})` : ''}${r.model ? ` · model ${r.model}` : ''}.` : `已从本机 Codex CLI 导入${r.view?.email ? `（${r.view.email}）` : ''}${r.model ? ` · 模型 ${r.model}` : ''}。`);
      router.refresh();
    });
  }

  function saveModel() {
    say('');
    start(async () => {
      const r = await actChatgptSetModel(model, effort);
      if (!r.ok) return say(r.error ?? (isEn ? 'Save failed' : '保存失败'), true);
      say(isEn ? 'Saved. Run "Test Connection" again.' : '已保存，再点一次「连通性测试」。');
      router.refresh();
    });
  }

  function disconnect() {
    if (!window.confirm(isEn ? 'Disconnect ChatGPT subscription? Functions routed to it fall back to other channels.' : '断开 ChatGPT 订阅？指到它的功能会退回其它渠道。')) return;
    say('');
    start(async () => {
      const r = await actChatgptDisconnect();
      if (!r.ok) return say(r.error ?? '', true);
      say(isEn ? 'Disconnected.' : '已断开。');
      router.refresh();
    });
  }

  const connected = !!view;

  return (
    <Card
      title={isEn ? 'ChatGPT Subscription (no API key)' : 'ChatGPT 订阅（不用 API Key）'}
      sub={isEn
        ? 'Sign in with your own ChatGPT Plus/Pro account; usage counts against your subscription. Same path OpenClaw / Hermes use, officially allowed by OpenAI.'
        : '用你自己的 ChatGPT Plus/Pro 账号登录，用量算在订阅里。OpenClaw / Hermes 走的同一条路，OpenAI 官方允许；Claude 订阅没有这条路（官方禁止）。'}
      style={{ marginBottom: 16 }}
      action={<span className={`badge ${connected ? 'badge-green' : 'badge-gray'}`}><Icon.cpu size={13} /> {connected ? (isEn ? 'Connected' : '已接入') : (isEn ? 'Not connected' : '未接入')}</span>}
    >
      {connected && view && (
        <div className="stack" style={{ gap: 8, marginBottom: 12 }}>
          <div className="row wrap" style={{ gap: 10, alignItems: 'center' }}>
            <b>{view.email ?? (isEn ? 'ChatGPT account' : 'ChatGPT 账号')}</b>
            {view.plan && <span className="badge badge-gray">{view.plan}</span>}
            <span className="small muted">{isEn ? 'account' : '账号'} {view.accountId}</span>
            {view.isDefault && <span className="badge badge-brand">{isEn ? 'Default channel' : '默认渠道'}</span>}
          </div>
          <div className="small muted">
            {isEn ? 'Model' : '模型'} <span className="mono">{view.model}</span> · {isEn ? 'reasoning' : '推理强度'} {view.effort}
            {view.lastRefresh ? ` · ${isEn ? 'token refreshed' : '登录态刷新于'} ${new Date(view.lastRefresh).toLocaleString()}` : ''}
          </div>
        </div>
      )}

      {!readOnly && (
        <div className="stack" style={{ gap: 12 }}>
          {login ? (
            <div className="card" style={{ padding: 14, background: 'var(--surface-2)', boxShadow: 'none' }}>
              <div style={{ fontWeight: 650, marginBottom: 6 }}>{isEn ? 'Finish sign-in in your browser' : '在浏览器里完成登录'}</div>
              <ol className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
                <li>
                  {isEn ? 'Open ' : '打开 '}
                  <a href={login.verifyUrl} target="_blank" rel="noreferrer noopener">{login.verifyUrl}</a>
                  {isEn ? ' and sign in to ChatGPT' : ' 并登录你的 ChatGPT'}
                </li>
                <li>
                  {isEn ? 'Enter this code: ' : '输入这串码：'}
                  <b className="mono" style={{ fontSize: 18, letterSpacing: 2 }}>{login.userCode}</b>
                </li>
                <li>{isEn ? 'Come back here — this page checks every few seconds and finishes on its own.' : '回到这一页，它每几秒会自己检查一次，登好就自动接上。'}</li>
              </ol>
              <div className="row" style={{ gap: 8, marginTop: 10 }}>
                <span className="run-live-spinner" aria-hidden />
                <span className="small muted">{isEn ? 'Waiting for you to enter the code…' : '等你输码中…'}</span>
                <button className="btn btn-sm btn-ghost" onClick={() => { stopPolling(); setLogin(null); }}>{isEn ? 'Cancel' : '取消'}</button>
              </div>
            </div>
          ) : (
            <div className="row wrap" style={{ gap: 8 }}>
              <button className="btn btn-sm btn-primary" disabled={pending} onClick={startLogin}>
                {connected ? (isEn ? 'Sign in again' : '重新登录') : (isEn ? 'Sign in with ChatGPT' : '用 ChatGPT 账号登录')}
              </button>
              {cliAvailable && (
                <button className="btn btn-sm" disabled={pending} onClick={importCli} title={isEn ? 'Reads ~/.codex/auth.json on this machine. Both sides then share one login; whichever refreshes first may force the other to sign in again.' : '读这台机器上的 ~/.codex/auth.json。导入后两边共用一份登录态，哪边先续期另一边可能要重新登录一次'}>
                  {isEn ? 'Import from local Codex CLI' : '从本机 Codex CLI 导入'}
                </button>
              )}
              {connected && (
                <button className="btn btn-sm btn-ghost" disabled={pending} onClick={disconnect} style={{ color: 'var(--red)' }}>
                  {isEn ? 'Disconnect' : '断开'}
                </button>
              )}
            </div>
          )}

          {connected && (
            <div className="grid grid-2" style={{ gap: 12, alignItems: 'end' }}>
              <div className="field">
                <label className="field-label">{isEn ? 'Model (as listed in Codex CLI /model)' : '模型名（Codex CLI 的 /model 里能用的名字）'}</label>
                <input className="input mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-6-astra" />
              </div>
              <div className="row" style={{ gap: 8, alignItems: 'end' }}>
                <div className="field" style={{ flex: 1 }}>
                  <label className="field-label">{isEn ? 'Reasoning effort' : '推理强度'}</label>
                  <select className="select" value={effort} onChange={(e) => setEffort(e.target.value as ReasoningEffort)}>
                    {CHATGPT_REASONING_EFFORTS.map((e) => <option key={e} value={e}>{e}</option>)}
                  </select>
                </div>
                <button className="btn btn-sm" disabled={pending || !model.trim()} onClick={saveModel}>{isEn ? 'Save' : '保存'}</button>
              </div>
            </div>
          )}

          <div className="small muted" style={{ lineHeight: 1.7 }}>
            {isEn
              ? 'Rate limits follow your ChatGPT plan; when the limit is hit, calls fail with a clear message instead of silently switching. Route functions to this channel in "Function Routing" below (cover images: no server-side visible watermark on this path — route "Cover Image Gen" here only if you accept that).'
              : '限额跟着你的 ChatGPT 套餐走：撞到限额时调用会明确报错，不会静默换渠道。在下面「功能路由」里把想走它的功能指过来即可；封面生图指到它出的图没有方舟那种服务端强制水印（隐式标识照常注入），接受了再指。'}
          </div>
        </div>
      )}

      {msg && <div className="small" style={{ marginTop: 10, color: failed ? 'var(--red)' : 'var(--green)' }}>{msg}</div>}
    </Card>
  );
}
