import { DAY_MS } from './plan';
import { TRIAL_DAYS } from './pricing';

// 试用期运营节奏：把「注册即送 30 天」从一个静默倒计时，变成有里程碑、有进度、
// 临期有提醒的转化动线。**纯函数**，不碰 DB、不读时钟（now 由调用方注入），可完整单测。
//
// 诚实口径：一切从 planExpiresAt 反推，不写死、不假设注册日；试用被人工延期时，
// 进度自然跟着到期日走，不会显示一个和真实到期日对不上的假天数。

export type TrialMilestone = { day: number; label: string; reached: boolean };

export type TrialProgress = {
  isTrial: boolean; // 当前是否处于「试用中且未过期」——只有 true 时才该渲染卡片
  dayNumber: number; // 试用第几天（1..TRIAL_DAYS，向上钳位）
  totalDays: number; // = TRIAL_DAYS
  remaining: number; // 剩余天数（>=0）
  pct: number; // 进度百分比（0..100）
  nearingEnd: boolean; // 剩余 <=5 天：该把续费入口顶上来
  milestones: TrialMilestone[];
};

// 三个里程碑对应试用期的三段心智：上手 → 第一周见效 → 临期看产出决定续费。
const MILESTONES: { day: number; label: string }[] = [
  { day: 1, label: '建人设 · 起第一篇稿' },
  { day: 7, label: '第一周复盘 · 看数据回流' },
  { day: 25, label: '看本月产出账本 · 决定续费' },
];

const NEAR_END_DAYS = 5;

function ceilDays(ms: number): number {
  return Math.ceil(ms / DAY_MS);
}

/**
 * 计算试用进度。仅当 plan==='trial' 且未过期时 isTrial=true。
 * 其余情况（免费/付费/已过期/无到期日）返回一个 isTrial=false 的空壳，调用方据此不渲染卡片。
 */
export function trialProgress(
  plan: string | null | undefined,
  planExpiresAt: Date | null | undefined,
  now: Date = new Date(),
): TrialProgress {
  const empty: TrialProgress = {
    isTrial: false,
    dayNumber: 0,
    totalDays: TRIAL_DAYS,
    remaining: 0,
    pct: 0,
    nearingEnd: false,
    milestones: MILESTONES.map((m) => ({ ...m, reached: false })),
  };

  if (plan !== 'trial' || !planExpiresAt) return empty;
  const remainingMs = planExpiresAt.getTime() - now.getTime();
  if (remainingMs <= 0) return empty; // 已过期：不再是「试用中」，交给到期提示处理

  // 剩余天数向上取整（还剩几小时也算「还有 1 天」，不显示 0 天却还没过期的矛盾态）
  const remaining = Math.max(0, Math.min(TRIAL_DAYS, ceilDays(remainingMs)));
  // 已过天数 = 总天数 - 剩余；第几天 = 已过 + 1，钳到 [1, TRIAL_DAYS]
  const elapsed = TRIAL_DAYS - remaining;
  const dayNumber = Math.max(1, Math.min(TRIAL_DAYS, elapsed + 1));
  const pct = Math.max(0, Math.min(100, Math.round((elapsed / TRIAL_DAYS) * 100)));

  return {
    isTrial: true,
    dayNumber,
    totalDays: TRIAL_DAYS,
    remaining,
    pct,
    nearingEnd: remaining <= NEAR_END_DAYS,
    milestones: MILESTONES.map((m) => ({ ...m, reached: dayNumber >= m.day })),
  };
}
