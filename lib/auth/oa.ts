import crypto from 'node:crypto';
import { prisma } from '@/lib/db';
import { createSession } from '@/lib/auth';
import { LEGAL_VERSION } from '@/lib/legal';
import { DEMO_TENANT_ID } from '@/lib/demo/guard';
import { notify } from '@/lib/notify';
import { ROLE_LABEL, type Role } from '@/lib/rbac';

// 企业应用（飞书/钉钉/企微）登录内核。
//
// 【为什么企业版必须有它】appliance / private 关掉了短信通道，装机向导只能让**第一个**管理员进去。
// 没有这一层，第二个员工永远登不进来 —— 机器交付出去等于只有一个人能用。
//
// 【员工只需要记住一个词：登录】
//   私聊机器人发「登录」→ 已是成员就回一条一次性链接；**还不是成员就当场加入再回链接**。
//   没有邀请码、没有申请、没有审批队列。
//
//   为什么敢自动加入：**企业应用本身就是公司边界**。能私聊到这个机器人的人，
//   已经通过了客户自己的飞书/钉钉/企微认证，就是这家公司的员工 —— 而这台机器正是
//   这家公司买来给自己团队用的。再叠一层邀请码，挡住的不是外人（外人根本发不了消息），
//   只是让每个同事都要先去找管理员要一串码。
//
//   但**绝不静默**：新人进来时机器人明说他以什么身份加入，同时给工作区发一条站内通知，
//   管理员在红点里看得到「谁进来了」。要收回就在「成员与权限」停用他。
//
//   装机管理员是唯一的例外：他从 /setup 进来，Member 上还没有 open_id，
//   所以要一次「绑定 <6 位码>」把两边接上（码在「账号与安全」里取，装机完成页也直接给）。
//   不绑的话，这次会话过期后他自己也登不回来。
//
// 【为什么整机版走机器人而不是网页扫码】网页授权要在企业应用后台登记 redirect_uri，
// 而整机跑在 http://localhost:<端口> —— 只有那台机器上的浏览器跳得回来，
// 同事在自己电脑上访问的是局域网地址，回跳直接断。私聊机器人这条路不需要任何回跳登记。
// 私有化版有公网域名和证书，网页授权照常可用（见 app/api/auth/oa/*）。
//
// 【一次性票据为什么借 VerificationCode】它已经有 consumed 的**原子消费**
// （updateMany + where consumed:false，见 lib/auth.ts 的 consumeVerificationCode 注释）。
// 登录链接会留在聊天记录里，"只能用一次"是硬要求，重新造一张表既多一次生产建表、
// 又要把同样的并发正确性重写一遍。

export type OaProvider = 'feishu' | 'dingtalk' | 'wecom';

const LOGIN_TTL_MS = 5 * 60 * 1000; // 链接躺在聊天记录里，给得越久风险越大
const BIND_TTL_MS = 10 * 60 * 1000; // 人要切到另一个 App 去发消息，给宽一点
const PURPOSE_LOGIN = 'oa_login';
const PURPOSE_BIND = 'oa_bind';

/**
 * 身份串：`<provider>:<openId>`。
 *
 * ⚠️ **不许转小写**。open_id 是平台发的不透明 ID，大小写敏感；归一化会把两个不同的人
 * 折叠成同一个身份（这条教训见 lib/…handle 归一那次：不透明 ID 一律原样存）。
 */
export function oaIdentity(provider: OaProvider, openId: string): string {
  const id = (openId ?? '').trim();
  if (!id) throw new Error('open_id 为空');
  return `${provider}:${id}`;
}

function randomCode(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

function random6(): string {
  // 6 位数字，人要在聊天框里手打。0 开头也允许，所以用字符串补齐而不是 Number。
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/** 按 OA 身份找成员（只认在职的）。 */
export async function memberByOaIdentity(identity: string) {
  return prisma.member.findFirst({
    where: { oaIdentity: identity, status: 'active' },
    select: { id: true, name: true, tenantId: true, role: true },
  });
}

// ── ① 绑定 ───────────────────────────────────────────────────────────────
/** 给已登录成员发一个绑定码，让他私聊机器人发「绑定 <码>」。 */
export async function issueBindCode(memberId: string): Promise<string> {
  const code = random6();
  await prisma.verificationCode.create({
    data: {
      phone: `oa-bind:${memberId}`, // 这一列此处存的是载荷不是手机号（见文件头说明）
      code,
      purpose: PURPOSE_BIND,
      expiresAt: new Date(Date.now() + BIND_TTL_MS),
    },
  });
  return code;
}

export type BindOutcome = { ok: boolean; message: string };

/** 机器人收到「绑定 <码>」时调用：把发消息人的 open_id 记到那个成员名下。 */
export async function bindOaByCode(code: string, provider: OaProvider, openId: string): Promise<BindOutcome> {
  const rec = await prisma.verificationCode.findFirst({
    where: { code: code.trim(), purpose: PURPOSE_BIND, consumed: false, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!rec) return { ok: false, message: '绑定码无效或已过期，请回网页重新获取。' };

  const memberId = rec.phone.replace(/^oa-bind:/, '');
  const identity = oaIdentity(provider, openId);

  // 这个 open_id 已经挂在别人名下 → 拒绝。否则两个人可以抢同一个身份，
  // 后绑的会把先绑的挤掉（unique 冲突或静默改写），而被挤掉的人从此登不进来。
  const taken = await prisma.member.findFirst({ where: { oaIdentity: identity }, select: { id: true } });
  if (taken && taken.id !== memberId) {
    return { ok: false, message: '这个企业应用账号已经绑定到另一位成员了。' };
  }

  // 原子消费：同一个码并发用两次，只有一次能成
  const consumed = await prisma.verificationCode.updateMany({
    where: { id: rec.id, consumed: false },
    data: { consumed: true },
  });
  if (consumed.count === 0) return { ok: false, message: '这个绑定码已经用过了。' };

  const member = await prisma.member.findUnique({ where: { id: memberId }, select: { id: true, name: true } });
  if (!member) return { ok: false, message: '找不到对应的成员，请重新获取绑定码。' };

  await prisma.member.update({ where: { id: memberId }, data: { oaIdentity: identity } });
  return { ok: true, message: `已绑定到「${member.name}」，以后私聊我发「登录」就能拿到登录链接。` };
}

// ── ② 登录 ───────────────────────────────────────────────────────────────
export type TicketOutcome =
  | { ok: true; ticket: string; joined: boolean; memberName: string; roleLabel: string }
  | { ok: false; message: string };

/** 机器人收到「登录」时调用：已绑定就发一次性票据，没绑定就说清楚下一步。 */
export async function issueOaLoginTicket(
  provider: OaProvider,
  openId: string,
  displayName?: string,
): Promise<TicketOutcome> {
  const identity = oaIdentity(provider, openId);
  let member = await memberByOaIdentity(identity);
  let joined = false;

  if (!member) {
    const auto = await autoJoin(identity, displayName);
    if (!auto) {
      // 只有一种情况会到这里：这台实例还没装机（一个租户都没有）。
      return { ok: false, message: '这台实例还没有完成初始化，请管理员先打开网页完成装机。' };
    }
    member = auto;
    joined = true;
  }
  const ticket = randomCode(24);
  await prisma.verificationCode.create({
    data: {
      phone: `oa-login:${identity}`,
      code: ticket,
      purpose: PURPOSE_LOGIN,
      expiresAt: new Date(Date.now() + LOGIN_TTL_MS),
    },
  });
  return { ok: true, ticket, joined, memberName: member.name, roleLabel: ROLE_LABEL[member.role as Role] ?? member.role };
}

/**
 * 自动加入：把一个还没见过的企业应用账号收成本工作区的「成员」。
 *
 * 角色固定 editor（成员）—— 不做「首个进来的人当管理员」那种猜测：
 * 管理员是装机的那个人，已经在 /setup 里定下了。
 *
 * 只往**第一个**租户里加。企业版一台实例服务一家公司（装机向导只建一个租户），
 * 出现第二个租户属于异常状态，这时宁可不猜。
 */
async function autoJoin(identity: string, displayName?: string) {
  const tenant = await prisma.tenant.findFirst({
    where: { id: { not: DEMO_TENANT_ID } },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!tenant) return null;

  const member = await prisma.member.create({
    data: {
      tenantId: tenant.id,
      name: displayName?.trim() || '新同事',
      role: 'editor',
      status: 'active',
      oaIdentity: identity,
      consentAt: new Date(),
      consentVersion: LEGAL_VERSION,
    },
    select: { id: true, name: true, tenantId: true, role: true },
  });

  // 绝不静默：管理员要在红点里看得到「谁进来了」，否则「自动加入」就变成了偷偷扩权。
  // 旁路，失败不影响登录本身。
  const ws = await prisma.workspace.findFirst({ where: { tenantId: tenant.id }, select: { id: true } });
  if (ws) {
    await notify({
      workspaceId: ws.id,
      kind: 'system',
      title: `新成员加入：${member.name}`,
      // 角色名从 ROLE_LABEL 取，不写死：写死的那一刻就开始和成员页上的标签漂移，
      // 用户会以为「成员」和「编辑」是两种不同的身份（真机 2026-08-19 就漂了一次）。
      body: `${member.name} 通过企业应用登录并自动加入为「${ROLE_LABEL[member.role as Role] ?? member.role}」。若不该放行，可在「成员与权限」停用。`,
      link: '/members',
    }).catch(() => {});
  }
  return member;
}

export type ConsumeOutcome =
  | { ok: true; token: string }
  | { ok: false; message: string };

/**
 * 消费登录票据，换出会话 token。
 *
 * 只按 code 查：票据是 48 位十六进制随机串，本身就是凭证；
 * 让链接里带上身份串只会把 open_id 暴露在浏览器历史和日志里。
 */
export async function consumeOaLoginTicket(ticket: string, userAgent?: string): Promise<ConsumeOutcome> {
  const raw = (ticket ?? '').trim();
  if (!/^[0-9a-f]{16,96}$/.test(raw)) return { ok: false, message: '登录链接无效。' };

  const rec = await prisma.verificationCode.findFirst({
    where: { code: raw, purpose: PURPOSE_LOGIN, consumed: false, expiresAt: { gt: new Date() } },
  });
  if (!rec) return { ok: false, message: '登录链接已过期或已经用过了，请私聊机器人重新发「登录」。' };

  const consumed = await prisma.verificationCode.updateMany({
    where: { id: rec.id, consumed: false },
    data: { consumed: true },
  });
  if (consumed.count === 0) return { ok: false, message: '这条登录链接已经用过了。' };

  const identity = rec.phone.replace(/^oa-login:/, '');
  const member = await memberByOaIdentity(identity);
  // 票据签发之后成员被停用/删除 —— 票据仍在有效期内，但不该还能进来。
  if (!member) return { ok: false, message: '账号已停用，请联系管理员。' };

  const token = await createSession(member.id, userAgent);
  return { ok: true, token };
}

// ── ③ 加入（凭邀请码）────────────────────────────────────────────────────
export async function joinByInvite(
  inviteToken: string,
  provider: OaProvider,
  openId: string,
  displayName: string,
): Promise<BindOutcome> {
  const identity = oaIdentity(provider, openId);

  const already = await memberByOaIdentity(identity);
  if (already) return { ok: false, message: '你已经是成员了，直接发「登录」即可。' };

  const inv = await prisma.invite.findUnique({ where: { token: inviteToken.trim() } });
  if (!inv || inv.status !== 'pending' || inv.expiresAt < new Date()) {
    return { ok: false, message: '邀请码无效或已过期，请找管理员重新生成。' };
  }

  // 邀请与成员创建必须同一个事务：先建人后标邀请，中间失败会留下一个"邀请还在 pending
  // 但人已经进来了"的状态，同一串码能被反复使用。
  const created = await prisma.$transaction(async (tx) => {
    const claimed = await tx.invite.updateMany({
      where: { id: inv.id, status: 'pending' },
      data: { status: 'accepted', acceptedAt: new Date() },
    });
    if (claimed.count === 0) return null; // 并发下被别人先用掉了
    return tx.member.create({
      data: {
        tenantId: inv.tenantId,
        name: displayName?.trim() || '同事',
        role: inv.role,
        status: 'active',
        oaIdentity: identity,
        consentAt: new Date(),
        consentVersion: LEGAL_VERSION,
      },
      select: { id: true, name: true },
    });
  });
  if (!created) return { ok: false, message: '这个邀请码刚刚被用掉了，请找管理员再要一个。' };

  return { ok: true, message: `欢迎，${created.name}！你已加入。发「登录」拿登录链接。` };
}
