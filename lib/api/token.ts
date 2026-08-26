import crypto from 'node:crypto';
import { prisma } from '../db';
import { edition } from '../edition';
import type { ToolContext } from '../agent/tools';

// ── 对外调用令牌 ────────────────────────────────────────────────────────────
//
// 【它是给谁用的】跑在用户自己机器上的那台烽火台，要能被**别的程序**驱动：
// 一个脚本、一个定时任务、或者 Claude 这样的 MCP 客户端。
// 这正是「像 OpenClaw 一样部署到 Mac mini 直接调用」缺的最后一块。
//
// 【为什么不复用采集令牌】那一枚是工作区级的、不绑成员，回答不了
// 「这次调用按谁的权限算」。而 AI 执行的每一步权限都按发起人算——
// 拿一枚不知道是谁的令牌去开执行，等于凭空造出一个没有主人的操作者。
//
// 【为什么 SaaS 上不开】SaaS 的边界是公网，多开一条「拿到一串字符就能代人操作」的
// 通道要配套做速率、审计、异常检测一整套；而这条能力的**动机**是本机部署。
// 先只给企业版（appliance / private），需要时再单独评估 SaaS。

/** 令牌前缀。与采集令牌的 `bcn_` 一眼可分——排查时不至于把两种令牌看混。 */
const PREFIX = 'bck_';

/** lastUsedAt 的写入节流：每次调用都更新等于给每个请求平白加一次写库。 */
const TOUCH_INTERVAL_MS = 5 * 60_000;

/** 这个部署形态给不给对外调用面。 */
export function apiEnabled(): boolean {
  return edition() !== 'saas';
}

export type IssuedToken = { id: string; token: string; label: string };

/**
 * 签发一枚令牌。**明文只在这一刻返回一次**——之后界面上只显示前几位。
 *
 * 【为什么不做成可以再看一遍】能再看就意味着它以明文存着且随时可读，
 * 那么任何一次会话劫持都等于拿到了长期凭证。丢了就重签一枚，成本很低。
 */
export async function issueApiToken(memberId: string, label: string): Promise<IssuedToken> {
  const token = PREFIX + crypto.randomBytes(24).toString('base64url');
  const row = await prisma.apiToken.create({
    data: { token, memberId, label: label.trim().slice(0, 40) || '未命名' },
  });
  return { id: row.id, token, label: row.label };
}

export async function revokeApiToken(memberId: string, id: string): Promise<boolean> {
  // 带 memberId：不带的话拿到一个任意 id 就能吊销别人的令牌
  const r = await prisma.apiToken.updateMany({
    where: { id, memberId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return r.count > 0;
}

export type ApiTokenRow = { id: string; label: string; prefix: string; createdAt: Date; lastUsedAt: Date | null };

export async function listApiTokens(memberId: string): Promise<ApiTokenRow[]> {
  const rows = await prisma.apiToken.findMany({
    where: { memberId, revokedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    // 只回前 12 位：够用户认出是哪一枚，又不足以拼出完整令牌
    prefix: `${r.token.slice(0, 12)}…`,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
  }));
}

/**
 * 用令牌换出一个可以直接跑执行的上下文。
 *
 * 【它每次都现查角色，不缓存】与 lib/agent/run.ts 的 contextForRun 同一条口径：
 * 一枚昨天签的令牌，用的是这个人**今天**的权限。他被降权或移出团队，
 * 令牌立刻跟着失效，不需要额外做任何事。
 */
export async function resolveApiToken(
  raw: string | null | undefined,
): Promise<{ ctx: ToolContext; tokenId: string; memberName: string } | null> {
  if (!apiEnabled()) return null;
  const t = (raw ?? '').trim().replace(/^Bearer\s+/i, '');
  if (!t.startsWith(PREFIX)) return null;

  const row = await prisma.apiToken.findUnique({
    where: { token: t },
    include: {
      member: {
        select: {
          id: true, name: true, role: true, status: true, tenantId: true,
          // 这枚令牌在哪个工作区/账号下干活：取这个租户下最早的那个工作区与账号。
          // 【为什么不让调用方指定】那就成了「拿一枚令牌可以指着任意 id 操作」，
          // 而调用方是脚本，没有界面可以先让人挑一次
          tenant: {
            select: {
              workspaces: {
                orderBy: { createdAt: 'asc' },
                take: 1,
                select: { id: true, accounts: { orderBy: { createdAt: 'asc' }, take: 1, select: { id: true } } },
              },
            },
          },
        },
      },
    },
  });
  if (!row || row.revokedAt) return null;

  const m = row.member;
  // 成员被停用了，令牌跟着失效——不需要单独去吊销每一枚
  if (m.status && m.status !== 'active') return null;

  const ws = m.tenant.workspaces[0];
  const account = ws?.accounts[0];
  if (!ws || !account) return null;

  await touch(row.id, row.lastUsedAt);
  return {
    tokenId: row.id,
    memberName: m.name,
    ctx: {
      tenantId: m.tenantId,
      workspaceId: ws.id,
      accountId: account.id,
      memberId: m.id,
      role: m.role,
    },
  };
}

async function touch(id: string, lastUsedAt: Date | null): Promise<void> {
  if (lastUsedAt && Date.now() - lastUsedAt.getTime() < TOUCH_INTERVAL_MS) return;
  // 失败不影响鉴权：lastUsedAt 只是界面上的一个说明字段
  await prisma.apiToken.update({ where: { id }, data: { lastUsedAt: new Date() } }).catch(() => {});
}
