import { prisma } from './db';
import { provisionNewUser } from './auth';
import { effectivePlan } from './pay/plan';
import type { SessionContext } from './session';

// 脚本/CLI 专用会话解析（不依赖 cookie）：取第一个工作区。仅供 scripts/ 与 seed 使用。
//
// 库里没有工作区时**自动开通一个**，而不是报错。
// 原实现抛「请先运行 npm run db:seed」—— 这句话在 seed 改成「不建任何演示数据」之后就成了错误引导：
// seed 刚跑完也不会有工作区（设计如此：登录即开通干净空账号）。结果是照文档
// `npm run setup && npx tsx scripts/verify-flows.ts` 必崩，而只有手工登录过的旧库才跑得通
// —— 「基线绿」从此依赖一个谁也没法从头复现的库状态。
export async function firstWorkspaceSession(): Promise<SessionContext> {
  let workspace = await findFirstWorkspace();
  if (!workspace) {
    // 走与真实登录**同一个**开通函数（lib/auth.ts:provisionNewUser），不另写一份
    await provisionNewUser('19900000000');
    workspace = await findFirstWorkspace();
  }
  if (!workspace) throw new Error('自动开通脚本态租户失败');
  const member = await prisma.member.findFirst({ orderBy: { createdAt: 'asc' } });
  return {
    memberId: member?.id ?? '',
    tenantId: workspace.tenantId,
    workspaceId: workspace.id,
    accountId: workspace.accounts[0]?.id ?? '',
    memberName: member?.name ?? '创作者',
    role: member?.role ?? 'owner', // 脚本态按 owner 跑，不被 RBAC 挡
    // 与 getSession 口径一致：DB 里的 plan 是「买过什么」，到期后要按 free 算
    plan: effectivePlan(workspace.tenant.plan, workspace.tenant.planExpiresAt),
  };
}

function findFirstWorkspace() {
  return prisma.workspace.findFirst({
    orderBy: { createdAt: 'asc' },
    include: { tenant: true, accounts: { orderBy: { createdAt: 'asc' }, take: 1 } },
  });
}
