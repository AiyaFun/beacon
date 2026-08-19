'use server';

import { cookies, headers } from 'next/headers';
import { AUTH_COOKIE, createSession, requestLoginCode, verifyLoginCode } from '@/lib/auth';
import { AUTH_COOKIE_MAX_AGE_S, authCookieSecure } from '@/lib/auth-constants';
import { checkRateLimit, getClientIp, ipKey, retryHint } from '@/lib/ratelimit';
import { getSmsProvider } from '@/lib/sms/provider';
import { isProd } from '@/lib/env';
import { ensureDemoTenant } from '@/lib/demo/seed';

// 游客登录闸门：同 IP 每小时 20 次（演示会话很轻，但仍要挡刷）
const GUEST_LIMIT = { limit: 20, windowMs: 3600_000 };
const GUEST_TTL_MS = 24 * 3600 * 1000; // 演示会话 1 天

// 发码闸门：同 IP 每小时 10 条。lib/auth.ts 里的 60s/手机号冷却挡不住「换号刷」——
// 攻击者轮换手机号即可无限触发真实短信（火山引擎通道按条计费）。IP 维度才是那道闸。
const SEND_CODE_LIMIT = { limit: 10, windowMs: 3600_000 };
// 校验闸门：同 IP 每 10 分钟 20 次。单条码有 5 次尝试上限，但换码可以重来；
// 20 次相对 6 位码的 1e6 空间可忽略，正常用户（含手滑重输）也够用。
const VERIFY_LIMIT = { limit: 20, windowMs: 600_000 };

// Mock 短信通道下放开发码闸门。**这不是后门**，理由链条如下，改前请读完：
// 1. 上面那道闸的理由是「真实短信按条计费」。Mock 通道不发短信、不花钱，理由不成立。
// 2. dev 机上 localhost 的全部流量塌缩成同一个 IP key，10 条就把自己锁 1 小时；
//    而 seed 不建账号、登录是进系统的唯一入口 → 开发者被自己的限流锁死在门外，
//    违反「dev 零基础设施可跑」这条项目核心约定。
// 3. 生产态取不到 Mock 通道：lib/sms/provider.ts 的工厂在 isProd() 且未配 vendor 时直接 throw，
//    即生产态 mocked 恒为 false → 本逃生口在生产自动失效，闸门照常生效。
// 4. 仍额外前置 isProd()：不依赖单一防线（且短路后生产态不会因取通道抛错而漏掉限流）。
function smsIsFree(): boolean {
  return !isProd() && getSmsProvider().mocked;
}

export async function actRequestCode(phone: string) {
  if (!smsIsFree()) {
    const ip = getClientIp(await headers());
    const rl = await checkRateLimit(ipKey('login:send', ip), SEND_CODE_LIMIT);
    if (!rl.ok) {
      // 不回显计数/阈值，避免给刷子反馈信号
      return { ok: false, message: `操作过于频繁，请${retryHint(rl.resetAt)}再试` };
    }
  }
  return requestLoginCode(phone.trim());
}

export async function actVerifyCode(phone: string, code: string, inviteToken?: string, consent?: boolean) {
  const h = await headers();
  const ip = getClientIp(h);
  const rl = await checkRateLimit(ipKey('login:verify', ip), VERIFY_LIMIT);
  if (!rl.ok) {
    return { ok: false, message: `验证尝试过于频繁，请${retryHint(rl.resetAt)}再试` };
  }
  const ua = h.get('user-agent') ?? undefined;
  const r = await verifyLoginCode(phone.trim(), code.trim(), ua, inviteToken?.trim() || undefined, consent);
  if (r.ok && r.token) {
    const store = await cookies();
    store.set(AUTH_COOKIE, r.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: authCookieSecure(),
      path: '/',
      maxAge: AUTH_COOKIE_MAX_AGE_S,
    });
  }
  return { ok: r.ok, message: r.message };
}

// 游客访问：进入只读演示租户（viewer 角色 + 固定 DEMO_TENANT_ID，写/生成/下单全被挡）。
// 首次会懒种一份跨模块假数据；之后快路径复用。演示会话短 TTL（1 天）。
export async function actGuestLogin() {
  const h = await headers();
  const ip = getClientIp(h);
  const rl = await checkRateLimit(ipKey('login:guest', ip), GUEST_LIMIT);
  if (!rl.ok) return { ok: false, message: `操作过于频繁，请${retryHint(rl.resetAt)}再试` };

  const { memberId } = await ensureDemoTenant();
  const token = await createSession(memberId, h.get('user-agent') ?? undefined, GUEST_TTL_MS);
  const store = await cookies();
  store.set(AUTH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: authCookieSecure(),
    path: '/',
    maxAge: GUEST_TTL_MS / 1000,
  });
  return { ok: true as const };
}
