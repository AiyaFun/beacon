'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Icon } from '@/components/icons';

type ChatTurn = { role: 'user' | 'assistant'; content: string };
type Msg = { role: 'user' | 'assistant'; content: string; mocked?: boolean; error?: boolean };

const QUICK = [
  '帮我想 3 个本周选题',
  '这条标题怎么改更抓人',
  '我的账号适合做什么变现',
];

export function Chat({ accountName }: { accountName: string }) {
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: 'assistant',
      content: `你好，我是「${accountName}」的 AI 运营助手。选题、文案、运营变现随便问——我会带上你的账号人设和历史记忆来答。`,
    },
  ]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streaming]);

  const send = useCallback(async (text: string) => {
    const q = text.trim();
    if (!q || streaming) return;

    const history: ChatTurn[] = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [...prev, { role: 'user', content: q }]);
    setInput('');
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, history }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setMessages((prev) => [...prev, { role: 'assistant', content: errBody.error || `请求失败 (${res.status})`, error: true }]);
        return;
      }

      setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop()!;
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') break;
          try {
            const delta = JSON.parse(payload) as string;
            setMessages((prev) => {
              const copy = [...prev];
              const last = copy[copy.length - 1];
              copy[copy.length - 1] = { ...last, content: last.content + delta };
              return copy;
            });
          } catch { /* skip */ }
        }
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: '出了点问题：' + (e as Error).message.slice(0, 60), error: true },
      ]);
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [messages, streaming]);

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  }

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 220px)', minHeight: 440 }}>
      <div className="wrap" style={{ gap: 8, marginBottom: 12 }}>
        {QUICK.map((q) => (
          <button
            key={q}
            className="btn btn-sm btn-ghost"
            disabled={streaming}
            onClick={() => send(q)}
          >
            <Icon.sparkles size={13} /> {q}
          </button>
        ))}
      </div>

      <div className="divider" style={{ marginTop: 0 }} />

      <div ref={listRef} className="stack" style={{ gap: 14, flex: 1, overflowY: 'auto', paddingRight: 4 }}>
        {messages.map((m, i) => (
          <Bubble key={i} msg={m} />
        ))}
        {streaming && messages[messages.length - 1]?.content === '' && (
          <div className="row" style={{ gap: 8, alignSelf: 'flex-start' }}>
            <span className="persona-avatar" style={{ background: 'var(--brand)' }}>
              <Icon.chat size={15} />
            </span>
            <div className="card" style={{ padding: '10px 14px', boxShadow: 'none', background: 'var(--surface-2)' }}>
              <span className="small muted">思考中…</span>
            </div>
          </div>
        )}
      </div>

      <div className="divider" />

      <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
        <textarea
          className="textarea"
          style={{ flex: 1, minHeight: 52, resize: 'none' }}
          placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"
          value={input}
          disabled={streaming}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
        />
        <button className="btn btn-primary" disabled={streaming || !input.trim()} onClick={() => send(input)}>
          {streaming ? '生成中…' : '发送'}
        </button>
      </div>
    </div>
  );
}

function Bubble({ msg }: { msg: Msg }) {
  const isUser = msg.role === 'user';
  const isError = !isUser && !!msg.error;
  return (
    <div
      className="row"
      style={{ gap: 8, alignItems: 'flex-start', alignSelf: isUser ? 'flex-end' : 'flex-start', maxWidth: '82%', flexDirection: isUser ? 'row-reverse' : 'row' }}
    >
      <span className="persona-avatar" style={{ background: isUser ? 'var(--surface-3, #64748b)' : isError ? 'var(--red)' : 'var(--brand)' }}>
        {isUser ? <Icon.user size={15} /> : <Icon.chat size={15} />}
      </span>
      <div
        className="card"
        style={{
          padding: '10px 14px',
          boxShadow: 'none',
          background: isUser ? 'var(--brand)' : isError ? 'var(--red-soft)' : 'var(--surface-2)',
          color: isUser ? '#fff' : 'var(--text)',
          whiteSpace: 'pre-wrap',
          lineHeight: 1.6,
        }}
      >
        {isError && (
          <span className="badge badge-red" style={{ marginBottom: 6, display: 'inline-block' }}>暂时没能回答</span>
        )}
        {!isUser && msg.mocked && (
          <span className="badge badge-amber" style={{ marginBottom: 6, display: 'inline-block' }}>Mock</span>
        )}
        <div className="small" style={{ color: isError ? 'var(--red)' : 'inherit' }}>{msg.content}</div>
      </div>
    </div>
  );
}
