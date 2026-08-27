'use client';

import { useEffect, useState } from 'react';
import { Chat } from './Chat';
import { AgentPanel } from './AgentPanel';
import type { SelectableModel } from '@/lib/llm/selectable';

type ToolInfo = { name: string; label: string; write: boolean; costly: boolean; contract: boolean; description: string };

// 一个入口，两条后端。
//
// 【为什么不再让用户先选模式】原来的做法是把「对话（只答不动手）/ 执行（AI 直接操作系统）」
// 两个页签摆在最前面，让用户自己判断这句话属于哪一类。但那是**系统内部的分类**：
// 「帮我想 3 条选题」既能当聊天答、也能真的落库，用户凭什么知道该点哪个。
//
// 【那条「合在一起用户永远不确定会不会动数据」的顾虑怎么解的】它是对的，所以没有合并成
// 一个模型自己决定动不动手的输入框。改成**先答后做**：默认走对话（不碰任何数据），
// 答完之后如果这句话像是让它去做（lib/agent/intent.ts，本地规则），就地给一个按钮，
// **用户点了才开一次执行**。于是「会不会动数据」的边界比原来更硬——
// 原来是「我点的是执行页签，所以它可能会动」，现在是「我按了那个按钮，所以它会动」。
//
// 页签保留（有人就是想直接进执行、也有人想纯聊天），但它不再是必须先做对的那道选择题。
export function AssistantTabs({
  accountName,
  models,
  tools,
  initialRunId,
  initialGoal,
}: {
  accountName: string;
  /** 可选模型清单，透传给对话的输入工具条 */
  models: SelectableModel[];
  tools: ToolInfo[];
  /** 从运行中心/提示条带过来的运行 id：进来就该看到那次执行，而不是空白输入框 */
  initialRunId?: string | null;
  /**
   * 从右下角浮标移交过来的那句话，**只预填、不开跑**。
   *
   * 自动开跑的代价：任意站点放一个 /assistant?goal=… 的链接，就能让登录用户
   * 发起一次付费执行；用户刷新或把地址分享给同事也会各重复开跑一次。
   * 页内的移交（Chat → AgentPanel）是另一回事——那一下点击本身就是授权。
   */
  initialGoal?: string | null;
}) {
  // 带着 run 或 goal 参数进来的，都是来干活的，别再让他先点一下页签
  const [mode, setMode] = useState<'chat' | 'agent'>(initialRunId || initialGoal ? 'agent' : 'chat');
  /** 对话里点了「让它直接去做」时交接过来的那句话。带序号是为了让同一句话也能再交接一次 */
  const [handoff, setHandoff] = useState<{ goal: string; seq: number } | null>(null);

  // 深链变化时跟着切（在助手页里点另一条「继续处理」不会走整页刷新）
  useEffect(() => {
    if (initialRunId) setMode('agent');
  }, [initialRunId]);

  return (
    <>
      <div className="tabs tabs-sub" style={{ justifyContent: "center" }}>
        <button className={`tab ${mode === 'chat' ? 'active' : ''}`} onClick={() => setMode('chat')}>
          问一句
        </button>
        <button className={`tab ${mode === 'agent' ? 'active' : ''}`} onClick={() => setMode('agent')}>
          让它去做
        </button>
      </div>
      {/* 两个都挂着、用 CSS 藏——对话是流式的，卸载重挂等于把刚才那段回答扔了，
          而「让它去做」的交接恰恰发生在读完那段回答之后 */}
      <div hidden={mode !== 'chat'}>
        <Chat
          accountName={accountName}
          models={models}
          onHandoff={(goal) => {
            setHandoff((h) => ({ goal, seq: (h?.seq ?? 0) + 1 }));
            setMode('agent');
          }}
        />
      </div>
      <div hidden={mode !== 'agent'}>
        <AgentPanel tools={tools} initialRunId={initialRunId ?? null} initialGoal={initialGoal ?? null} handoff={handoff} />
      </div>
    </>
  );
}
