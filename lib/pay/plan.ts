import { dailyFenOf, isLifetime, isPaidPlan, PRICING, type PaidPlan, type PeriodMonths } from './pricing';
import { fmtDateFull } from '../format';

// 套餐到期与续费/升档折算。**纯函数**，不碰 DB、不读时钟（now 由调用方注入）。

export const DAY_MS = 86_400_000;

/**
 * 到期后按 free 算 —— **懒判断**。
 *
 * 为什么是懒判断而不是定时 job 降档：
 *   job 只要没真的在跑（cron 挂了 / 忘了配 / worker 没起），过期用户就一直白嫖高档配额，
 *   而且**没有任何人会发现** —— 这正是「测试全绿但功能不存在」的典型形态。
 *   懒判断的正确性不依赖任何外部调度器：只要有人读 plan，到期就一定生效。
 * 代价是每次读 plan 多一次比较，可以忽略。
 *
 * planExpiresAt 为 null 的语义：**永不过期**（运营手工开通/内部租户）。
 * 这不是漏洞面：能写 Tenant.plan 的人本来就已经越过了所有付费闸门；
 * 而把 null 当「已过期」会让运营手工开通的租户在下一次读 plan 时被静默降档。
 */
export function effectivePlan(plan: string | null | undefined, planExpiresAt: Date | null | undefined, now = new Date()): string {
  const p = plan ?? 'free';
  if (p === 'free') return 'free';
  if (!planExpiresAt) return p; // 无到期日 = 永不过期
  return planExpiresAt.getTime() > now.getTime() ? p : 'free';
}

/** 套餐是否已过期（free 档永远返回 false —— 免费档没有「过期」这回事）。 */
export function isPlanExpired(plan: string | null | undefined, planExpiresAt: Date | null | undefined, now = new Date()): boolean {
  const p = plan ?? 'free';
  if (p === 'free' || !planExpiresAt) return false;
  return planExpiresAt.getTime() <= now.getTime();
}

/** 加 N 个自然月，并对月末做钳位（1月31日 + 1月 = 2月28/29日，而不是 JS 默认的 3月3日）。 */
export function addMonths(d: Date, n: number): Date {
  const r = new Date(d.getTime());
  const day = r.getDate();
  r.setDate(1);
  r.setMonth(r.getMonth() + n);
  const lastDay = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
  r.setDate(Math.min(day, lastDay));
  return r;
}

export type GrantInput = {
  currentPlan: string;
  currentExpiresAt: Date | null;
  newPlan: PaidPlan;
  periodMonths: PeriodMonths;
  now?: Date;
};

export type GrantResult = {
  newExpiresAt: Date;
  /**
   * 本单**发放**了多少天（客服解释口径，恒为正）。参照点按情形不同，这是有意的：
   *   fresh / upgrade —— 从 now 起算：本单换来了多少天的新档。
   *   renew           —— 从原到期日起算：本单在原有基础上**追加**了多少天。
   * 反例（第一版就是这么写错的）：升档时若拿「新到期日 - 旧到期日」当发放天数，
   * 个人版剩 200 天升团队版 1 个月会算出 **-126 天** —— 因为 200 天个人版的残值
   * 只折得到 43 天团队版，日期确实往前挪了。那个负数不是 bug 而是口径选错：
   * 用户真正得到的是「74 天团队版」，不是「-126 天」。
   */
  grantedDays: number;
  bonusDays: number; // 升档折算补偿的天数（同档续费恒为 0）
  mode: 'renew' | 'upgrade' | 'fresh';
};

/**
 * 计算兑现后的到期时间。三种情形（**这三条都是产品决策，需用户复核**）：
 *
 *  1. fresh   —— 当前是 free / 已过期：从 now 起算 N 个月。
 *  2. renew   —— 同档且未过期：**叠加**（从原到期日往后加 N 个月）。
 *                提前续费不该被惩罚，GitHub / Vercel 都是这么做的。
 *  3. upgrade —— 换更高档且未过期：**按金额折算**（Stripe proration 式）。
 *                旧档剩余价值（剩余天数 × 旧档日单价）换算成新档天数，加到新周期上。
 *                作废剩余会鼓励用户拖到到期才升档（延迟收入）；剩余时长原样带过去则是白送。
 *
 * 降档（在高档有效期内买低档）不走这里 —— 由 assertCanPurchase 直接拒绝，理由见那里。
 */
export function computeGrant(i: GrantInput): GrantResult {
  const now = i.now ?? new Date();
  const active = !isPlanExpired(i.currentPlan, i.currentExpiresAt, now) && i.currentExpiresAt !== null && isPaidPlan(i.currentPlan);

  // 情形 0：永久买断（99 年）—— 一律从 now 起算 addMonths(now, 1188)，不走续费/升档折算。
  // 99 年远大于任何残值，叠加/折算既无意义又会算出诡异日期；直接给到「99 年后的具体到期日」，
  // 语义上等同 fresh。买断是终态购买，之后不会再有更高档可升。
  if (isLifetime(i.periodMonths)) {
    const newExpiresAt = addMonths(now, i.periodMonths);
    return { newExpiresAt, grantedDays: daysBetween(now, newExpiresAt), bonusDays: 0, mode: 'fresh' };
  }

  // 情形 2：同档续费 —— 从原到期日叠加
  if (active && i.currentPlan === i.newPlan) {
    const base = i.currentExpiresAt!;
    const newExpiresAt = addMonths(base, i.periodMonths);
    return {
      newExpiresAt,
      grantedDays: daysBetween(base, newExpiresAt),
      bonusDays: 0,
      mode: 'renew',
    };
  }

  // 情形 3：升档 —— 旧档剩余价值折算成新档天数
  if (active && i.currentPlan !== i.newPlan) {
    const remainingMs = Math.max(0, i.currentExpiresAt!.getTime() - now.getTime());
    const remainingDays = remainingMs / DAY_MS;
    const residualFen = remainingDays * dailyFenOf(i.currentPlan);
    const bonusDays = Math.floor(residualFen / dailyFenOf(i.newPlan));
    const newExpiresAt = new Date(addMonths(now, i.periodMonths).getTime() + bonusDays * DAY_MS);
    return {
      newExpiresAt,
      // 从 now 起算：本单换来了多少天新档（= 买的 N 个月 + 旧档残值折算的 bonusDays）。
      // ⚠️ 注意这意味着**升档可能让到期日期提前**（200 天个人版 → 74 天团队版），
      // 因为贵档同样的钱买到的天数更少。这是按金额折算的必然结果，UI 必须让用户看见。
      grantedDays: daysBetween(now, newExpiresAt),
      bonusDays,
      mode: 'upgrade',
    };
  }

  // 情形 1：全新 / 已过期 —— 从 now 起算
  const newExpiresAt = addMonths(now, i.periodMonths);
  return { newExpiresAt, grantedDays: daysBetween(now, newExpiresAt), bonusDays: 0, mode: 'fresh' };
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

/**
 * 能不能买这一单。**降档在高档有效期内被拒绝**。
 *
 * 为什么拒绝而不是按金额折算：团队版剩 300 天的用户买 1 个月个人版，按金额折算会换来
 * ~1400 天个人版（¥5990 残值 ÷ 个人版日单价）。这在算术上是「公道」的，
 * 但没有哪个 SaaS 会让用户这么操作，而且它把一次点击变成了不可逆的四年期变更。
 * 让它到期后自然降档、或走人工客服，是更小的惊吓。**这是产品决策，需用户复核。**
 */
export function assertCanPurchase(i: { currentPlan: string; currentExpiresAt: Date | null; newPlan: PaidPlan; periodMonths?: number; now?: Date }): void {
  const now = i.now ?? new Date();
  if (effectivePlan(i.currentPlan, i.currentExpiresAt, now) === 'enterprise') {
    throw new Error(`当前为企业版，暂不支持自助购买${PRICING[i.newPlan].name}，如需变更套餐请联系商务。`);
  }
  // 永不过期的付费租户（planExpiresAt = null，运营手工开通/内部租户，见 effectivePlan 注释）
  // 一律不许自助购买。原因是**会把权益变小**：computeGrant 里 active 要求 currentExpiresAt !== null，
  // 所以这类租户走的是 fresh 分支 —— 买一个月就把「永不过期」改写成「一个月后到期」，
  // 权益被无声地降级且没有任何残值补偿。与 enterprise 同样交给人工处理，不猜用户意图。
  // 放在 lifetime 早返回之前：买断同样会把 null 写成一个具体日期，同属改写权益。
  // isPlanExpired(plan, null) 恒为 false（null = 永不过期），故这里只需判 null。
  if (isPaidPlan(i.currentPlan) && i.currentExpiresAt === null) {
    throw new Error(
      `当前 ${PRICING[i.currentPlan as PaidPlan].name} 为永久有效（无到期日），自助购买会把它改成有期限的套餐。` +
        `如需变更套餐请联系客服处理。`,
    );
  }
  // 永久买断始终放行（终态购买）：即便当前 personal 有效，也允许买断 byok。
  // 买断不是「降档」——它是一次付清换永久，降档拦截的「拖到到期再升档」顾虑在这里不成立。
  if (i.periodMonths !== undefined && isLifetime(i.periodMonths)) return;
  const expiresAt = i.currentExpiresAt;
  // 走到这里 expiresAt 为 null 只可能是 free（付费+null 已在上面抛掉），一并放行
  if (expiresAt === null || isPlanExpired(i.currentPlan, expiresAt, now) || !isPaidPlan(i.currentPlan)) {
    return; // free / 已过期，随便买
  }
  if (i.currentPlan === i.newPlan) return; // 续费
  if (dailyFenOf(i.newPlan) < dailyFenOf(i.currentPlan)) {
    throw new Error(
      `当前 ${PRICING[i.currentPlan as PaidPlan].name} 仍在有效期内（至 ${fmtDateFull(expiresAt)}），` +
        `不能直接降档到${PRICING[i.newPlan].name}。可等当前套餐到期后再购买，或联系客服处理。`,
    );
  }
}
