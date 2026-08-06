import { DAY_MS } from './plan';
import { isLifetime } from './pricing';

// 退款金额口径（**纯函数**，不碰 DB、不读时钟——now 由调用方注入，便于单测）。
//
// 产品口径（用户已确认）：
//   ① 未消耗任何真实 AI 次数 → 全额退（full）。
//   ② 已消耗 && 非买断 → 按「已过天数」折算，退**剩余天数**对应金额（prorated）。
//   ③ 已消耗 && 永久买断 → 不走自助（manual），引导客服。
//      原因：买断总时长 ~36135 天，用 1 天也只扣 1/36135，按天折算永远近全额，
//      会被「买断→当天狂用→自助全退」薅穿。买断只在**未消耗**时允许自助全退。
//
// 折算基准是「本单实际发放天数 grantedDays」与「距到期的剩余天数」，
// 与兑现审计口径一致（grantedDays 由 fulfillOrder 落库，含升档折算的补偿天）。

export type RefundKind = 'full' | 'prorated' | 'manual';

export type RefundPolicy = {
  kind: RefundKind;
  refundFen: number; // 应退金额（分），manual 时为 0
  totalDays: number; // 本单发放天数
  usedDays: number; // 已消耗（已过）天数
  remainingDays: number; // 剩余天数（折算依据）
  consumedCount: number; // 本单生效窗口内的真实 AI 调用次数
  reason: string; // 面向用户的口径说明
};

export type RefundableOrder = {
  amountFen: number;
  periodMonths: number;
  grantedDays: number | null;
  paidAt: Date | null;
  newPlanExpiresAt: Date | null;
};

/** 距到期还剩多少天（向上取整，最少 0）。 */
function remainingDaysOf(newPlanExpiresAt: Date | null, now: Date): number {
  if (!newPlanExpiresAt) return 0;
  return Math.max(0, Math.ceil((newPlanExpiresAt.getTime() - now.getTime()) / DAY_MS));
}

export function refundPolicyFor(order: RefundableOrder, consumedCount: number, now: Date = new Date()): RefundPolicy {
  const totalDays = order.grantedDays ?? 0;
  const remainingDays = remainingDaysOf(order.newPlanExpiresAt, now);
  const usedDays = Math.max(0, totalDays - remainingDays);

  // ① 未消耗 → 全额退（买断在未消耗时同样全额退）
  if (consumedCount <= 0) {
    return {
      kind: 'full',
      refundFen: order.amountFen,
      totalDays,
      usedDays: 0,
      remainingDays: totalDays,
      consumedCount: 0,
      reason: '未消耗任何 AI 次数，可全额退款。',
    };
  }

  // ③ 已消耗 && 永久买断 → 转人工（防按天折算被薅）
  if (isLifetime(order.periodMonths)) {
    return {
      kind: 'manual',
      refundFen: 0,
      totalDays,
      usedDays,
      remainingDays,
      consumedCount,
      reason: '永久买断已开始使用，不支持自助退款，请联系客服核对处理。',
    };
  }

  // 折算基准异常（无发放天数/总天数为 0）→ 稳妥转人工，绝不算出错误金额
  if (totalDays <= 0) {
    return {
      kind: 'manual',
      refundFen: 0,
      totalDays,
      usedDays,
      remainingDays,
      consumedCount,
      reason: '订单发放天数异常，无法自动折算，请联系客服处理。',
    };
  }

  // ② 已消耗 && 非买断 → 按剩余天数折算
  const raw = Math.round((order.amountFen * remainingDays) / totalDays);
  const refundFen = Math.min(order.amountFen, Math.max(0, raw));
  return {
    kind: 'prorated',
    refundFen,
    totalDays,
    usedDays,
    remainingDays,
    consumedCount,
    reason: `已使用 ${usedDays} 天、剩余 ${remainingDays} 天。按剩余天数折算，可退 ¥${(refundFen / 100).toFixed(2)}。`,
  };
}
