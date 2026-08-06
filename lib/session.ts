import { cookies } from 'next/headers';
import { AUTH_COOKIE, getMemberByToken } from './auth';
import { ACCOUNT_COOKIE } from './auth-constants';
import { withTenant, type TxClient } from './tenant-rls';

// 会话上下文：由登录 cookie 解析。生产 Postgres 层再叠加 RLS 行级隔离兜底。

export type SessionContext = {
  memberId: string;
  tenantId: string;
  workspaceId: string;
  accountId: string;
  memberName: string;
  role: string; // owner | admin | editor | viewer；配合 lib/rbac.ts 的 can()/requireRole()
  plan: string;
};

// 已登录才返回上下文；未登录抛错（页面由 middleware 拦到 /login，此处是兜底）
export async function getSession(): Promise<SessionContext> {
  const store = await cookies();
  const token = store.get(AUTH_COOKIE)?.value;
  const preferredAccountId = store.get(ACCOUNT_COOKIE)?.value;
  const member = await getMemberByToken(token, preferredAccountId);
  if (!member) {
    throw new Error('未登录');
  }
  return {
    memberId: member.memberId,
    tenantId: member.tenantId,
    workspaceId: member.workspaceId,
    accountId: member.accountId,
    memberName: member.memberName,
    role: member.role,
    plan: member.plan,
  };
}

// 可空版本：用于可能未登录的场景（如 Topbar 容错）
export async function getSessionOrNull(): Promise<SessionContext | null> {
  try {
    return await getSession();
  } catch {
    return null;
  }
}

// 会话 + RLS：读 cookie → 设 app.current_tenant → 在同一事务内执行 fn。
// 策略是「app_current_tenant() IS NULL 就放行」，所以**只有走这里的查询才真正受行级隔离约束**。
//
// 迁移口径（2026-07-30 定；别再问「为什么不全量迁」）：
//   ✅ 该走 withSession —— 「按用户传进来的 id 查归属 → 改/删」这类**短事务、纯 DB** 的写操作。
//      它们正是 IDOR 的着力点，也是漏写一个 where 就会跨租户的地方，值得让数据库再兜一层。
//   ❌ 不许走 withSession —— 事务里有 LLM 调用、外部 HTTP、嵌入计算、文件抓取的动作。
//      Prisma 的交互式事务会**独占一条连接**，把一次几十秒的模型调用圈进去，
//      连接池会在并发面前直接见底；这比「少一层兜底」危险得多。
//      这类动作维持 getSession() + 应用层 where（照样有测试覆盖），
//      需要事务时只把**写库那一小段**包进来。
//
// 也就是说：未迁移 ≠ 无防护，而是「这一段的隔离由应用层负责」。
// tests/rls/session-scoped.test.ts 钉死已迁移的那批不许退回去。
export async function withSession<T>(fn: (session: SessionContext, tx: TxClient) => Promise<T>): Promise<T> {
  const session = await getSession();
  return withTenant(session.tenantId, (tx) => fn(session, tx));
}
