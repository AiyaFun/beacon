// ChatGPT 订阅渠道里**客户端也要用**的常量与类型（2026-09-15）。
//
// 【为什么单独一个文件】这里不许 import 任何 node 内置模块或 prisma：设置页的卡片是 'use client' 组件，
// 它引到的模块会整个进浏览器包。auth.ts 用了 node:fs/os/path（读 ~/.codex/auth.json），
// 第一次部署就是被 ChatgptSubscriptionCard → provider → auth → node:path 这条链拦在 next build 上的。
// 规矩同仓库其它处：client 文件只引纯 types/常量文件。

export const DEFAULT_CHATGPT_MODEL = 'gpt-6-astra';
export type ReasoningEffort = 'low' | 'medium' | 'high';
export const CHATGPT_REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

/** 给界面看的渠道状态：不含任何 token。 */
export type ChatgptChannelView = {
  id: string;
  model: string;
  effort: ReasoningEffort;
  status: string;
  isDefault: boolean;
  email?: string;
  plan?: string;
  /** 只露账号 id 的尾巴 */
  accountId: string;
  lastRefresh: number;
  expiresAt: number;
};
