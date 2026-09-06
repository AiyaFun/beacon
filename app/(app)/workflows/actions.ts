'use server';

import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { requireRole, RbacError } from '@/lib/rbac';
import { QuotaExceededError } from '@/lib/quota';
import { DemoReadonlyError } from '@/lib/demo/guard';
import {
  installTemplate,
  uninstallTemplate,
  createTemplate,
  deleteTemplate,
  exportTemplate,
  importTemplate,
  setTemplatePersona,
} from '@/lib/workflow/market';
import { createWorkflowRun, readWorkflowRun, type WorkflowRunView } from '@/lib/workflow/run';
import { enableRoutine } from '@/lib/workflow/routines';
import { ledgerSet, clearSeen } from '@/lib/agent/ledger';
import { prisma } from '@/lib/db';
import { kickWorkflowRun } from '@/lib/workflow/kick';

function designed(e: unknown): string | null {
  if (e instanceof QuotaExceededError || e instanceof RbacError || e instanceof DemoReadonlyError) return e.message;
  return null;
}

export async function actInstallWorkflow(templateId: string) {
  const s = await getSession();
  requireRole(s, 'content.create');
  const r = await installTemplate(s.tenantId, templateId);
  revalidatePath('/workflows');
  return r;
}

/** 开一条 bot 的建议定时（装上之后页面问一次；幂等，见 lib/workflow/routines.ts） */
export async function actEnableRoutine(templateId: string, index: number): Promise<{ ok: boolean; error?: string }> {
  const s = await getSession();
  requireRole(s, 'content.create');
  const r = await enableRoutine({
    tenantId: s.tenantId, workspaceId: s.workspaceId, accountId: s.accountId, memberId: s.memberId,
    templateId, index: Number.isInteger(index) ? index : -1,
  });
  revalidatePath('/workflows');
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

// ── 台账（2026-09-05）：bot 自己记的盯单与进度，用户在卡上能看、能改、能清 ──
// 只认这个租户看得见的模板 slug：台账按工作区隔离，写到别的 slug 也只是自己工作区里多一格，
// 但界面上只该出现真实存在的 bot，所以这里还是校一次。
async function visibleSlug(tenantId: string, slug: string): Promise<boolean> {
  const n = await prisma.workflowTemplate.count({ where: { slug, enabled: true, OR: [{ isBuiltin: true }, { tenantId }] } });
  return n > 0;
}

/** 写/改一条台账；value 空 = 删 */
export async function actLedgerWrite(slug: string, key: string, value: string): Promise<{ ok: boolean; error?: string }> {
  const s = await getSession();
  requireRole(s, 'content.create');
  if (!(await visibleSlug(s.tenantId, slug))) return { ok: false, error: '这个智能体不存在' };
  const r = await ledgerSet(s.workspaceId, slug, key, value);
  revalidatePath('/workflows');
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/** 清空已见清单：下次它会把所有东西当新的再报一遍 */
export async function actLedgerClearSeen(slug: string): Promise<{ ok: boolean; error?: string; cleared?: number }> {
  const s = await getSession();
  requireRole(s, 'content.create');
  if (!(await visibleSlug(s.tenantId, slug))) return { ok: false, error: '这个智能体不存在' };
  const cleared = await clearSeen(s.workspaceId, slug);
  revalidatePath('/workflows');
  return { ok: true, cleared };
}

export async function actUninstallWorkflow(templateId: string) {
  const s = await getSession();
  requireRole(s, 'content.create');
  const r = await uninstallTemplate(s.tenantId, templateId);
  revalidatePath('/workflows');
  return r;
}

// 职责说明决定「AI 会不会在对话里主动派这个智能体」，所以它是内容级配置而非只读展示
export async function actSetWorkflowPersona(templateId: string, persona: string) {
  const s = await getSession();
  requireRole(s, 'content.create');
  const r = await setTemplatePersona(s.tenantId, templateId, persona);
  revalidatePath('/workflows');
  return r;
}

export async function actCreateWorkflow(input: { name: string; description?: string; emoji?: string; persona?: string; steps: unknown; requires?: string; mode?: string; agentConfig?: unknown }) {
  const s = await getSession();
  requireRole(s, 'content.create');
  const r = await createTemplate(s.tenantId, s.memberId, input);
  revalidatePath('/workflows');
  return r;
}

export async function actDeleteWorkflow(templateId: string) {
  const s = await getSession();
  requireRole(s, 'content.create');
  const r = await deleteTemplate(s.tenantId, templateId);
  revalidatePath('/workflows');
  return r;
}

export async function actExportWorkflow(templateId: string): Promise<{ ok: boolean; json?: string; error?: string }> {
  const s = await getSession();
  const json = await exportTemplate(s.tenantId, templateId);
  return json ? { ok: true, json } : { ok: false, error: '模板不存在' };
}

export async function actImportWorkflow(json: string) {
  const s = await getSession();
  requireRole(s, 'content.create');
  const r = await importTemplate(s.tenantId, s.memberId, json);
  revalidatePath('/workflows');
  return r;
}

export type RunResult = { ok: boolean; run?: WorkflowRunView; error?: string };

/**
 * 派一条模板去跑：建行 → 后台 kick → **立刻返回 runId**，前端拿它轮询实时进度。
 *
 * 【为什么绝不能同步跑完再返回】Next 15 的 server action 在途时会把同一客户端的
 * 后续导航与其它 action 全部排队——一条要跑几分钟的工作流挂在 action 里，
 * 用户点完「跑一遍」整个站点都点不动：跳不了页、装/卸技能的按钮全部灰着。
 * 「看到卡在哪一步」由 executeWorkflowRun 每步落库 + 前端轮询 actReadWorkflowRun 提供，
 * 比跑完才回一次的旧样子更实时。
 */
export async function actStartWorkflow(templateId: string, draftId?: string): Promise<{ ok: boolean; runId?: string; error?: string }> {
  try {
    const s = await getSession();
    requireRole(s, 'content.create');
    const ctx = { tenantId: s.tenantId, workspaceId: s.workspaceId, accountId: s.accountId, memberId: s.memberId, draftId };
    const runId = await createWorkflowRun(ctx, templateId);
    kickWorkflowRun(ctx, runId);
    return { ok: true, runId };
  } catch (e) {
    const msg = designed(e);
    return { ok: false, error: msg ?? (e as Error).message.slice(0, 300) };
  }
}

export async function actReadWorkflowRun(runId: string): Promise<RunResult> {
  const s = await getSession();
  const run = await readWorkflowRun(s.workspaceId, runId);
  return run ? { ok: true, run } : { ok: false, error: '运行记录不存在' };
}
