'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AUTH_COOKIE } from '@/lib/auth';
import { getSession } from '@/lib/session';
import { assertNotDemo } from '@/lib/demo/guard';
import { checkRateLimit, getClientIp, ipKey, retryHint } from '@/lib/ratelimit';
import { DELETE_CONFIRM_TEXT, executeAccountDeletion, planAccountDeletion } from '@/lib/account/delete';
import type { InventoryRow } from '@/lib/account/inventory';

// 账号注销（F9-8）。导出走 GET 路由（app/api/account/export），不在这里——
// 几 MB 的 JSON 从 server action 走 RSC 流回来要先 base64 再在浏览器里解，纯属绕远路。

export type DeletionPreview = {
  scope: 'tenant' | 'member';
  inventory: InventoryRow[];
  otherMembers: { id: string; name: string; role: string }[];
  blocked: string | null;
  plan: string;
  paidUntil: string | null;
};

/**
 * 注销前的数据清单。**按需拉取**而不是随设置页一起渲染：它要跑近三十次 count，
 * 挂在页面上等于每次打开「账号与安全」都白付一次全库统计的钱。
 */
export async function actDeletionPreview(): Promise<DeletionPreview> {
  const s = await getSession();
  const plan = await planAccountDeletion({ memberId: s.memberId, tenantId: s.tenantId, role: s.role });
  return {
    scope: plan.scope,
    inventory: plan.inventory,
    otherMembers: plan.otherMembers,
    blocked: plan.blocked,
    plan: plan.plan,
    paidUntil: plan.paidUntil ? plan.paidUntil.toISOString().slice(0, 10) : null,
  };
}

/**
 * 执行注销。成功即 redirect 到登录页——不返回值，因为此刻调用方所在的租户已经不存在了，
 * 任何 revalidate/重渲都会打到一个查不到会话的页面上。
 */
export async function actDeleteAccount(confirmText: string): Promise<{ ok: false; error: string }> {
  const s = await getSession();
  assertNotDemo(s.tenantId);

  if (String(confirmText ?? '').trim() !== DELETE_CONFIRM_TEXT) {
    return { ok: false, error: `请逐字输入「${DELETE_CONFIRM_TEXT}」以确认` };
  }

  // 限流：注销不可撤销。拿到会话 cookie 的人若能无限次调用，一次就能把租户清空——
  // 二次确认拦得住手滑，拦不住脚本，这道闸拦的是后者。
  const ip = getClientIp(await headers());
  const rl = await checkRateLimit(ipKey('account:delete', ip), { limit: 5, windowMs: 3600_000 });
  if (!rl.ok) return { ok: false, error: `操作过于频繁，请${retryHint(rl.resetAt)}再试` };

  const r = await executeAccountDeletion({ memberId: s.memberId, tenantId: s.tenantId, role: s.role });
  if (!r.ok) return { ok: false, error: r.error };

  // 会话行已随成员/租户级联删除；cookie 也抹掉，否则用户会带着一个指向不存在会话的 cookie
  // 在 middleware（只看 cookie 在不在）与 getSession（查库）之间来回弹。
  (await cookies()).delete(AUTH_COOKIE);
  redirect(`/login?bye=${r.scope}`);
}
