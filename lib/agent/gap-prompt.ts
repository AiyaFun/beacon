// 能力缺口 → 给开发助手（Claude Code / Codex）的一段提示。纯函数、无服务端依赖：
// 运行页的「复制开发提示」按钮（客户端）与 ops 页（服务端）都用它，两边文案不许各写一份。
//
// 【为什么缺口要变成一段可以直接贴给开发助手的话】用户要的是「做不到的时候能直接把能力补上」。
// SaaS 里模型不能自己往代码库写工具（那是另一条红线），能做到的是：把缺什么说得足够准，
// 准到开发助手照着就能加。所以这段提示里要有：用户原话、缺的是什么、建议的工具名与参数、
// 页面上现在怎么手动做——这四样齐了，补能力就是一次机械劳动。

export type CapabilityGap = {
  /** 用户想做什么（原话或转述） */
  need: string;
  /** 缺的是什么能力（一句话） */
  missing: string;
  /** 建议的工具名（snake_case） */
  tool?: string;
  /** 建议的参数（人话即可） */
  params?: string;
  /** 页面上现在在哪里手动做 */
  manual?: string;
};

export function parseGap(args: Record<string, unknown>): CapabilityGap {
  const s = (k: string) => (typeof args[k] === 'string' ? (args[k] as string).trim() : '');
  return { need: s('need'), missing: s('missing'), tool: s('tool') || undefined, params: s('params') || undefined, manual: s('manual') || undefined };
}

/** 贴给开发助手的话。goal 是这次执行用户最初那句话，与 need 可能相同。 */
export function gapDevPrompt(gap: CapabilityGap, goal?: string): string {
  return [
    '在烽火台（beacon）里给 AI 执行器补一个工具。',
    goal && goal !== gap.need ? `用户当时派的活：${goal}` : '',
    `用户想做的事：${gap.need || '（未说明）'}`,
    `AI 当时做不到的原因：${gap.missing || '（未说明）'}`,
    gap.tool ? `建议工具名：${gap.tool}` : '',
    gap.params ? `建议参数：${gap.params}` : '',
    gap.manual ? `页面上现在的手动路径：${gap.manual}` : '',
    '',
    '要求：按 lib/agent/tools-*.ts 现有的 AgentTool 契约实现（action 用对应页面 server action 的 RBAC 动作；',
    '会改数据的 write:true，会花钱的 costly:true，影响长期的 contract:true），注册进 lib/agent/tools.ts 的 AGENT_TOOLS，',
    '租户/工作区/账号一律取自 ToolContext 不接受模型传 id，并在 tests/agent 下补用例。',
  ].filter(Boolean).join('\n');
}
