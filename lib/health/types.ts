// 健康收件箱的类型与标签：**零依赖**，客户端组件也能 import（agents.ts 引了 prisma）。

export type HealthLevel = 'ok' | 'warn' | 'bad';
export type HealthKind = 'model' | 'channel' | 'executor' | 'knowledge' | 'tool' | 'schedule';

export type HealthItem = {
  kind: HealthKind;
  level: HealthLevel;
  title: string;
  evidence: string;
  /** 证据时间（ISO），没有就 null */
  at: string | null;
  /** 影响的员工名 */
  affects: string[];
  action: { label: string; href: string };
};

export const HEALTH_KIND_LABEL: Record<HealthKind, string> = {
  model: '模型渠道', channel: '消息渠道', executor: '采集执行器', knowledge: '知识范围', tool: '自写工具', schedule: '定时器',
};
