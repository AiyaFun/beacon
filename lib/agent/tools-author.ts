import { can as editionCan } from '../edition';
import type { AgentTool } from './tool-types';
import { str } from './tool-types';
import { toolsFor, disabledTools } from './tool-config';
import { prisma } from '../db';

// ai-tools/store 反过来要 import tools.ts（查内置工具的 write/costly），而 tools.ts 又 import 本文件——
// 静态引会成环（本仓库 tools-*.ts 之间的老坑）。运行时再 import，注册表早已就绪。
const store = () => import('./ai-tools/store');

// ── 模型给自己起草新工具（2026-09-09，Hermes 式自扩展）──────────────────────
//
// 【它补的是什么】「做不到 → 记缺口 → 开发补」那条环对**要新代码**的缺口是对的；
// 但很多缺口其实是「把现有几个工具按固定顺序拼一下」——那不该等开发，模型自己就能写。
// 这里让它写：一段在沙箱里跑的 JS，只能调它声明过的内置工具（见 ai-tools/sandbox.ts）。
//
// 【起草 ≠ 启用】起草落 draft，模型这一次用不上它；用户在技能中心看过代码点「启用」，
// 下一次执行才会出现在工具清单里。这是刻意的：自写工具带着一份可重放的工具白名单，
// 那种东西不该在没人看的情况下自己长出来（09-02 评估 Hermes 时定下的边界，这里没破）。
//
// 【SaaS 上恒关】node:vm 不是安全边界；多租户共进程不开。工具仍然在册，调了如实说不提供——
// 与本机 shell 那组一个口径。

const authorTool: AgentTool = {
  name: 'author_tool',
  label: '给自己起草一个新工具',
  action: 'content.create',
  write: true,
  // 不标 contract：起草落的是 draft，本身不改变任何一次执行能调什么——真正的合约点是
  // 技能中心里人点「启用」那一下。标了 contract 会让缺省的「直接跑完」档也停下来等确认，
  // 用户得来回点两次（起草确认一次、启用一次），而第一次确认的东西什么都还没生效。
  contract: false,
  def: {
    name: 'author_tool',
    description:
      '用现有内置工具拼一个新工具（一段 JS：async function main(args, sdk)，sdk.tools.call(name, args) 只能调 uses 里声明的工具）。' +
      '适合「同一串做法要反复用」或「现有工具能拼出来但每次都要拼」的情况；需要新代码的缺口用 report_capability_gap。' +
      '起草后只是草稿，用户在技能中心启用后下次才能用——所以起草完要告诉用户去启用。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'snake_case 工具名，例如 collect_and_summarize' },
        label: { type: 'string', description: '给人看的名字，≤30 字' },
        description: { type: 'string', description: '什么时候该用它、参数怎么填，≤300 字' },
        params: { type: 'object', description: '参数的 JSON Schema（type=object）。没有参数可不传' },
        uses: { type: 'array', items: { type: 'string' }, description: '它会调用的内置工具名列表（只能是你此刻能用的）' },
        code: { type: 'string', description: 'JS 源码。必须定义 async function main(args, sdk)，返回 { summary, data? } 或字符串。' },
      },
      required: ['name', 'label', 'description', 'uses', 'code'],
    },
  },
  async run(ctx, args) {
    if (!editionCan('aiAuthoredTools')) {
      return { ok: false, error: '这个版本不提供 AI 自写工具（只在整机版 / 私有化版开放）。做不到的事改用 report_capability_gap 记缺口。', summary: '这个版本不提供 AI 自写工具' };
    }
    const uses = Array.isArray(args.uses) ? (args.uses as unknown[]).map((u) => String(u)) : [];
    const r = await (await store()).createAiToolDraft(ctx, {
      name: str(args.name),
      label: str(args.label),
      description: str(args.description),
      params: args.params,
      uses,
      code: typeof args.code === 'string' ? args.code : '',
    });
    if (!r.ok) return { ok: false, error: r.error, summary: `起草失败：${r.error}` };
    return {
      ok: true,
      data: { id: r.id, name: str(args.name), status: 'draft' },
      summary: `已起草工具「${str(args.label)}」（${str(args.name)}），状态是草稿。**这一次还用不上它**：请告诉用户到「技能 · 连接器 → AI 自写的工具」看一眼代码并启用，之后再派同类任务就能直接调。`,
    };
  },
};

const listAiToolsTool: AgentTool = {
  name: 'list_ai_tools',
  label: '查自写的工具',
  action: 'content.view',
  write: false,
  def: {
    name: 'list_ai_tools',
    description: '列出这个工作区里 AI 自写的工具及其状态（draft 等启用 / enabled 可用 / disabled 已停用）和最近一次失败原因。想改一个已有的自写工具时先看这个。',
    parameters: { type: 'object', properties: {} },
  },
  async run(ctx) {
    if (!editionCan('aiAuthoredTools')) return { ok: true, data: [], summary: '这个版本不提供 AI 自写工具' };
    const rows = await (await store()).listAiTools(ctx.workspaceId);
    const allowed = new Set(toolsFor(ctx.role, disabledTools((await prisma.workspace.findUnique({ where: { id: ctx.workspaceId }, select: { agentToolConfig: true } }))?.agentToolConfig)).map((t) => t.name));
    const data = rows.map((r) => ({
      id: r.id, name: r.name, label: r.label, status: r.status, uses: JSON.parse(r.uses) as string[], usedCount: r.usedCount, lastError: r.lastError,
      // 起草后内置工具被关掉了的话，这个自写工具会在运行时失败——先提醒
      unavailableUses: (JSON.parse(r.uses) as string[]).filter((u) => !allowed.has(u)),
    }));
    return {
      ok: true,
      data,
      summary: rows.length
        ? rows.map((r) => `${r.name}（${r.label}）：${r.status}${r.lastError ? `，最近失败：${r.lastError.slice(0, 60)}` : ''}`).join('；')
        : '还没有自写的工具',
    };
  },
};

export const AUTHOR_TOOLS: AgentTool[] = [authorTool, listAiToolsTool];
