import { prisma } from '../db';
import { beijingStartOfMonth } from '../beijing';
import { effectivePlan } from './plan';

// 平台代付的公众号数据源配额（2026-09-05 增长缺口整改）。
//
// 【问题】公众号竞对数据此前只有一条路：用户自备新榜 Key（BEACON_NEWRANK_KEY 是**部署级** env，
// 个人创作者根本不会去买）。于是对绝大多数用户，两个最大平台之一永远显示「数据源未启用」。
//
// 【做法】平台统一配一份 Key，按套餐给每月查询次数；超了如实说「本月额度用完」并指向自备/导入。
// 口径：一次「查询」= 一次真的走服务端通道去拉某个公众号的作品（CollectionRun 里
// scope=rival、platform=wechat、channel 为 server/manual 且 items>0 的行）。空批次不计——
// 那是我们的通道没拿到东西，不该扣用户的额度。
//
// 【为什么 byok 也给】自带 Key 版自带的是**模型** Key，不是数据源 Key；数据源一直是平台的事。
export const WECHAT_PLATFORM_MONTHLY_QUOTA: Record<string, number> = {
  free: 0,
  trial: 30,
  personal: 60,
  byok: 20,
  enterprise: Number.POSITIVE_INFINITY,
};

export type WechatQuotaStatus = {
  /** 平台有没有配 Key。没配 = 这条路对所有人都不存在，界面照旧说「数据源未启用」 */
  configured: boolean;
  plan: string;
  limit: number;
  used: number;
  remaining: number;
};

export function wechatPlatformKeyConfigured(): boolean {
  return !!process.env.BEACON_NEWRANK_KEY?.trim();
}

export async function wechatQuotaStatus(workspaceId: string, now: Date = new Date()): Promise<WechatQuotaStatus> {
  const configured = wechatPlatformKeyConfigured();
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { tenant: { select: { plan: true, planExpiresAt: true } } },
  });
  const plan = effectivePlan(ws?.tenant.plan, ws?.tenant.planExpiresAt, now);
  const limit = WECHAT_PLATFORM_MONTHLY_QUOTA[plan] ?? 0;
  const used = configured
    ? await prisma.collectionRun.count({
        where: {
          workspaceId,
          scope: 'rival',
          platform: 'wechat',
          channel: { in: ['server', 'manual'] },
          items: { gt: 0 },
          ranAt: { gte: beijingStartOfMonth(now) },
        },
      })
    : 0;
  return { configured, plan, limit, used, remaining: Math.max(0, Number.isFinite(limit) ? limit - used : Number.POSITIVE_INFINITY) };
}

/** 这个工作区此刻还能不能用平台代付的公众号通道。 */
export async function canUseWechatPlatformSource(workspaceId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const q = await wechatQuotaStatus(workspaceId);
  if (!q.configured) return { ok: false, reason: '平台未配置公众号数据源' };
  if (q.remaining <= 0) {
    return {
      ok: false,
      reason: q.limit === 0
        ? `当前档位（${q.plan}）不含平台代付的公众号查询，购买标准版后每月 ${WECHAT_PLATFORM_MONTHLY_QUOTA.personal} 次`
        : `本月平台代付的公众号查询额度已用完（${q.used}/${q.limit}），下月 1 日重置；急用可导入 wechat-article-exporter 导出的文件`,
    };
  }
  return { ok: true };
}
