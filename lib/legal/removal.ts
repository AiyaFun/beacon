import { prisma } from '../db';
import { parseCompetitorUrl } from '../competitor-url';

// 数据移除申请（《个人信息保护法》处理已公开个人信息时的拒绝权）的**执行闸**。
//
// 此前这张表只有写入、没有执行：公开页收下了退出申请，采集链路却从不查它——
// 等于对外承诺了一个代码兑现不了的权利。这是法律承诺缺口，不是普通功能缺口，
// 所以两条采集通道（定时抓取 + 插件回传）都必须过这道闸。
//
// 状态口径：
//   · pending  —— 待核验也**先停采**。宁可少采几天，也不在核验期间继续采集被投诉的账号。
//   · verified / removed —— 已确认，停采。
//   · rejected —— 核验为无效申请（如冒用他人身份主张他人账号），恢复采集。
const BLOCKING_STATUSES = ['pending', 'verified', 'removed'];

/**
 * 把用户填的「主页链接或标识」规范化成与 CompetitorAccount.handle 同口径的值。
 * 必须规范化后再存：申请人填的通常是整条主页 URL，而采集侧存的是纯 handle，
 * 不归一的话这道闸永远匹配不上——看起来在执行，实际一条都拦不住。
 */
export function normalizeRemovalTarget(platform: string, rawHandle: string): { platform: string; handle: string } {
  const raw = rawHandle.trim();
  if (/https?:\/\//i.test(raw) || /\.(com|cn|tv)\//.test(raw)) {
    const parsed = parseCompetitorUrl(raw);
    if (parsed) return { platform: parsed.platform, handle: parsed.handle };
  }
  return { platform, handle: raw };
}

/** 该账号是否已被申请移除（生效中）→ true 表示**不得再采集**。 */
export async function isRemovalRequested(platform: string, handle: string): Promise<boolean> {
  if (!handle) return false;
  const hit = await prisma.dataRemovalRequest.findFirst({
    where: { platform, handle, status: { in: BLOCKING_STATUSES } },
    select: { id: true },
  });
  return hit !== null;
}

/**
 * 真正**移除已采集的数据**。
 *
 * 停采只兑现了申请页承诺的一半——页面写的是「停止采集**并移除已收集的**相关公开信息」。
 * 只挡住新数据、库里旧数据照留，那句承诺仍然是假的。
 *
 * 删什么：竞对档案 + 其作品 + 作品快照（CrawledPost/PostMetricSnapshot 走 onDelete: Cascade）
 *        + 各工作区的关注项（WatchlistItem 同样级联）
 *        + 采集台账里指向它的行（CollectionRun 无外键、不会级联，必须手删——
 *          那些行留着账号名与"哪几天采过它"，同属承诺要移除的相关信息）。
 * 不删什么：**别人基于该账号做出的选题/草稿/记忆**——那是用户自己的创作产物，
 *          不属于被申请人的个人信息，删它属于越权处置第三方数据。
 *
 * 返回真实删除量，供运营核对与审计留痕（"说删了"与"删了什么"必须对得上）。
 */
export async function purgeRemovedAccountData(
  platform: string,
  handle: string,
): Promise<{ accounts: number; posts: number; watchlistItems: number; runs: number }> {
  const account = await prisma.competitorAccount.findUnique({
    where: { platform_handle: { platform, handle } },
    select: { id: true },
  });
  if (!account) return { accounts: 0, posts: 0, watchlistItems: 0, runs: 0 };

  const posts = await prisma.crawledPost.count({ where: { competitorId: account.id } });
  const watchlistItems = await prisma.watchlistItem.count({ where: { competitorId: account.id } });
  // 采集台账指向被删账号：无外键 → 不会级联，删在前面（删完档案就再也查不到 targetId 了）
  const { count: runs } = await prisma.collectionRun.deleteMany({
    where: { scope: 'rival', targetId: account.id },
  });
  // 其余级联由 schema 保证（CrawledPost.competitor / WatchlistItem.competitor 均 onDelete: Cascade）
  await prisma.competitorAccount.delete({ where: { id: account.id } });
  return { accounts: 1, posts, watchlistItems, runs };
}

/**
 * 流转一条申请的状态，并在「确认成立」时顺手执行移除。
 * verified/removed 都视为成立——两者的差别只在运营口径（已核验 / 已执行），
 * 对被申请人的结果是同一件事：数据没了、以后也不采。
 */
export async function resolveRemovalRequest(
  id: string,
  status: 'verified' | 'removed' | 'rejected',
): Promise<{ ok: boolean; purged?: { accounts: number; posts: number; watchlistItems: number }; error?: string }> {
  const req = await prisma.dataRemovalRequest.findUnique({ where: { id } });
  if (!req) return { ok: false, error: '申请不存在' };

  await prisma.dataRemovalRequest.update({
    where: { id },
    data: { status, resolvedAt: new Date() },
  });
  if (status === 'rejected') return { ok: true };

  const purged = await purgeRemovedAccountData(req.platform, req.handle);
  return { ok: true, purged };
}
