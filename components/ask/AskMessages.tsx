'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/icons';
import { useI18n } from '@/lib/i18n';
import type { AskMsg } from './useAskStream';

// 「问一句」的对话气泡列表。只负责渲染，状态在 useAskStream 里。
// 首页那一框问出来的答案就摆在框下面——不再跳到另一页去看。

export function AskMessages({ messages, streaming }: { messages: AskMsg[]; streaming: boolean }) {
  const { lang } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streaming]);

  return (
    <div ref={listRef} className="stack ask-thread" style={{ gap: 14 }}>
      {messages.map((m, i) => (
        <Bubble key={i} msg={m} />
      ))}
      {streaming && messages[messages.length - 1]?.content === '' && (
        <div className="chat-bubble-row assistant">
          <span className="persona-avatar chat-ai-avatar">
            <Icon.sparkles size={14} />
          </span>
          <div className="chat-thinking-bubble">
            <span className="chat-thinking-pulse" />
            <span className="small muted">{lang === 'en' ? 'Thinking and organizing…' : '正在思考与组织回答…'}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Bubble({ msg }: { msg: AskMsg }) {
  const { lang } = useI18n();
  const [copied, setCopied] = useState(false);
  const isUser = msg.role === 'user';
  const isError = !isUser && !!msg.error;

  return (
    <div className={`chat-bubble-row ${isUser ? 'user' : 'assistant'}`}>
      <span className={`persona-avatar ${isUser ? 'chat-user-avatar' : 'chat-ai-avatar'}`}>
        {isUser ? <Icon.user size={14} /> : <Icon.sparkles size={14} />}
      </span>
      <div className={`chat-bubble ${isUser ? 'chat-bubble-user' : isError ? 'chat-bubble-error' : 'chat-bubble-ai'}`}>
        {isError && (
          <span className="badge badge-red" style={{ marginBottom: 6, display: 'inline-block' }}>
            {lang === 'en' ? 'Unable to respond' : '暂时没能回答'}
          </span>
        )}
        {!isUser && msg.mocked && (
          <span className="badge badge-amber" style={{ marginBottom: 6, display: 'inline-block' }}>
            Mock
          </span>
        )}
        <div className="chat-bubble-text">{msg.content}</div>

        {!isUser && !isError && msg.content && (
          <div className="chat-bubble-footer">
            <button
              type="button"
              className="chat-copy-btn"
              onClick={() => {
                void navigator.clipboard.writeText(msg.content);
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              }}
              title={lang === 'en' ? 'Copy content' : '复制内容'}
            >
              {copied ? <Icon.check size={12} /> : <Icon.copy size={12} />}
              <span>{copied ? (lang === 'en' ? 'Copied' : '已复制') : (lang === 'en' ? 'Copy' : '复制')}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
