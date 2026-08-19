'use client';

import { useState } from 'react';
import { Chat } from './Chat';
import { AgentPanel } from './AgentPanel';

type ToolInfo = { name: string; label: string; write: boolean; costly: boolean; description: string };

// 两种模式分开摆，不合并成一个输入框：
// 「问一句」和「你去把它做了」是两种预期——合在一起时用户永远不确定这一句会不会真的动数据。
export function AssistantTabs({ accountName, tools }: { accountName: string; tools: ToolInfo[] }) {
  const [mode, setMode] = useState<'chat' | 'agent'>('chat');
  return (
    <>
      <div className="tabs">
        <button className={`tab ${mode === 'chat' ? 'active' : ''}`} onClick={() => setMode('chat')}>
          对话（只答不动手）
        </button>
        <button className={`tab ${mode === 'agent' ? 'active' : ''}`} onClick={() => setMode('agent')}>
          执行（AI 直接操作系统）
        </button>
      </div>
      {mode === 'chat' ? <Chat accountName={accountName} /> : <AgentPanel tools={tools} />}
    </>
  );
}
