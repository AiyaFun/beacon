import { DAY_MS } from './plan';
import { isPaidPlan, PRICING } from './pricing';

// 到期/续费提醒的**纯函数决策层**。不碰 DB、不读时钟（now 由调用方注入）。
//
// 为什么必须有这个功能：手动续费模式（微信 Native 扫码，不做委托代扣）下，
// 到期是**静默**发生的——effectivePlan 懒判断一到点就按 free 算，用户第二天点生成
// 只会看到「今日额度已用尽」，没有任何人告诉过他该续费。而 legal/payment 的付费协议里
// 白纸黑字写着「到期前系统会通过邮件/微信/站内信提醒续费」——在本文件存在之前，
// 那是一句代码撑不住的承诺。
//
// 口径：
//   · 只对**有到期日**的档位提醒。planExpiresAt=null 语义是「永不过期」（运营手工开通），
//     给它发提醒等于骚扰。
//   · trial 一并覆盖：它不是付费档，但它会过期，且到期转化正是试用的意义。
//   · 买断（99 年）自然落在 7 天窗口外，不会触发——不需要特判。
//   · 过期后只在 EXPIRED_GRACE_DAYS 内提醒一次。过期一个月还在催是骚扰，
//     而且那时用户早已在产品里看到降档了。

export type ExpiryStage = 'd7' | 'd3' | 'd1' | 'expired';

export type ExpiryNotice = {
  stage: ExpiryStage;
  daysLeft: number; // 剩余天数（向上取整；到期后为 0 或负）
  isTrial: boolean;
  planName: string; // 展示名：标准版 / 自带 Key 版 / 试用
  title: string;
  body: string;
  /** 去重键。含到期时刻 ⇒ 用户一续费，refId 换新，下一周期照常提醒。 */
  refId: string;
};

// 触发阈值（剩余天数 ≤ 该值即到点）。刻意用「≤」而不是「== N」：
// 定时任务漏跑一天（worker 重启/机器维护）在 == 判据下会把那一档**永久跳过**，
// 而这类静默漏发正是「测试全绿但用户没收到」的典型形态。
const STAGES: { stage: ExpiryStage; maxDaysLeft: number }[] = [
  { stage: 'expired', maxDaysLeft: 0 },
  { stage: 'd1', maxDaysLeft: 1 },
  { stage: 'd3', maxDaysLeft: 3 },
  { stage: 'd7', maxDaysLeft: 7 },
];

export const EXPIRED_GRACE_DAYS = 7;

function planDisplayName(plan: string): string {
  if (plan === 'trial') return '试用';
  if (isPaidPlan(plan)) return PRICING[plan].name;
  return plan; // enterprise 等运营手工档：如实用原字符串，不猜一个好听的名字
}

export function daysLeftOf(planExpiresAt: Date, now: Date): number {
  return Math.ceil((planExpiresAt.getTime() - now.getTime()) / DAY_MS);
}

/**
 * 该租户此刻**应该发哪一档**提醒；没有则 null。
 *
 * @param sentStages 已发过的档（调用方从 Notification.refId 反查），保证同一周期每档只发一次。
 *                   只发**最紧急的未发档**：剩 2 天的用户没收到过 d7 时，补发 d7 毫无意义。
 */
export function expiryNoticeFor(input: {
  plan: string | null | undefined;
  planExpiresAt: Date | null | undefined;
  now: Date;
  sentStages?: ExpiryStage[];
}): ExpiryNotice | null {
  const plan = input.plan ?? 'free';
  const { planExpiresAt, now } = input;
  if (plan === 'free' || !planExpiresAt) return null;

  const daysLeft = daysLeftOf(planExpiresAt, now);
  // 过期太久：不再提醒（宽限窗内的「已到期」提醒只发一次，由 sentStages 保证）
  if (daysLeft < -EXPIRED_GRACE_DAYS) return null;

  const sent = new Set(input.sentStages ?? []);
  // 先定「此刻处在哪一档」（STAGES 按紧急度降序，第一个命中的就是当前档），
  // 再看它发过没有。
  // ⚠️ 反例（第一版就是这么写错的，被幂等用例抓住）：直接找「第一个未发过的到点档」
  // 会在发完 d3 的第二天回头补发 d7 —— 剩 2 天却收到「还剩 7 天」，比不发更糟。
  const due = STAGES.find((s) => daysLeft <= s.maxDaysLeft);
  if (!due || sent.has(due.stage)) return null;

  const isTrial = plan === 'trial';
  const planName = planDisplayName(plan);
  const refId = `plan-expiry:${planExpiresAt.toISOString()}:${due.stage}`;

  if (due.stage === 'expired') {
    return {
      stage: 'expired',
      daysLeft,
      isTrial,
      planName,
      refId,
      title: isTrial ? '试用已到期，已回落免费版' : `${planName}已到期，已回落免费版`,
      // 明说数据还在——这是用户此刻最担心的事，也是续费转化的前提。
      body: '你的账号、人设记忆、历史作品与数据都完整保留，续费后立即恢复原有额度与自动化任务。',
    };
  }

  const dayWord = daysLeft <= 1 ? '今天' : `还有 ${daysLeft} 天`;
  return {
    stage: due.stage,
    daysLeft,
    isTrial,
    planName,
    refId,
    title: isTrial ? `试用${daysLeft <= 1 ? '今天到期' : `还剩 ${daysLeft} 天`}` : `${planName}${daysLeft <= 1 ? '今天到期' : `还剩 ${daysLeft} 天`}`,
    body: isTrial
      ? `${dayWord}到期。到期后自动回落免费版（AI 额度大幅下降，自动化任务停跑），数据不会丢。看一眼这些天的产出账本再决定要不要续。`
      : `${dayWord}到期。手动续费，到期不自动扣款；到期后回落免费版，数据不会丢。`,
  };
}

/** 从 Notification.refId 列表里反解出「这一周期已发过哪些档」。 */
export function sentStagesFrom(refIds: (string | null)[], planExpiresAt: Date): ExpiryStage[] {
  const prefix = `plan-expiry:${planExpiresAt.toISOString()}:`;
  const out: ExpiryStage[] = [];
  for (const r of refIds) {
    if (!r || !r.startsWith(prefix)) continue;
    const stage = r.slice(prefix.length) as ExpiryStage;
    if (STAGES.some((s) => s.stage === stage)) out.push(stage);
  }
  return out;
}
