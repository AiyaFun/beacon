import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './db';
import { isDemoTenant } from './demo/guard';
import { toJson } from './json';
import { getSmsProvider } from './sms/provider';
import { emptyPersona } from './persona';
import { AUTH_COOKIE } from './auth-constants';
import { isProd } from './env';
import { effectivePlan } from './pay/plan';
import { TRIAL_DAYS } from './pay/pricing';
import { LEGAL_VERSION } from './legal';

// 手机短信验证码鉴权 + 多租户自动开通。

export { AUTH_COOKIE };
const CODE_TTL_MS = 5 * 60 * 1000; // 验证码 5 分钟
// 会话 90 天 + 滑动续期（getMemberByToken 剩余不足一半时自动延长）：
// 日常活跃用户永不掉线，连续 90 天未访问才需重新登录。cookie 端同样滑动（middleware）。
const SESSION_TTL_MS = 90 * 24 * 3600 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000; // 同号 60s 内不可重复发
const MAX_ATTEMPTS = 5;

const PHONE_RE = /^1[3-9]\d{9}$/; // 中国大陆手机号

export function isValidPhone(phone: string): boolean {
  return PHONE_RE.test(phone);
}

function genCode(): string {
  return String(crypto.randomInt(100000, 1000000)); // 6 位
}

export type RequestCodeResult = { ok: boolean; message?: string; devCode?: string };

// 发送验证码（新号也可发——验证通过时自动注册）
export async function requestLoginCode(phone: string): Promise<RequestCodeResult> {
  if (!isValidPhone(phone)) return { ok: false, message: '手机号格式不正确' };
  // 频控：60s 冷却
  const recent = await prisma.verificationCode.findFirst({
    where: { phone, createdAt: { gt: new Date(Date.now() - RESEND_COOLDOWN_MS) } },
    orderBy: { createdAt: 'desc' },
  });
  if (recent) return { ok: false, message: '发送太频繁，请稍后再试' };

  const code = genCode();
  await prisma.verificationCode.create({
    data: { phone, code, expiresAt: new Date(Date.now() + CODE_TTL_MS) },
  });
  const sms = getSmsProvider();
  await sms.sendCode(phone, code);
  // 开发态 Mock 通道：把验证码回显给前端，便于无短信联调。
  // ⚠️ 两个条件缺一不可，且 isProd() 必须在前：单看 mocked 会在「生产 + 忘配 vendor」时
  // 把明文验证码放进 server action 返回值 —— 攻击者输入任意手机号点发送即可拿码登入，
  // 零前置条件的任意账号接管。lib/sms/provider.ts 现已在生产态拒绝 Mock 通道，
  // 这里是第二道闸：即便那道闸被改坏，生产也不回显。
  const devCode = !isProd() && sms.mocked ? code : undefined;
  return { ok: true, devCode };
}

export type VerifyResult = { ok: boolean; message?: string; token?: string };

// 校验验证码：通过则登录。
// 分叉：带有效邀请 token → 加入邀请方租户（用邀请里的 role）；否则新号自动注册（新开租户）。
export async function verifyLoginCode(
  phone: string,
  code: string,
  userAgent?: string,
  inviteToken?: string,
  consent?: boolean,
): Promise<VerifyResult> {
  if (!isValidPhone(phone)) return { ok: false, message: '手机号格式不正确' };

  // 邀请先于验证码校验：无效邀请不该白白烧掉一条验证码
  let invite: ResolvedInvite | null = null;
  if (inviteToken) {
    invite = await resolveInvite(inviteToken);
    if (!invite) return { ok: false, message: '邀请链接无效、已被使用或已过期' };
    // 定向邀请：登录手机号必须与被邀请人一致，防链接泄漏被人捡走
    if (invite.phone && invite.phone !== phone) {
      return { ok: false, message: '该邀请链接指定了其他手机号，请用受邀手机号登录' };
    }
  }

  const codeCheck = await consumeVerificationCode(phone, code);
  if (!codeCheck.ok) return codeCheck;

  // 找到或自动创建 member（+租户/工作区/起始账号）
  let member = await prisma.member.findUnique({ where: { phone } });
  if (member) {
    // 停用成员不得登录，也不得借邀请链接绕回来；先于任何邀请状态变更判断，免得白烧一张邀请
    if (member.status !== 'active') return { ok: false, message: '账号已被停用，请联系工作区管理员' };
    // 模型约束：Member.phone 全局唯一 = 一个手机号只能属于一个租户。
    // 被邀请方已在别的工作区时无法「多租户身份」，如实报错而不是悄悄搬人。
    if (invite && member.tenantId !== invite.tenantId) {
      return { ok: false, message: '该手机号已属于其他工作区，无法接受本邀请' };
    }
    // 已是本租户成员：直接登录，不重复建 Member。定向邀请顺手标记完成；
    // 开放邀请（不限手机号）保持 pending，免得把留给别人的名额烧掉。
    if (invite && invite.phone) {
      await prisma.invite.updateMany({
        where: { id: invite.id, status: 'pending' },
        data: { status: 'accepted', acceptedAt: new Date() },
      });
    }
  } else if (invite) {
    member = await joinTenantByInvite(phone, invite);
    if (!member) return { ok: false, message: '邀请链接已被使用，请向邀请人索取新链接' };
  } else {
    member = await provisionNewUser(phone);
  }

  if (consent) {
    await prisma.member.update({
      where: { id: member.id },
      data: { consentAt: new Date(), consentVersion: LEGAL_VERSION },
    });
  }

  const token = await createSession(member.id, userAgent);
  return { ok: true, token };
}

// 校验并消费一条短信验证码。登录（verifyLoginCode）与绑定手机号（actBindPhone）共用；
// 只管码本身的有效性，不做任何登录/建号副作用。
export async function consumeVerificationCode(
  phone: string,
  code: string,
): Promise<{ ok: boolean; message?: string }> {
  const record = await prisma.verificationCode.findFirst({
    where: { phone, consumed: false, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!record) return { ok: false, message: '验证码已过期，请重新获取' };

  // 先原子占用一次尝试额度，再比对——顺序不能反。
  // 「读 attempts → 判上限 → 写自增」是 check-then-act：并发请求全读到同一个旧值、
  // 全部通过上限检查，MAX_ATTEMPTS 被放大到并发度，攻击者并发猜码即可绕过。
  // 条件写（where 里带 attempts < MAX）把判定和自增压进一条 UPDATE：
  // 两库都靠行锁把并发 UPDATE 串行化，且拿到锁后重新求值 where，
  // 所以恰好只有前 MAX_ATTEMPTS 个请求能拿到额度（SQLite 写全局串行，Postgres READ COMMITTED 行锁重求值）。
  const claimed = await prisma.verificationCode.updateMany({
    where: { id: record.id, consumed: false, attempts: { lt: MAX_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return { ok: false, message: '尝试次数过多，请重新获取验证码' };
  if (record.code !== code) return { ok: false, message: '验证码不正确' };

  // 消费同样要原子：consumed false→true 抢不到说明并发下这条码已被用掉，
  // 否则同一条码能并发换出多个会话。
  const consumed = await prisma.verificationCode.updateMany({
    where: { id: record.id, consumed: false },
    data: { consumed: true },
  });
  if (consumed.count === 0) return { ok: false, message: '验证码已使用，请重新获取' };
  return { ok: true };
}

export type ResolvedInvite = { id: string; tenantId: string; phone: string | null; role: string };

// 解析邀请 token：必须 pending 且未过期。返回 null 表示不可用（无效/已用/已撤销/过期）。
async function resolveInvite(token: string): Promise<ResolvedInvite | null> {
  const inv = await prisma.invite.findUnique({ where: { token } });
  if (!inv || inv.status !== 'pending' || inv.expiresAt < new Date()) return null;
  return { id: inv.id, tenantId: inv.tenantId, phone: inv.phone, role: inv.role };
}

export type InvitePreview = { tenantName: string; role: string; phone: string | null };

// 登录页展示用：邀请有效则返回邀请方信息，无效返回 null（不泄漏租户是否存在以外的信息）
export async function peekInvite(token: string): Promise<InvitePreview | null> {
  const inv = await resolveInvite(token);
  if (!inv) return null;
  const tenant = await prisma.tenant.findUnique({ where: { id: inv.tenantId }, select: { name: true } });
  if (!tenant) return null;
  return { tenantName: tenant.name, role: inv.role, phone: inv.phone };
}

// 接受邀请入伙：先原子抢占 token（status pending→accepted），抢不到说明并发下已被别人用掉
async function joinTenantByInvite(phone: string, invite: ResolvedInvite) {
  const claimed = await prisma.invite.updateMany({
    where: { id: invite.id, status: 'pending' },
    data: { status: 'accepted', acceptedAt: new Date() },
  });
  if (claimed.count === 0) return null; // 同一 token 不可复用
  return prisma.member.create({
    data: { tenantId: invite.tenantId, name: `用户${phone.slice(-4)}`, phone, role: invite.role },
  });
}

// 新用户开通：一个手机号 = 一个租户 + 工作区 + 起始创作账号
// export 是给 lib/script-session.ts 用的：seed 按设计不建演示数据，脚本态需要能自备一个干净租户。
// 复用本函数而不是在脚本里重写一遍 —— 两份开通逻辑必然漂移（少写 personaCard 就是 f1 报的那个崩）。
export async function provisionNewUser(phone: string) {
  // 注册即送 TRIAL_DAYS 天试用（额度=标准版）。plan='trial' 是刻意选的独立档位字符串，
  // 不是 'personal'：trial 非付费档（isPaidPlan=false），试用期内购买任何档都不会
  // 触发降档拦截，也不会把白送的天数按残值折算进新档（见 lib/pay/pricing.ts:TRIAL_DAYS）。
  // 到期回落 free 靠 effectivePlan 懒判定，不依赖任何 cron。
  const tenant = await prisma.tenant.create({
    data: {
      name: `${phone.slice(-4)} 的工作室`,
      plan: 'trial',
      planExpiresAt: new Date(Date.now() + TRIAL_DAYS * 86_400_000),
    },
  });
  const workspace = await prisma.workspace.create({ data: { tenantId: tenant.id, name: '主工作区' } });
  const member = await prisma.member.create({
    data: { tenantId: tenant.id, name: `用户${phone.slice(-4)}`, phone, role: 'owner' },
  });
  // 起始空账号，保证进入后各页面可用；用户随后在「人设与记忆」完善
  await prisma.creatorAccount.create({
    data: {
      workspaceId: workspace.id,
      name: '我的账号',
      platform: 'multi',
      personaCard: toJson(emptyPersona()),
      styleFingerprint: toJson({ voice: [], format: [], topic: [] }),
    },
  });
  return member;
}

// ttlMs 默认 30 天；游客演示会话传短 TTL（1 天）。export 供游客登录（app/login/actions.ts）复用。
export async function createSession(memberId: string, userAgent?: string, ttlMs: number = SESSION_TTL_MS): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  await prisma.authSession.create({
    data: { token, memberId, userAgent: userAgent?.slice(0, 200), expiresAt: new Date(Date.now() + ttlMs) },
  });
  return token;
}

export type AuthedMember = {
  memberId: string;
  tenantId: string;
  workspaceId: string;
  accountId: string;
  memberName: string;
  role: string; // owner | admin | editor | viewer（权限判定见 lib/rbac.ts）
  plan: string;
};

// 由 token 解析当前登录用户上下文。
// preferredAccountId 来自账号切换 cookie：校验归属本工作区后生效，否则回退最早创建的活跃账号。
export async function getMemberByToken(token: string | undefined, preferredAccountId?: string): Promise<AuthedMember | null> {
  if (!token) return null;
  const session = await prisma.authSession.findUnique({ where: { token }, include: { member: true } });
  if (!session || session.expiresAt < new Date()) return null;
  const member = session.member;
  if (member.status !== 'active') return null; // 停用成员：已签发的会话立即失效
  // 滑动续期：剩余寿命不足一半时延长到满额——日常活跃用户永不掉线。
  // 游客演示会话除外：它按设计只活 1 天，续期会把短命体验会话变成常驻。
  if (!isDemoTenant(member.tenantId) && session.expiresAt.getTime() - Date.now() < SESSION_TTL_MS / 2) {
    await prisma.authSession.update({
      where: { token },
      data: { expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
    });
  }
  const workspace = await prisma.workspace.findFirst({
    where: { tenantId: member.tenantId },
    orderBy: { createdAt: 'asc' },
    include: { tenant: true },
  });
  if (!workspace) return null;
  let account = preferredAccountId
    ? await prisma.creatorAccount.findFirst({
        where: { id: preferredAccountId, workspaceId: workspace.id, status: 'active' },
        select: { id: true },
      })
    : null;
  if (!account) {
    account = await prisma.creatorAccount.findFirst({
      where: { workspaceId: workspace.id, status: 'active' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
  }
  // 全部被归档时兜底任意账号，保证会话可用
  if (!account) {
    account = await prisma.creatorAccount.findFirst({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
  }
  return {
    memberId: member.id,
    tenantId: member.tenantId,
    workspaceId: workspace.id,
    accountId: account?.id ?? '',
    memberName: member.name,
    role: member.role,
    // 🔒 必须过 effectivePlan：DB 里的 plan 是**买过什么**，不是**现在有什么**。
    // 到期后 tenant.plan 仍是 team/enterprise，直接用它会让：
    //   ① 顶栏徽标继续显示付费档（用户以为还在订阅）；
    //   ② app/(app)/settings/actions.ts:38 的 canUseOverseas(s.plan) 继续放行海外模型 BYOK
    //      —— 那道闸前置的是个人信息出境合规（PRD §10.5），不能靠一个过期的订阅撑着。
    // lib/quota.ts:planOf() 走的是同一套懒判断，两边口径必须一致，否则配额降了、闸门没降。
    plan: effectivePlan(workspace.tenant.plan, workspace.tenant.planExpiresAt),
  };
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return;
  await prisma.authSession.deleteMany({ where: { token } });
}

// 微信登录：按 openid 查找已有成员或自动注册（新开租户），返回会话 token。
export async function loginByWechat(
  openId: string,
  nickname: string,
  userAgent?: string,
  consent?: boolean,
): Promise<VerifyResult> {
  let member = await prisma.member.findUnique({ where: { wechatOpenId: openId } });
  if (member) {
    if (member.status !== 'active') return { ok: false, message: '账号已被停用，请联系工作区管理员' };
  } else {
    member = await provisionNewWechatUser(openId, nickname);
  }
  if (consent) {
    await prisma.member.update({
      where: { id: member.id },
      data: { consentAt: new Date(), consentVersion: LEGAL_VERSION },
    });
  }
  const token = await createSession(member.id, userAgent);
  return { ok: true, token };
}

export type BindResult = { ok: boolean; message?: string };

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

// 把微信 openid 绑到已登录成员（设置页「账号与安全」）。
// 已被其他账号占用时如实拒绝——自动合并两个账号牵涉数据归属与计费，只走人工。
export async function bindWechatToMember(memberId: string, openId: string): Promise<BindResult> {
  const existing = await prisma.member.findUnique({ where: { wechatOpenId: openId } });
  if (existing) {
    if (existing.id === memberId) return { ok: true }; // 幂等：重复绑自己
    return { ok: false, message: '该微信已绑定其他账号，如需合并请联系客服' };
  }
  try {
    await prisma.member.update({ where: { id: memberId }, data: { wechatOpenId: openId } });
    return { ok: true };
  } catch (err) {
    // 查后写窗口内被并发抢注：唯一约束是最终裁判
    if (isUniqueViolation(err)) return { ok: false, message: '该微信已绑定其他账号，如需合并请联系客服' };
    throw err;
  }
}

// 解绑微信。铁律：至少保留一种登录方式——没有手机号时拒绝解绑微信，否则账号从此无法登录。
export async function unbindWechatFromMember(memberId: string): Promise<BindResult> {
  const member = await prisma.member.findUnique({ where: { id: memberId }, select: { phone: true, wechatOpenId: true } });
  if (!member) return { ok: false, message: '账号不存在' };
  if (!member.wechatOpenId) return { ok: true }; // 幂等：本就未绑定
  if (!member.phone) return { ok: false, message: '请先绑定手机号再解绑微信，账号至少要保留一种登录方式' };
  await prisma.member.update({ where: { id: memberId }, data: { wechatOpenId: null } });
  return { ok: true };
}

// 解绑手机号。同铁律：没有微信绑定时拒绝。
export async function unbindPhoneFromMember(memberId: string): Promise<BindResult> {
  const member = await prisma.member.findUnique({ where: { id: memberId }, select: { phone: true, wechatOpenId: true } });
  if (!member) return { ok: false, message: '账号不存在' };
  if (!member.phone) return { ok: true };
  if (!member.wechatOpenId) return { ok: false, message: '请先绑定微信再解绑手机号，账号至少要保留一种登录方式' };
  await prisma.member.update({ where: { id: memberId }, data: { phone: null } });
  return { ok: true };
}

// 把手机号绑到已登录成员。验证码校验由调用方先行（consumeVerificationCode），此处只管归属与唯一性。
// member 已有手机号时直接覆盖 = 换绑（新号验证码已证明归属；旧号随之释放）。
export async function bindPhoneToMember(memberId: string, phone: string): Promise<BindResult> {
  if (!isValidPhone(phone)) return { ok: false, message: '手机号格式不正确' };
  const existing = await prisma.member.findUnique({ where: { phone } });
  if (existing) {
    if (existing.id === memberId) return { ok: true };
    return { ok: false, message: '该手机号已注册其他账号，如需合并请联系客服' };
  }
  try {
    await prisma.member.update({ where: { id: memberId }, data: { phone } });
    return { ok: true };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, message: '该手机号已注册其他账号，如需合并请联系客服' };
    throw err;
  }
}

// 邮箱绑定已于 2026-07-30 下线：不铺邮件通道，账单/到期提醒改走站内通知 + 顶部横幅 + 机器人。
// `Member.email` 列**保留**（存量数据 + 数据导出要如实带上），但系统不再写入、不再依赖它送达。

async function provisionNewWechatUser(openId: string, nickname: string) {
  const displayName = nickname || '微信用户';
  const tenant = await prisma.tenant.create({
    data: {
      name: `${displayName} 的工作室`,
      plan: 'trial',
      planExpiresAt: new Date(Date.now() + TRIAL_DAYS * 86_400_000),
    },
  });
  const workspace = await prisma.workspace.create({ data: { tenantId: tenant.id, name: '主工作区' } });
  const member = await prisma.member.create({
    data: { tenantId: tenant.id, name: displayName, wechatOpenId: openId, role: 'owner' },
  });
  await prisma.creatorAccount.create({
    data: {
      workspaceId: workspace.id,
      name: '我的账号',
      platform: 'multi',
      personaCard: toJson(emptyPersona()),
      styleFingerprint: toJson({ voice: [], format: [], topic: [] }),
    },
  });
  return member;
}
