'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { requireRole } from '@/lib/rbac';
import { assertNotDemo } from '@/lib/demo/guard';
import { runWorkflow } from '@/lib/workflow/run';
import { cancelBrowserTask } from '@/lib/browser-task';

// 运行中心的动作层。
//
// 【为什么这一页需要动作】在此之前 /runs 是纯回看：一条失败的工作流摆在那里，
// 用户唯一能做的是记住它、走到「智能体」页、找到那个模板、再点一次跑。
// 「等你处理」那一栏的名字承诺了可以处理，而这一页什么都处理不了。
//
// 【加什么、不加什么】只加**在这一页做最顺手**的两件：
//   · 重跑一条失败的工作流——原地重来，不用去别的页面找模板；
//   · 取消一条还没被浏览器领走的活——它本来就只在这一页和采集助手页可见。
// 确认写操作**刻意不放在这里**：确认必须只给发起人，而这一页是工作区级、
// 刻意不按人过滤的（同事看得到你的运行）。在这里渲染确认按钮，
// 要么给同事渲一张点了必报错的卡，要么就得绕开那条安全口径。它留在助手页。

export async function actRerunWorkflow(runId: string) {
  const s = await getSession();
  requireRole(s, 'content.create');
  assertNotDemo(s.tenantId);

  // 带 workspaceId 查：不带的话拿到别人的 runId 就能用自己的额度重跑别人的模板
  const run = await prisma.workflowRun.findFirst({
    where: { id: runId, workspaceId: s.workspaceId },
    select: { templateId: true, accountId: true, draftId: true, status: true },
  });
  if (!run) return { ok: false as const, error: '这条记录不存在' };
  if (run.status === 'running') return { ok: false as const, error: '这条还在跑，等它结束再说' };

  try {
    // 重跑是**新开一次**，不是接着上次跑：工作流没有断点续跑，
    // 从中间接上会在一个说不清的状态上继续花钱
    const view = await runWorkflow(
      {
        tenantId: s.tenantId,
        workspaceId: s.workspaceId,
        // 按原来那次的账号跑，不是按「当前账号」——用户可能已经切过号了，
        // 那样重跑出来的东西会挂到另一个号名下
        accountId: run.accountId,
        memberId: s.memberId,
        draftId: run.draftId,
        trigger: 'manual',
      },
      run.templateId,
    );
    revalidatePath('/runs');
    return view.status === 'failed'
      ? { ok: false as const, error: `又停在第 ${view.logs.length} 步：${view.logs.find((l) => !l.ok)?.message ?? '未知原因'}` }
      : { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message.slice(0, 200) };
  }
}

export async function actCancelBrowserTask(taskId: string) {
  const s = await getSession();
  requireRole(s, 'content.create');
  assertNotDemo(s.tenantId);

  const r = await cancelBrowserTask(s.workspaceId, taskId);
  revalidatePath('/runs');
  return r.ok ? { ok: true as const } : { ok: false as const, error: r.error ?? '取消不了' };
}
