import { prisma } from '../../db';
import { can as editionCan } from '../../edition';
import { can as rbacCan } from '../../rbac';
import { toolsFor, disabledTools } from '../tool-config';
import { toolByName } from '../tools';
import type { AgentTool, ToolContext, ToolResult } from '../tool-types';
import { compileAiTool, runAiTool, type AiToolRow } from './sandbox';

// ── AI 自写工具：落库、校验、变成 AgentTool ──────────────────────────────────
//
// 【三条硬规矩】
//   ① uses 必须是这个角色此刻**能用的静态工具**的子集——模型不能靠自写工具绕开角色/开关，
//      也不能套娃（自写工具不能 uses 另一个自写工具，否则一次调用的深度没边）；
//   ② write / costly / contract 由 uses 的并集推出，不由模型自报——授权卡按这三样分组，
//      模型说「我这个工具只读」不算数；
//   ③ 起草只落 draft；变 enabled 的那一下只能来自页面上的人（setAiToolStatus 由 server action 调，
//      工具层没有任何路径能把状态改成 enabled）。

export const AI_TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,40}$/;
export const AI_TOOL_MAX_PER_WORKSPACE = 30;

export type AiToolDraftInput = {
  name: string;
  label: string;
  description: string;
  params?: unknown;
  uses: string[];
  code: string;
};

export type AiToolFlags = { write: boolean; costly: boolean; contract: boolean };

/** 由 uses 推出三个授权标记。 */
export function flagsFromUses(uses: readonly string[]): AiToolFlags {
  const f: AiToolFlags = { write: false, costly: false, contract: false };
  for (const n of uses) {
    const t = toolByName(n);
    if (!t) continue;
    if (t.write) f.write = true;
    if (t.costly) f.costly = true;
    if (t.contract) f.contract = true;
  }
  return f;
}

/**
 * 把模型给的 params 收成一个 type=object 的 JSON Schema。
 * 真机（MiniMax）会直接给 `{ limit: { type: 'number', … } }`——只给了 properties 那一层——
 * 也可能给一段 JSON 字符串。这两种都是「意思对了、壳没包对」，包一层就行；
 * 认不出形状（值不是带 type 的对象）才报错。
 */
export function normalizeParams(raw: unknown): { ok: true; schema: Record<string, unknown> } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, schema: { type: 'object', properties: {} } };
  let v: unknown = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return { ok: false, error: 'params 不是合法 JSON' }; }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'params 要是一个 type=object 的 JSON Schema' };
  const o = v as Record<string, unknown>;
  if (o.type === 'object') return { ok: true, schema: o };
  const looksLikeProps = Object.values(o).every((x) => x && typeof x === 'object' && typeof (x as { type?: unknown }).type === 'string');
  if (Object.keys(o).length > 0 && looksLikeProps) return { ok: true, schema: { type: 'object', properties: o } };
  return { ok: false, error: 'params 要是一个 type=object 的 JSON Schema（或者直接给 properties 那一层）' };
}

/** 起草前校验。返回错误串；null = 通过。 */
export function validateDraft(input: AiToolDraftInput, allowedStatic: readonly string[]): string | null {
  if (!AI_TOOL_NAME_RE.test(input.name)) return 'name 要是 3–41 位的 snake_case（小写字母开头，只含小写字母/数字/下划线）';
  if (toolByName(input.name)) return `${input.name} 是内置工具的名字，换一个`;
  if (!input.label.trim() || input.label.length > 30) return 'label 要有，且不超过 30 字';
  if (!input.description.trim() || input.description.length > 300) return 'description 要有，且不超过 300 字';
  if (!Array.isArray(input.uses) || input.uses.length === 0) return 'uses 至少声明一个要用的内置工具';
  const allowed = new Set(allowedStatic);
  const bad = input.uses.filter((u) => !allowed.has(u));
  if (bad.length) return `uses 里这些不是你此刻能用的内置工具：${bad.join('、')}`;
  const np = normalizeParams(input.params);
  if (!np.ok) return np.error;
  const c = compileAiTool(input.code);
  if (!c.ok) return c.error;
  return null;
}

export async function createAiToolDraft(ctx: ToolContext, input: AiToolDraftInput): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!editionCan('aiAuthoredTools')) return { ok: false, error: '这个版本不提供 AI 自写工具（只在整机版 / 私有化版开放）' };
  const allowed = toolsFor(ctx.role, await workspaceDisabled(ctx.workspaceId)).map((t) => t.name);
  const err = validateDraft(input, allowed);
  if (err) return { ok: false, error: err };
  const count = await prisma.agentToolDef.count({ where: { workspaceId: ctx.workspaceId } });
  if (count >= AI_TOOL_MAX_PER_WORKSPACE) return { ok: false, error: `一个工作区最多 ${AI_TOOL_MAX_PER_WORKSPACE} 个自写工具，先去技能中心删掉不用的` };
  const dup = await prisma.agentToolDef.findUnique({ where: { workspaceId_name: { workspaceId: ctx.workspaceId, name: input.name } }, select: { id: true } });
  if (dup) return { ok: false, error: `已经有叫 ${input.name} 的工具了，换个名字或先删掉旧的` };
  const flags = flagsFromUses(input.uses);
  const row = await prisma.agentToolDef.create({
    data: {
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      name: input.name,
      label: input.label.trim(),
      description: input.description.trim(),
      params: JSON.stringify((normalizeParams(input.params) as { schema: Record<string, unknown> }).schema),
      uses: JSON.stringify(input.uses),
      code: input.code,
      status: 'draft',
      ...flags,
      authoredByRunId: ctx.runId ?? null,
      createdBy: ctx.memberId,
    },
    select: { id: true },
  });
  return { ok: true, id: row.id };
}

export type AiToolStatus = 'draft' | 'enabled' | 'disabled';

/** 只给页面上的人调（server action）。工具层没有任何路径能走到这里。 */
export async function setAiToolStatus(workspaceId: string, id: string, status: AiToolStatus): Promise<boolean> {
  if (!editionCan('aiAuthoredTools') && status === 'enabled') return false;
  const r = await prisma.agentToolDef.updateMany({ where: { id, workspaceId }, data: { status } });
  return r.count > 0;
}

export async function deleteAiTool(workspaceId: string, id: string): Promise<boolean> {
  const r = await prisma.agentToolDef.deleteMany({ where: { id, workspaceId } });
  return r.count > 0;
}

export async function listAiTools(workspaceId: string) {
  return prisma.agentToolDef.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' } });
}

async function workspaceDisabled(workspaceId: string): Promise<string[]> {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { agentToolConfig: true } });
  return disabledTools(ws?.agentToolConfig);
}

/**
 * 把一条 enabled 的自写工具包成 AgentTool，塞进这次运行的工具清单。
 * 沙箱里的 sdk.tools.call 走这里的 subcall：白名单（uses）、角色权限、工作区开关三道都再查一遍——
 * 起草时查过不算数，执行时的判定才算（与 executeCall 同一口径）。
 */
export function toAgentTool(row: AiToolRow & { description: string; write: boolean; costly: boolean; contract: boolean }, ctx: ToolContext): AgentTool {
  let params: Record<string, unknown> = { type: 'object', properties: {} };
  try { params = JSON.parse(row.params) as Record<string, unknown>; } catch { /* 坏 JSON 当无参数 */ }
  return {
    name: row.name,
    label: `${row.label}（AI 自写）`,
    action: row.write ? 'content.create' : 'content.view',
    write: row.write,
    costly: row.costly,
    contract: row.contract,
    def: { name: row.name, description: row.description, parameters: params as never },
    async run(runCtx, args): Promise<ToolResult> {
      if (!editionCan('aiAuthoredTools')) return { ok: false, error: '这个版本不提供 AI 自写工具', summary: '未执行' };
      const disabled = new Set(await workspaceDisabled(runCtx.workspaceId));
      const subcall = async (name: string, a: Record<string, unknown>): Promise<ToolResult> => {
        const t = toolByName(name);
        if (!t) return { ok: false, error: `没有名为 ${name} 的内置工具`, summary: '未执行' };
        if (disabled.has(name)) return { ok: false, error: `${name} 已被工作区关掉`, summary: '未执行' };
        if (!rbacCan(runCtx.role, t.action)) return { ok: false, error: '发起人的角色没有这个权限', summary: '未执行' };
        return t.run(runCtx, a);
      };
      const r = await runAiTool(row, runCtx, args, subcall);
      // 用量与最近一次失败原因记回去，审核的人和模型自己都看得到
      await prisma.agentToolDef.updateMany({
        where: { id: row.id },
        data: r.ok ? { usedCount: { increment: 1 }, lastError: null } : { lastError: r.error?.slice(0, 500) ?? '未知错误' },
      }).catch(() => {});
      const logs = r.logs.length ? `\n日志：\n${r.logs.join('\n')}` : '';
      return { ok: r.ok, data: r.data, error: r.error, summary: r.summary + logs };
    },
  };
}

/** 这次运行能用的自写工具（enabled 的）。形态不支持时恒为空。 */
export async function aiToolsForRun(ctx: ToolContext): Promise<AgentTool[]> {
  if (!editionCan('aiAuthoredTools')) return [];
  const rows = await prisma.agentToolDef.findMany({ where: { workspaceId: ctx.workspaceId, status: 'enabled' } });
  return rows.map((r) => toAgentTool(r, ctx));
}
