import type { AgentTool } from './tool-types';
import { parseGap } from './gap-prompt';

// ── 能力缺口上报（2026-09-09）────────────────────────────────────────────────
//
// 【它修的是什么】用户说「帮我采集 X 的账号」，模型发现没有加账号的工具，回了一句
// 「抱歉，我没有这个工具，你自己去页面加」。用户要的是「做不到的时候，像 Codex 那样直接把能力补上」。
//
// 【SaaS 里模型不能自己写代码进仓库】那是本机 shell 的红线（lib/agent/shell.ts）。能做到、
// 也应该做到的是：把「缺什么」记成一条**结构化**的缺口——要什么工具、什么参数、页面上现在
// 在哪手动做——运行页上一键复制成给开发助手的提示，ops 页汇总所有缺口按频次排。
// 补能力从「用户口头抱怨 → 开发者猜」变成「AI 自己写需求 → 开发者照做」。
//
// 【为什么不另建表】每一次工具调用本来就进 AgentStep（tool + args 全留痕），
// 这个工具的参数就是缺口本身。汇总只要查 tool='report_capability_gap' 的步骤。
// 加表 = 两份 schema + 生产 SQL + 导出/注销/清理三处生命周期，为一条日志不值。
//
// 【它不是「摊手」的替代品】系统提示里的次序是：先看现有工具能不能组合出来 → 能靠
// 配方/技能解决的就当场做 → 都不行才上报缺口，**并且仍然要告诉用户现在手动怎么做**。

const reportCapabilityGap: AgentTool = {
  name: 'report_capability_gap',
  label: '记下做不到的事',
  action: 'content.view',
  write: false,
  def: {
    name: 'report_capability_gap',
    description:
      '用户要做的事现有工具做不到、也没法用配方/技能拼出来时，调它把缺口记下来（会进开发待办）。' +
      '调完仍然要告诉用户：已记下，以及现在在页面上怎么手动做。不要只说抱歉。',
    parameters: {
      type: 'object',
      properties: {
        need: { type: 'string', description: '用户想做什么（一句话）' },
        missing: { type: 'string', description: '缺的是什么能力（一句话，说清是哪一步做不到）' },
        tool: { type: 'string', description: '建议的工具名，snake_case，例如 add_account' },
        params: { type: 'string', description: '建议的参数，人话即可，例如「platform + handle」' },
        manual: { type: 'string', description: '页面上现在在哪里手动做，例如「记忆与人设 → 账号管理」' },
      },
      required: ['need', 'missing'],
    },
  },
  async run(_ctx, args) {
    const gap = parseGap(args);
    if (!gap.need || !gap.missing) return { ok: false, error: 'need 与 missing 都要填：缺口说不清就补不上', summary: '缺口没记下' };
    return {
      ok: true,
      data: gap,
      summary: `已记下能力缺口：${gap.missing}${gap.tool ? `（建议工具 ${gap.tool}）` : ''}。现在请告诉用户${gap.manual ? `手动路径：${gap.manual}` : '暂时要在页面上手动做'}。`,
    };
  },
};

export const GAP_TOOLS: AgentTool[] = [reportCapabilityGap];
