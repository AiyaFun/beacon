'use server';

import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/session';
import { assertNotDemo } from '@/lib/demo/guard';
import { issueApiToken, revokeApiToken, apiEnabled } from '@/lib/api/token';

// 对外调用令牌的签发与收回。
//
// 【权限：不用 requireRole】这枚令牌代表的就是**操作者自己**，用的也是他自己的角色。
// 一个 viewer 签一枚出来，那枚令牌也只有 viewer 的权限——没有越权空间，
// 所以不该额外要求「管理员才能签」。他能在网页上做的事，就是这枚令牌能做的事。

export async function actIssueApiToken(label: string) {
  const s = await getSession();
  if (!apiEnabled()) {
    return { ok: false as const, error: 'SaaS 版不提供对外调用令牌（这条能力是给本机部署的）' };
  }
  assertNotDemo(s.tenantId);

  const r = await issueApiToken(s.memberId, label);
  revalidatePath('/settings/account');
  // 明文**只在这一次返回**：能再看就意味着它随时可读，
  // 那么任何一次会话劫持都等于拿到了长期凭证
  return { ok: true as const, token: r.token, label: r.label };
}

export async function actRevokeApiToken(id: string) {
  const s = await getSession();
  assertNotDemo(s.tenantId);
  const ok = await revokeApiToken(s.memberId, id);
  revalidatePath('/settings/account');
  return { ok };
}
