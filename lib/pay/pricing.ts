// 价目表与金额计算。
//
// 🔒 铁律：金额只在服务端算，**永远不读前端传来的金额**。
// 前端只能传 plan + periodMonths（两个枚举），金额由本文件的常量推导。
// 否则改个请求就是 1 分钱买企业版 —— 这类漏洞在支付里是最常见的一种。

export type PaidPlan = 'personal' | 'byok';
// 购买时长枚举。1=月付，12=年付，1188=自带 Key 版永久买断（99 年，见 LIFETIME_MONTHS）。
// 1188 只对 byok 合法（amountFenFor 对 personal+1188 直接抛），isPeriodMonths 只把关「形状」。
export type PeriodMonths = 1 | 12 | 1188;

// 永久买断（99 年 = 1188 个月）。用 periodMonths=1188 承载而非新开字段：
// 它天然流经既有的 PaymentOrder.periodMonths(Int) 与整条兑现链路，零 schema 改动。
// 「99 年」既是文案（永久），也是兑现时写进 planExpiresAt 的具体到期日（computeGrant 买断分支）。
export const LIFETIME_MONTHS = 1188;
// 自带 Key 版永久买断一口价 ¥2999（不是 1188×月价——买断是独立定价，一次付清）。
export const BYOK_LIFETIME_FEN = 299_900;

export function isLifetime(periodMonths: number): boolean {
  return periodMonths === LIFETIME_MONTHS;
}

// 单一版本 + 自带 Key 折扣档（2026-07 定价决策，用户已确认）：
//   personal（标准版）¥129/月 —— 平台垫 AI token 费，200 次/天。
//   byok（自带 Key 版）¥69/月 —— 用户自己出 token 费，平台只收工具钱；
//     让利 ¥60 ≈ 平台垫付的 token 成本，对会配 Key 的技术型用户，心理参照是
//     Notion/剪映这类「纯工具订阅」（¥20-50），¥69 落在可接受区间上沿。
//   团队版/企业版已下线自助购买（2026-07）：企业客户走「联系商务」，
//     运营手工写 Tenant.plan='enterprise'（quota.ts 留了配额档做后门）。
// 年付一律「付 10 个月送 2 个月」。
export const PRICING: Record<PaidPlan, { name: string; monthFen: number; yearFen: number }> = {
  personal: { name: '标准版', monthFen: 12_900, yearFen: 129_000 },
  byok: { name: '自带 Key 版', monthFen: 6_900, yearFen: 69_000 },
};

// 新用户注册即送标准版试用天数（lib/auth.ts:provisionNewUser 写入 plan='trial'）。
// trial 是独立档位字符串而非 personal：它**不是付费档**（isPaidPlan=false），
// 于是天然获得两个正确行为，零特判 ——
//   ① 试用期内买任何档都不触发「降档拦截」（assertCanPurchase 对非付费档直接放行）；
//   ② 购买时按 fresh 从付款日起算，**不做残值折算**（白送的 30 天不能折成钱抵新档天数）。
export const TRIAL_DAYS = 30;

export function isPaidPlan(x: string): x is PaidPlan {
  return x === 'personal' || x === 'byok';
}

export function isPeriodMonths(x: unknown): x is PeriodMonths {
  return x === 1 || x === 12 || x === LIFETIME_MONTHS;
}

/** 应付金额（分）。plan/period 非法直接抛 —— 不给「回退默认价」留缝。 */
export function amountFenFor(plan: string, periodMonths: number): number {
  if (!isPaidPlan(plan)) throw new Error(`不可下单的档位：${plan}`);
  if (!isPeriodMonths(periodMonths)) throw new Error(`不支持的购买时长：${periodMonths} 个月（仅 1 / 12 / 永久买断）`);
  if (isLifetime(periodMonths)) {
    // 买断仅限自带 Key 版：标准版由平台垫 token 费，不能一次买断（否则平台永久亏 token 钱）。
    if (plan !== 'byok') throw new Error(`永久买断仅支持自带 Key 版，${PRICING[plan as PaidPlan].name}不可买断`);
    return BYOK_LIFETIME_FEN;
  }
  return periodMonths === 12 ? PRICING[plan].yearFen : PRICING[plan].monthFen;
}

/** 档位日单价（分/天，可为小数）。仅用于升档折算，取「月价 / 30」为参考基准。 */
export function dailyFenOf(plan: string): number {
  if (!isPaidPlan(plan)) return 0; // free / trial / 未知档位没有残值
  return PRICING[plan].monthFen / 30;
}

/** 商品描述（进用户微信账单）。⚠️ 不能含 emoji：APIv3 只收 1-3 字节 UTF-8。 */
export function descriptionFor(plan: PaidPlan, periodMonths: PeriodMonths): string {
  if (isLifetime(periodMonths)) return `烽火台 ${PRICING[plan].name} 永久买断`;
  return `烽火台 ${PRICING[plan].name} ${periodMonths === 12 ? '年付' : '月付'}`;
}

/** 展示金额（分）：给 UI 用，不参与下单校验（下单金额一律走 amountFenFor 服务端算）。 */
export function displayFenFor(plan: PaidPlan, periodMonths: PeriodMonths): number {
  if (isLifetime(periodMonths)) return BYOK_LIFETIME_FEN;
  return periodMonths === 12 ? PRICING[plan].yearFen : PRICING[plan].monthFen;
}
