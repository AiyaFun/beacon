'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { requireRole } from '@/lib/rbac';
import { sanitizeAutomationConfig } from '@/lib/jobs/automation';
import { scanAndGenerateReviews, scanWeeklyReviews } from '@/lib/insight/review';
import { generateRecommendations } from '@/lib/pipeline';
import { optimizeWorkspaceMemory } from '@/lib/memory/optimize';

// 自动化任务中心：按工作区开关 + 立即运行（本工作区范围，不动其它租户）。

export async function actSetAutomation(patch: Record<string, boolean>) {
  const s = await getSession();
  requireRole(s, 'byok.manage'); // 工作区级配置，与模型接入同权限
  const ws = await prisma.workspace.findUnique({ where: { id: s.workspaceId }, select: { automationConfig: true } });
  const merged = sanitizeAutomationConfig(ws?.automationConfig, patch);
  await prisma.workspace.update({ where: { id: s.workspaceId }, data: { automationConfig: JSON.stringify(merged) } });
  revalidatePath('/settings');
  return { ok: true as const, config: merged };
}

// 立即运行（仅本工作区范围；backfill 是里程碑驱动，不提供手动运行）
export async function actRunJobNow(job: string): Promise<{ ok: boolean; detail?: string; error?: string }> {
  const s = await getSession();
  requireRole(s, 'byok.manage');
  try {
    if (job === 'daily_recommend') {
      const r = await generateRecommendations(s.accountId, s.workspaceId);
      revalidatePath('/settings');
      revalidatePath('/topics');
      return { ok: true, detail: `已为当前账号生成 ${r.created} 条推荐` };
    }
    if (job === 'generate_reviews') {
      const r = await scanAndGenerateReviews({ workspaceId: s.workspaceId });
      revalidatePath('/settings');
      revalidatePath('/data');
      return { ok: true, detail: `扫描 ${r.scanned} 条，生成 ${r.generated} 篇复盘（跳过 ${r.skipped}）` };
    }
    if (job === 'weekly_review') {
      const r = await scanWeeklyReviews({ workspaceId: s.workspaceId });
      revalidatePath('/settings');
      revalidatePath('/data');
      return { ok: true, detail: `${r.accounts} 个账号，生成 ${r.generated} 份周报` };
    }
    if (job === 'optimize_memory') {
      const r = await optimizeWorkspaceMemory(s.workspaceId);
      revalidatePath('/settings');
      revalidatePath('/persona');
      return { ok: true, detail: r.summaryText || '记忆已优化一遍' };
    }
    return { ok: false, error: '该任务由系统按里程碑自动执行，不支持手动运行' };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 140) };
  }
}
