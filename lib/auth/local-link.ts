import crypto from 'node:crypto';
import { prisma } from '@/lib/db';
import { createSession } from '@/lib/auth';
import { ROLE_LABEL, type Role } from '@/lib/rbac';

// ── 本机一次性登录链接 ──────────────────────────────────────────────────────
//
// 【它补的是什么】企业版（appliance / private）关掉了短信通道，登录的唯一通路是
// 「私聊企业应用机器人发『登录』」。可客户**未必配了**飞书/钉钉/企微——
// 没配的话，整台机器只有装机那个人靠向导种下的那次会话能用；
// 会话一过期，他自己也进不去了，而同事从头到尾就没进去过。
//
// 【为什么不能拿装机口令当常驻凭据】那是个**一次性装机凭证**：
// 明文写在 .env 里、装机时打印在终端、还抄进了桌面的《安装说明》。
// 把它延伸成「输入口令即可登录」，等于把桌面上的一张纸变成永久门钥匙，
// 而且违背它自己的设计（lib/setup/state.ts：装完之后 assertSetupAllowed 一律拒绝）。
//
// 【所以改成什么】**已登录的管理员**给某个成员生成一条 5 分钟有效、一次性的登录链接，
// 通过任何他信任的渠道发过去（微信、当面、内部 IM 都行）。
// 权力来源是「已经登录的管理员」，不是「知道某个口令的人」——这一点与机器人那条路一致。
//
// 【票据为什么借 VerificationCode】它已经有 consumed 的**原子消费**
//（updateMany + where consumed:false），而「只能用一次」是这里的硬要求。
// 重造一张表既多一次生产建表，又要把同样的并发正确性重写一遍。

/** 5 分钟。链接会被复制粘贴到各种地方，有效期必须短。 */
const TTL_MS = 5 * 60_000;
const PURPOSE = 'local-login';
/** VerificationCode.phone 借位存「这张票据是给谁的」。 */
const keyOf = (memberId: string) => `local-login:${memberId}`;

export type IssueOutcome =
  | { ok: true; ticket: string; memberName: string; roleLabel: string; expiresInMinutes: number }
  | { ok: false; message: string };

/**
 * 给同租户里的某个成员签一张登录票据。
 *
 * **调用方必须已经确认操作者是管理员**（server action 里 requireRole）。
 * 这里只再确认一件事：目标成员确实在同一个租户里——不校验的话，
 * 拿到一个任意 memberId 就能给别家租户的人签票。
 */
export async function issueLocalLoginTicket(tenantId: string, memberId: string): Promise<IssueOutcome> {
  const member = await prisma.member.findFirst({
    where: { id: memberId, tenantId },
    select: { id: true, name: true, role: true },
  });
  if (!member) return { ok: false, message: '这个成员不存在，或不属于当前团队' };

  const ticket = crypto.randomBytes(24).toString('hex');
  await prisma.verificationCode.create({
    data: {
      phone: keyOf(member.id),
      code: ticket,
      purpose: PURPOSE,
      expiresAt: new Date(Date.now() + TTL_MS),
    },
  });
  return {
    ok: true,
    ticket,
    memberName: member.name,
    roleLabel: ROLE_LABEL[member.role as Role] ?? member.role,
    expiresInMinutes: TTL_MS / 60_000,
  };
}

export type ConsumeOutcome = { ok: true; token: string } | { ok: false; message: string };

/** 用票据换会话。一次性：换过就作废。 */
export async function consumeLocalLoginTicket(ticket: string, userAgent?: string): Promise<ConsumeOutcome> {
  const raw = (ticket ?? '').trim();
  // 先按形状挡一道：省掉一次没有意义的查库，也避免把奇形怪状的输入喂给查询
  if (!/^[0-9a-f]{32,96}$/.test(raw)) return { ok: false, message: '登录链接无效。' };

  const rec = await prisma.verificationCode.findFirst({
    where: { code: raw, purpose: PURPOSE, consumed: false, expiresAt: { gt: new Date() } },
  });
  if (!rec) return { ok: false, message: '登录链接已过期或已经用过了，请让管理员重新生成一条。' };

  // 原子消费：两个人同时点同一条链接，只有一个换得到会话
  const consumed = await prisma.verificationCode.updateMany({
    where: { id: rec.id, consumed: false },
    data: { consumed: true },
  });
  if (consumed.count === 0) return { ok: false, message: '这条登录链接已经用过了。' };

  const memberId = rec.phone.replace(/^local-login:/, '');
  const member = await prisma.member.findUnique({ where: { id: memberId }, select: { id: true } });
  // 签票之后成员被删了——票据还在有效期内，但不该还能进来
  if (!member) return { ok: false, message: '账号已停用，请联系管理员。' };

  const token = await createSession(member.id, userAgent);
  return { ok: true, token };
}
