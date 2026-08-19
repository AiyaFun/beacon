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
} from '@/lib/workflow/market';
import { runWorkflow, readWorkflowRun, type WorkflowRunView } from '@/lib/workflow/run';

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

export async function actUninstallWorkflow(templateId: string) {
  const s = await getSession();
  requireRole(s, 'content.create');
  const r = await uninstallTemplate(s.tenantId, templateId);
  revalidatePath('/workflows');
  return r;
}

export async function actCreateWorkflow(input: { name: string; description?: string; emoji?: string; steps: unknown }) {
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
 * 跑一条模板。**同步跑完再返回**：步骤之间有强依赖（没初稿就没封面），
 * 拆成后台任务反而让用户看不到「卡在哪一步」。步数上限 10（lib/workflow/steps.ts）保证它不会跑太久。
 */
export async function actRunWorkflow(templateId: string, draftId?: string): Promise<RunResult> {
  try {
    const s = await getSession();
    requireRole(s, 'content.create');
    const run = await runWorkflow(
      { tenantId: s.tenantId, workspaceId: s.workspaceId, accountId: s.accountId, memberId: s.memberId, draftId },
      templateId,
    );
    revalidatePath('/studio');
    revalidatePath('/workflows');
    return { ok: true, run };
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
