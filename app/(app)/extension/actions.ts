'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { requireRole } from '@/lib/rbac';
import { assertNotDemo } from '@/lib/demo/guard';
import { toolByName } from '@/lib/agent/tools';
import { writeToolConfig } from '@/lib/agent/tool-config';
import { cancelBrowserTask } from '@/lib/browser-task';

// 「AI 插件」开关：控制 AI 助手执行模式能调用系统里的哪些能力。
//
// 权限用 byok.manage 而不是 content.create：关掉一个能力影响的是**整个工作区**的 AI 行为
//（别人发起的执行也受影响），这是工作区级配置，与自动化开关/模型接入同一档
//（见 app/(app)/settings/automation-actions.ts 的同款口径）。

export async function actToggleAgentTool(name: string, enabled: boolean) {
  const s = await getSession();
  requireRole(s, 'byok.manage');
  assertNotDemo(s.tenantId);

  // 名字必须是真工具：不校验的话前端传什么都会被写进配置，
  // 攒出一堆指向不存在工具的死键，之后没人敢清
  if (!toolByName(name)) return { ok: false as const, error: `没有名为 ${name} 的能力` };

  const ws = await prisma.workspace.findUnique({
    where: { id: s.workspaceId },
    select: { agentToolConfig: true },
  });
  await prisma.workspace.update({
    where: { id: s.workspaceId },
    data: { agentToolConfig: writeToolConfig(ws?.agentToolConfig, name, enabled) },
  });

  // 助手页的能力清单直接读这个配置，不 revalidate 的话用户切过去还是旧的
  revalidatePath('/extension')
  // 能力清单 2026-08-26 搬到了 /skills?view=abilities —— 不加这条，
  // 开关点了切页回来还是旧状态（「开关点了没反应」的经典形状）
  revalidatePath('/skills');
  revalidatePath('/assistant');
  return { ok: true as const };
}

// 取消一个还没被插件领走的活。
//
// 权限用 content.create 而不是 byok.manage：这是「我不想让它采了」这种日常操作，
// 跟改整个工作区的 AI 能力开关不是一档。
export async function actCancelBrowserTask(taskId: string) {
  const s = await getSession();
  requireRole(s, 'content.create');
  assertNotDemo(s.tenantId);
  const r = await cancelBrowserTask(s.workspaceId, taskId);
  revalidatePath('/extension');
  revalidatePath('/runs');
  return r;
}

/**
 * 「让插件替我打开网页并读正文」的开关。
 *
 * 与上面那些能力开关同一档权限（byok.manage）：它同样是**工作区级**的配置，
 * 影响的是这个工作区里每一次 AI 执行，而不只是操作者自己那一次。
 *
 * 单独一个 action 而不是塞进 agentToolConfig，是因为语义不同：
 * 那张表里的开关缺省全开（「默认能用，你可以关」），这一个缺省是关的
 *（「默认不能用，你得知道自己在开什么」）。混在一起迟早有人把默认值搞反。
 */
export async function actSetBrowserRead(enabled: boolean) {
  const s = await getSession();
  requireRole(s, 'byok.manage');
  assertNotDemo(s.tenantId);

  await prisma.workspace.update({
    where: { id: s.workspaceId },
    data: { browserReadEnabled: enabled },
  });
  revalidatePath('/extension')
  // 能力清单 2026-08-26 搬到了 /skills?view=abilities —— 不加这条，
  // 开关点了切页回来还是旧状态（「开关点了没反应」的经典形状）
  revalidatePath('/skills');
  return { ok: true as const };
}
