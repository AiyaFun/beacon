import { prisma } from '../db';
import { parseJson, toJson } from '../json';
import { LLM_FUNCTIONS, type LlmFunction } from '../constants';
import { QuotaExceededError } from '../quota';
import { beijingStartOfDay, beijingStartOfMonth } from '../beijing';
import { createLogger } from '../logger';

const log = createLogger({ module: 'platform-config' });

// ── 全域 AI 配置：平台侧的一份，管所有租户 ──────────────────────────────────
//
// 【它修的是什么】此前平台默认模型只存在于 env（BEACON_DEFAULT_LLM_*、BEACON_VISION_LLM_*），
// 于是三件事做不到：
//   ① 换模型要改 env + 重启容器，运维台上什么都看不见；
//   ② 每个功能的温度/超时全写死在调用点，想给「打分」调低温度就得改代码；
//   ③ 平台垫付的钱没有任何闸——一个死循环能把整月预算烧光，而没有人会在当天发现。
//
// 现在：渠道进 PlatformProvider 表、参数与预算进 PlatformSetting（本文件）、
// 用量看板读 LlmCallLog.source='platform'。env 保留为**兜底**：库还没建表/还没配时
// 不能让全站 AI 一起哑掉。优先级在 lib/llm/gateway.ts：租户 BYOK → 平台渠道 → env → Mock。

export const AI_CONFIG_KEY = 'ai.config';

export type PlatformFnParams = {
  /** 采样温度。null/缺省 = 用调用点自己传的值（不覆盖） */
  temperature?: number | null;
  /** 单次请求超时（毫秒）。null/缺省 = provider 默认 30s */
  timeoutMs?: number | null;
};

export type PlatformAiConfig = {
  functions: Partial<Record<LlmFunction, PlatformFnParams>>;
  budget: {
    /** 平台垫付的每日花费上限（美元）。null = 不设闸 */
    dailyUsdCap: number | null;
    /** 平台垫付的每月花费上限（美元）。null = 不设闸 */
    monthlyUsdCap: number | null;
  };
};

export const DEFAULT_AI_CONFIG: PlatformAiConfig = {
  functions: {},
  budget: { dailyUsdCap: null, monthlyUsdCap: null },
};

/** 把任意 JSON 收敛成合法配置：坏值一律回落默认，绝不把 NaN/负数/字符串放进调用参数。 */
export function normalizeAiConfig(raw: unknown): PlatformAiConfig {
  const src = (raw ?? {}) as Partial<PlatformAiConfig>;
  const functions: PlatformAiConfig['functions'] = {};
  for (const fn of LLM_FUNCTIONS) {
    const p = src.functions?.[fn];
    if (!p) continue;
    const temperature = numOrNull(p.temperature, 0, 2);
    const timeoutMs = numOrNull(p.timeoutMs, 1_000, 600_000);
    if (temperature === null && timeoutMs === null) continue;
    functions[fn] = { temperature, timeoutMs };
  }
  return {
    functions,
    budget: {
      dailyUsdCap: numOrNull(src.budget?.dailyUsdCap, 0, 1_000_000),
      monthlyUsdCap: numOrNull(src.budget?.monthlyUsdCap, 0, 1_000_000),
    },
  };
}

function numOrNull(v: unknown, min: number, max: number): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

// 短缓存：每次 LLM 调用都读一次 PlatformSetting 不值当（与 lib/quota.ts 的 plan 缓存同思路）。
// 缓存的是配置本身，判定仍在读的时候做。写入即失效，不靠 TTL 熬——
// 「改了配置要等一分钟才生效」在运维台上会被当成没保存成功，然后再点一次。
const CACHE_TTL_MS = 60_000;
let cache: { value: PlatformAiConfig; at: number } | null = null;

export function invalidatePlatformConfigCache(): void {
  cache = null;
  spendCache.clear();
}

export async function readPlatformAiConfig(): Promise<PlatformAiConfig> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key: AI_CONFIG_KEY } });
    const value = normalizeAiConfig(parseJson<unknown>(row?.value, {}));
    cache = { value, at: Date.now() };
    return value;
  } catch (err) {
    // 表还没建（生产手动建表前）不该让全站 AI 一起挂：回落默认配置，照常走 env 兜底。
    log.warn('读平台配置失败，回落默认', { err: (err as Error).message });
    return DEFAULT_AI_CONFIG;
  }
}

export async function writePlatformAiConfig(cfg: PlatformAiConfig, memberId: string): Promise<PlatformAiConfig> {
  const value = normalizeAiConfig(cfg);
  await prisma.platformSetting.upsert({
    where: { key: AI_CONFIG_KEY },
    create: { key: AI_CONFIG_KEY, value: toJson(value), updatedBy: memberId },
    update: { value: toJson(value), updatedBy: memberId },
  });
  invalidatePlatformConfigCache();
  return value;
}

// ── 平台预算闸 ──────────────────────────────────────────────────────────────
//
// 只拦**平台垫付**的调用（source='platform'）。BYOK 烧的是用户自己的钱，
// 平台没有理由替他省，也没有理由用平台预算把他拦死。

const spendCache = new Map<'day' | 'month', { usd: number; at: number }>();
const SPEND_TTL_MS = 30_000;

/** 平台垫付的花费（美元）。period=day 按北京时间当日，month 按北京时间当月。 */
export async function platformSpendUsd(period: 'day' | 'month'): Promise<number> {
  const hit = spendCache.get(period);
  if (hit && Date.now() - hit.at < SPEND_TTL_MS) return hit.usd;
  const since = period === 'day' ? beijingStartOfDay() : beijingStartOfMonth();
  const agg = await prisma.llmCallLog.aggregate({
    _sum: { costUsd: true },
    where: { source: 'platform', createdAt: { gte: since } },
  });
  const usd = agg._sum.costUsd ?? 0;
  spendCache.set(period, { usd, at: Date.now() });
  return usd;
}

/**
 * 平台预算闸。超了抛 QuotaExceededError——**刻意复用配额那个类**，
 * 因为全站 action 层已经把它转成结构化提示（tests/action-designed-error.test.ts 钉死了这条），
 * 新造一个错误类型等于要求几十个调用点各自再 catch 一遍，那才是真正会漏的地方。
 *
 * 拦住的用户该怎么办：配自己的 Key（BYOK 不受平台预算约束）。文案必须把这条说出来，
 * 否则用户只知道「不能用了」，不知道有一条马上能走通的路。
 */
export async function assertPlatformBudget(): Promise<void> {
  const cfg = await readPlatformAiConfig();
  const { dailyUsdCap, monthlyUsdCap } = cfg.budget;
  if (dailyUsdCap === null && monthlyUsdCap === null) return; // 不设闸是默认状态

  if (monthlyUsdCap !== null) {
    const spent = await platformSpendUsd('month');
    if (spent >= monthlyUsdCap) {
      throw new QuotaExceededError(
        '平台本月的模型预算已用尽。在「接入与密钥」配置你自己的 API Key 即可继续使用（不占平台预算）。',
        'platform',
      );
    }
  }
  if (dailyUsdCap !== null) {
    const spent = await platformSpendUsd('day');
    if (spent >= dailyUsdCap) {
      // scope 是 platform 而不是 daily：这道闸虽然也按日重置，但它是**全平台共享**的一个池子。
      // 标成 daily 会让所有撞墙的后台执行都挂起等 0 点，然后在 0 点集中醒来、瞬间把新预算
      // 再烧光一次（踩踏）。而用户手上有一条当场就能走通的路（配自己的 Key），
      // 如实判死并把这条路说出来，比挂一夜再失败一次强。
      throw new QuotaExceededError(
        '平台今日的模型预算已用尽，明日 0 点（北京时间）重置。在「接入与密钥」配置你自己的 API Key 即可立即继续使用。',
        'platform',
      );
    }
  }
}

/** 调用参数：平台配置里配了就覆盖调用点传的值，没配就原样放过。 */
export function applyFnParams(
  params: PlatformFnParams | undefined,
  opts: { temperature?: number; timeoutMs?: number } | undefined,
): { temperature?: number; timeoutMs?: number } {
  const out = { ...(opts ?? {}) };
  if (params?.temperature !== null && params?.temperature !== undefined) out.temperature = params.temperature;
  if (params?.timeoutMs !== null && params?.timeoutMs !== undefined) out.timeoutMs = params.timeoutMs;
  return out;
}
