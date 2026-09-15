// 能力注册表的类型与标签：**零依赖**，客户端组件也能 import（registry.ts 引了 prisma）。

export type CapabilityType = 'tool' | 'ai_tool' | 'skill' | 'procedure' | 'executor' | 'channel' | 'model';

export type CapabilityRow = {
  id: string;
  type: CapabilityType;
  name: string;
  label: string;
  description: string;
  installed: boolean;
  authorized: boolean;
  /** installed && authorized && 依赖齐 */
  usable: boolean;
  depsMissing: string[];
  fixHref: string;
  risk: { write: boolean; costly: boolean; contract: boolean };
  calls30d: number;
  successRate30d: number | null;
  lastCalledAt: string | null;
  /** 白名单里含它的自主智能体（按名字） */
  assignableAgents: string[];
};

export const CAPABILITY_TYPE_LABEL: Record<CapabilityType, string> = {
  tool: '动作工具', ai_tool: 'AI 自写工具', skill: '生成技能', procedure: '做法技能', executor: '采集执行器', channel: '消息渠道', model: '模型渠道',
};
