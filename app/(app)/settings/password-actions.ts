'use server';

import { headers } from 'next/headers';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { assertCan } from '@/lib/edition';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from '@/lib/auth/password';
import { checkRateLimit, getClientIp, ipKey, retryHint } from '@/lib/ratelimit';

// 设/改本机登录密码（个人创作者小站，仅 appliance/private）。
// 只能给**自己**设：给别人设密码等于替他造一把进他账号的钥匙。
// 改密码要过旧密码——会话可能被借用（离开工位没锁屏），旧密码是最后一道身份复核。
const LIMIT = { limit: 10, windowMs: 600_000 };

export async function actSetPassword(oldPassword: string | null, next: string): Promise<{ ok: boolean; message?: string }> {
  try {
    assertCan('passwordLogin');
  } catch {
    return { ok: false, message: '本版本不提供密码登录' };
  }

  const h = await headers();
  const rl = await checkRateLimit(ipKey('password:set', getClientIp(h)), LIMIT);
  if (!rl.ok) return { ok: false, message: `操作过于频繁，请${retryHint(rl.resetAt)}再试` };

  if ((next ?? '').length < MIN_PASSWORD_LENGTH) {
    return { ok: false, message: `新密码至少 ${MIN_PASSWORD_LENGTH} 位` };
  }

  const s = await getSession();
  const me = await prisma.member.findUnique({ where: { id: s.memberId }, select: { passwordHash: true } });
  if (!me) return { ok: false, message: '成员不存在' };

  if (me.passwordHash) {
    // 已设过：必须先验旧的。文案不区分「没填」与「填错」——都是没过身份复核
    if (!(await verifyPassword(oldPassword ?? '', me.passwordHash))) {
      return { ok: false, message: '当前密码不对' };
    }
  }

  await prisma.member.update({
    where: { id: s.memberId },
    data: { passwordHash: await hashPassword(next) },
  });
  return { ok: true };
}
