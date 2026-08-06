import { prisma } from './db';
import { log } from './logger';
import { reserveQuota, releaseQuota } from './ratelimit';
import { effectivePlan } from './pay/plan';

// 按租户的 LLM 调用配额（日/月），按 Tenant.plan 分档。
// 只统计 mocked=false 的真实调用 —— Mock 不花钱，dev 无 key 时天然不受限。
//
// 两套数据，各司其职：
//   LlmCallLog 账本 —— 计费/仪表盘的**事实来源**（getQuotaStatus 读它）。
//   准入计数器     —— 放行决策的**闸门**（assertLlmQuota 用它）。
// 为什么不能只用账本：账本要等 LLM 往返（秒级）结束才 INSERT，
// 「读计数 → 调用 → 记账」是个窗口极大的 check-then-act，并发请求会全部
// 读到同一个旧计数而集体放行。计数器在放行前就原子占位，堵的正是这个窗口。

export type QuotaSource = 'platform' | 'byok';

export type QuotaTier = { daily: number; monthly: number };

// 平台 key 分档：平台替用户垫 token 钱，按 plan 收紧。
// 档位体系（2026-07 定价改版）：free / trial（注册送 30 天，额度=标准版）/
//   personal（标准版）/ byok（自带 Key 版，平台 Key 仅 free 档兜底）。
//   enterprise 不再自助售卖，但保留配额档 —— 运营手工写 Tenant.plan 的后门，
//   删了它手工开通的租户会静默落到 free 档（PLATFORM_FALLBACK），坑且难查。
const PLATFORM_TIERS: Record<string, QuotaTier> = {
  free: { daily: 30, monthly: 300 },
  trial: { daily: 200, monthly: 3_000 }, // 试用期 = 标准版同档，完整体验是转化的前提
  personal: { daily: 200, monthly: 3_000 },
  byok: { daily: 30, monthly: 300 }, // 买的是「自带 Key 敞开用」，平台 Key 只给 free 级兜底
  enterprise: { daily: 5_000, monthly: 100_000 },
};

const PLATFORM_FALLBACK: QuotaTier = PLATFORM_TIERS.free; // 未知 plan 按最严档（含已下线的 team）

// 付费/试用租户的 BYOK 护栏：用户自己付 token 费，不设经营性额度，
// 只留一道防跑飞护栏（死循环 / 被盗用烧的是用户自己的钱，仍然该拦）。
const BYOK_TIER: QuotaTier = { daily: 5_000, monthly: 100_000 };

// free 档的 BYOK 收口（¥69 档能成立的前提）：免费档自带 Key 也只有 free 级额度。
// 不收口的话「free + 自带 Key」= 全功能白用，自带 Key 版就没人买了。
// 试用 30 天给的是全量 BYOK 体验（BYOK_TIER），到期回落到这里。
const BYOK_FREE_TIER: QuotaTier = PLATFORM_TIERS.free;

export function tierFor(plan: string, source: QuotaSource): QuotaTier {
  if (source === 'byok') {
    return plan === 'free' || !PLATFORM_TIERS[plan] ? BYOK_FREE_TIER : BYOK_TIER;
  }
  return PLATFORM_TIERS[plan] ?? PLATFORM_FALLBACK;
}

// 开关：显式配置优先，否则生产默认开、开发默认关（保持零配置开发不被打断）
export function quotaEnabled(): boolean {
  const v = process.env.BEACON_QUOTA_ENABLED?.trim().toLowerCase();
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return process.env.NODE_ENV === 'production' || process.env.BEACON_ENV === 'prod';
}

export class QuotaExceededError extends Error {
  readonly code = 'QUOTA_EXCEEDED';
  constructor(message: string) {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

// 超额文案（同一段逻辑在正常路径与 Redis 降级路径各出现一次，抽出来防两处漂移）。
// byok 分两种语义：free 档撞的是「免费档收口」→ 引导购买；付费/试用档撞的是
// 「防跑飞护栏」→ 引导排查（正常人到不了 5000 次/天，到了多半是循环或被盗用）。
function monthlyExceededMsg(plan: string, source: QuotaSource, tier: QuotaTier): string {
  if (source === 'byok') {
    return plan === 'free'
      ? `免费版自带 Key 每月限 ${tier.monthly} 次。购买「自带 Key 版」后不限量使用（防滥用护栏 100,000 次/月）。`
      : `本月 AI 调用次数已达安全上限（${tier.monthly} 次），请联系我们排查是否存在异常调用。`;
  }
  return `本月 AI 调用额度已用尽（${tier.monthly} 次/月）。可升级套餐，或在「设置 · 模型接入」配置自己的 API Key 后不占用平台额度。`;
}

function dailyExceededMsg(plan: string, source: QuotaSource, tier: QuotaTier): string {
  if (source === 'byok') {
    return plan === 'free'
      ? `免费版自带 Key 每日限 ${tier.daily} 次。购买「自带 Key 版」后不限量使用（防滥用护栏 5,000 次/天）。`
      : `今日 AI 调用次数已达安全上限（${tier.daily} 次），请明日再试或联系我们。`;
  }
  return `今日 AI 调用额度已用尽（${tier.daily} 次/天），明日 0 点重置。可升级套餐，或在「设置 · 模型接入」配置自己的 API Key。`;
}

function startOfDay(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonth(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

// plan 短缓存：每次 LLM 调用都查一次 Tenant 不值当。
// 缓存的是**原始** plan + 到期时间，不是判定结果 —— 判定必须在读的时候按当时的钟做，
// 否则「缓存期内套餐到期」这一分钟里还会按旧档放行。
const planCache = new Map<string, { plan: string; planExpiresAt: Date | null; at: number }>();
const PLAN_TTL_MS = 60_000;

// 到期即降档，**懒判断**（lib/pay/plan.ts:effectivePlan）：
// 不依赖任何定时 job —— job 没在跑的话，过期租户会一直白嫖高档配额且无人发现。
// 只要有人读 plan，到期就一定生效。
async function planOf(tenantId: string): Promise<string> {
  const hit = planCache.get(tenantId);
  if (hit && Date.now() - hit.at < PLAN_TTL_MS) return effectivePlan(hit.plan, hit.planExpiresAt);
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { plan: true, planExpiresAt: true } });
  const plan = t?.plan ?? 'free';
  const planExpiresAt = t?.planExpiresAt ?? null;
  planCache.set(tenantId, { plan, planExpiresAt, at: Date.now() });
  return effectivePlan(plan, planExpiresAt);
}

/** 支付兑现后立刻让新套餐生效，不用等缓存过期。 */
export function invalidatePlanCache(tenantId: string): void {
  planCache.delete(tenantId);
}

export type QuotaStatus = {
  plan: string;
  source: QuotaSource;
  tier: QuotaTier;
  dailyUsed: number;
  monthlyUsed: number;
  monthlyCostUsd: number;
  monthlyCostDeepseekCny: number;
};

// 用量快照（可给单位经济仪表盘复用）
export async function getQuotaStatus(tenantId: string, source: QuotaSource = 'platform'): Promise<QuotaStatus> {
  const plan = await planOf(tenantId);
  const [dailyUsed, monthlyAgg, monthlyTokens] = await Promise.all([
    prisma.llmCallLog.count({ where: { tenantId, mocked: false, createdAt: { gte: startOfDay() } } }),
    prisma.llmCallLog.aggregate({
      where: { tenantId, mocked: false, createdAt: { gte: startOfMonth() } },
      _count: { _all: true },
      _sum: { costUsd: true },
    }),
    prisma.llmCallLog.aggregate({
      where: { tenantId, createdAt: { gte: startOfMonth() } },
      _sum: { promptTokens: true, completionTokens: true },
    }),
  ]);

  const pt = monthlyTokens._sum.promptTokens ?? 0;
  const ct = monthlyTokens._sum.completionTokens ?? 0;
  // DeepSeek chat 价格：输入 $0.27/百万 tokens，输出 $1.10/百万 tokens
  // 汇率按 1 USD = 7.25 CNY 估算
  const deepseekUsd = (pt * 0.27 + ct * 1.10) / 1_000_000;
  const monthlyCostDeepseekCny = deepseekUsd * 7.25;

  return {
    plan,
    source,
    tier: tierFor(plan, source),
    dailyUsed,
    monthlyUsed: monthlyAgg._count._all,
    monthlyCostUsd: monthlyAgg._sum.costUsd ?? 0,
    monthlyCostDeepseekCny,
  };
}

// ── AI 消耗账单 ──────────────────────────
// 计费页「消耗账单」卡与退款「是否使用」的透明化来源，都读 LlmCallLog 账本（事实来源，
// 只算 mocked=false 的真实调用——Mock 不花钱）。功能分项按 fn（scoring/generation/advisor/
// compliance/chat/embed）；近 7 日趋势逐日计数。

export type UsageBill = {
  plan: string;
  tier: QuotaTier;
  dailyUsed: number;
  monthlyUsed: number;
  monthlyCostUsd: number;
  monthlyCostDeepseekCny: number;
  byFn: { fn: string; count: number }[]; // 本月按功能分项，降序
  recentDays: { date: string; count: number }[]; // 近 7 日（含今天），按天计数
};

export async function getUsageBill(tenantId: string): Promise<UsageBill> {
  const status = await getQuotaStatus(tenantId, 'platform');

  // 近 7 日窗口（含今天）——用固定的日边界，逐日 count（7 次有界查询，SQLite/PG 通吃）
  const days: { start: Date; end: Date; label: string }[] = [];
  for (let i = 6; i >= 0; i--) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - i);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    days.push({ start, end, label: `${start.getMonth() + 1}/${start.getDate()}` });
  }

  const [byFnRaw, dayCounts] = await Promise.all([
    prisma.llmCallLog.groupBy({
      by: ['fn'],
      where: { tenantId, mocked: false, createdAt: { gte: startOfMonth() } },
      _count: { _all: true },
    }),
    Promise.all(
      days.map((d) =>
        prisma.llmCallLog.count({ where: { tenantId, mocked: false, createdAt: { gte: d.start, lt: d.end } } }),
      ),
    ),
  ]);

  const byFn = byFnRaw
    .map((r) => ({ fn: r.fn, count: r._count._all }))
    .sort((a, b) => b.count - a.count);
  const recentDays = days.map((d, idx) => ({ date: d.label, count: dayCounts[idx] }));

  return {
    plan: status.plan,
    tier: status.tier,
    dailyUsed: status.dailyUsed,
    monthlyUsed: status.monthlyUsed,
    monthlyCostUsd: status.monthlyCostUsd,
    monthlyCostDeepseekCny: status.monthlyCostDeepseekCny,
    byFn,
    recentDays,
  };
}

// ── 准入计数器的 key 与生存期 ──────────────────────────
// key 按「租户 + 周期」分桶，周期滚动即自然换 key（TTL 到点自动回收）。
// 注意计数器**不按 source 分**：账本也不分（LlmCallLog 没记 source），
// 一次调用就是一次调用；分档只体现在拿去比的 limit 上。

function dayKey(tenantId: string): string {
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  return `quota:llm:${tenantId}:d:${d.getFullYear()}-${m}-${`${d.getDate()}`.padStart(2, '0')}`;
}

function monthKey(tenantId: string): string {
  const d = new Date();
  return `quota:llm:${tenantId}:m:${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}`;
}

// 计数器活到本周期结束再多留 1 小时（容忍时钟漂移），之后重新从账本播种。
// 必须取整：Redis 的 PX 只吃整数毫秒，浮点会直接报错。
function msUntil(end: Date): number {
  return Math.floor(Math.max(60_000, end.getTime() - Date.now() + 3600_000));
}

function endOfDay(): Date {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d;
}

function endOfMonth(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 1);
}

// 调用前校验。超额抛 QuotaExceededError（中文文案可直接展示给用户）。
// tenantId 为 null 的系统级调用（如广播轨热榜打分）不归属任何租户，跳过。
//
// 放行 = 在日/月两个计数器上各原子占一个名额。月度先判（与原有语义一致）；
// 月度过了但日度被拦时，把月度那次还回去，否则被拦的请求也会白吃月额度。
export async function assertLlmQuota(tenantId: string | null, source: QuotaSource): Promise<void> {
  if (!tenantId || !quotaEnabled()) return;

  const plan = await planOf(tenantId);
  const tier = tierFor(plan, source);

  // 账本只用来给计数器播种（key 首次出现时用一次），不参与放行判断
  const [dailySeed, monthlySeed] = await Promise.all([
    prisma.llmCallLog.count({ where: { tenantId, mocked: false, createdAt: { gte: startOfDay() } } }),
    prisma.llmCallLog.count({ where: { tenantId, mocked: false, createdAt: { gte: startOfMonth() } } }),
  ]);

  const mk = monthKey(tenantId);
  const dk = dayKey(tenantId);

  let month: { ok: boolean; used: number };
  let day: { ok: boolean; used: number };
  let monthReserved = false;
  try {
    month = await reserveQuota(mk, monthlySeed, tier.monthly, msUntil(endOfMonth()));
    if (!month.ok) {
      throw new QuotaExceededError(monthlyExceededMsg(plan, source, tier));
    }
    monthReserved = true;
    day = await reserveQuota(dk, dailySeed, tier.daily, msUntil(endOfDay()));
  } catch (err) {
    if (err instanceof QuotaExceededError) throw err;
    // 月度名额已占、日度这一步却炸了 → 必须归还，否则这个名额**永久泄漏**：
    // 调用根本没发生所以账本里没有对应记录，仪表盘看不见，却实实在在占着本月配额。
    // Redis 抖动期间每次都漏一个的话，用户会被一个「显示还有余量」的闸门拦死。
    // 归还本身也可能因 Redis 未恢复而失败，吞掉即可——下面的账本直读判定不依赖它。
    if (monthReserved) await releaseQuota(mk).catch(() => {});
    // 计数器存储（Redis）故障 → 降级回账本直读判定。
    // 这里**不 fail-close**：与限流闸门不同，放行的最坏情况是**有界**的
    // （账本仍在拦稳态超额，只是重新出现并发窗口，overshoot ≈ 并发数），
    // 而 fail-close 会让全租户的 AI 功能在 Redis 抖动时集体下线。
    // 有界的多花几次 vs 无界的功能下线 —— 取前者。
    log.error('配额准入计数器异常，降级为账本直读（并发窗口重新出现）', { err, tenantId, plan });
    if (monthlySeed >= tier.monthly) {
      throw new QuotaExceededError(monthlyExceededMsg(plan, source, tier));
    }
    if (dailySeed >= tier.daily) {
      throw new QuotaExceededError(dailyExceededMsg(plan, source, tier));
    }
    return;
  }

  if (!day.ok) {
    await releaseQuota(mk); // 日度拦下了，月度那个名额得还回去
    throw new QuotaExceededError(dailyExceededMsg(plan, source, tier));
  }
}

// 与 assertLlmQuota 对称的归还：把占掉的「日 + 月」名额各还一个。
// 口径（VERIFICATION.md §二·2b，方案①「调用失败不占名额」）：
// 真实 provider 失败降级 Mock 时，账本只记 mocked=false 所以不涨，名额却已被占 ——
// 不还的话，全降级 N 次后仪表盘显示 0/N 却被拦死。
// 底层 release（lib/ratelimit.ts）进程内与 Redis 路径都防御性不减到负数、
// key 不存在/已过期则 no-op；Redis 路径无真实例，Lua 与 reserve 同风格但未实测。
export async function releaseLlmQuota(tenantId: string | null): Promise<void> {
  if (!tenantId || !quotaEnabled()) return; // 跳过条件与 assertLlmQuota 一致：没占过就没得还
  await Promise.all([releaseQuota(dayKey(tenantId)), releaseQuota(monthKey(tenantId))]);
}
