import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { assertLlmQuota, getQuotaStatus, invalidatePlanCache, QuotaExceededError } from '@/lib/quota';

// 「到期降档」如果没人执行，就是个不存在的功能。
// 本项目选的是**懒判断**（lib/pay/plan.ts:effectivePlan，在 lib/quota.ts:planOf 里生效）：
// 不依赖任何 cron —— job 没在跑的话，过期租户会一直白嫖高档配额且无人发现。
// 这个文件验的就是「没有任何 job 参与的前提下，到期真的降档了」。

async function mkTenant(plan: string, planExpiresAt: Date | null) {
  const t = await prisma.tenant.create({ data: { name: '测试租户', plan, planExpiresAt } });
  invalidatePlanCache(t.id);
  return t;
}

// ⚠️ createMany，别退回逐条 create 的循环——用例要造几千条，逐条就是几千个来回，
// 单条用例逼近 15s 默认超时，机器一忙整套测试就红一片（同 tests/quota.test.ts 的说明）。
async function logCalls(tenantId: string, n: number) {
  const row = { tenantId, provider: 'openai', model: 'gpt-4o-mini', fn: 'scoring', mocked: false, costUsd: 0.001 };
  await prisma.llmCallLog.createMany({ data: Array.from({ length: n }, () => ({ ...row })) });
}

const future = () => new Date(Date.now() + 30 * 86_400_000);
const past = () => new Date(Date.now() - 1 * 86_400_000);

beforeEach(async () => {
  await prisma.llmCallLog.deleteMany();
  await prisma.paymentOrder.deleteMany();
  await prisma.tenant.deleteMany();
  vi.unstubAllEnvs();
  vi.stubEnv('BEACON_QUOTA_ENABLED', '1');
});
afterEach(() => vi.unstubAllEnvs());

describe('quota × 套餐到期（懒判断，无需 cron）', () => {
  it('未到期的标准版 → 按 personal 档给额度', async () => {
    const t = await mkTenant('personal', future());
    const s = await getQuotaStatus(t.id);
    expect(s.plan).toBe('personal');
    expect(s.tier).toEqual({ daily: 200, monthly: 3_000 });
  });

  it('🔒 已到期的标准版 → 按 free 档给额度（到期降档真的生效了）', async () => {
    const t = await mkTenant('personal', past());
    const s = await getQuotaStatus(t.id);
    expect(s.plan).toBe('free');
    expect(s.tier).toEqual({ daily: 30, monthly: 300 });
  });

  it('🔒 注册送的试用到期 → 同样降回 free 档（懒判定对 trial 一样生效）', async () => {
    const t = await mkTenant('trial', past());
    const s = await getQuotaStatus(t.id);
    expect(s.plan).toBe('free');
    expect(s.tier).toEqual({ daily: 30, monthly: 300 });
  });

  it('试用期内 → 额度同标准版', async () => {
    const t = await mkTenant('trial', future());
    const s = await getQuotaStatus(t.id);
    expect(s.plan).toBe('trial');
    expect(s.tier).toEqual({ daily: 200, monthly: 3_000 });
  });

  it('🔒 已到期的标准版用满 free 档 → 真的被拦（不是只在展示层降档）', async () => {
    const t = await mkTenant('personal', past());
    await logCalls(t.id, 30); // free 日档 30
    await expect(assertLlmQuota(t.id, 'platform')).rejects.toThrow(QuotaExceededError);
  });

  it('未到期的标准版同样用量 → 放行（对照组：证明上一条不是因为别的原因被拦）', async () => {
    const t = await mkTenant('personal', future());
    await logCalls(t.id, 30);
    await expect(assertLlmQuota(t.id, 'platform')).resolves.toBeUndefined();
  });

  it('🔒 到期边界：恰好到期那一刻按 free 算', async () => {
    const t = await mkTenant('personal', new Date(Date.now() - 1));
    expect((await getQuotaStatus(t.id)).plan).toBe('free');
  });

  it('planExpiresAt=null 的付费租户 → 永不过期（运营手工开通，不该被静默降档）', async () => {
    const t = await mkTenant('personal', null);
    expect((await getQuotaStatus(t.id)).plan).toBe('personal');
    await logCalls(t.id, 30);
    await expect(assertLlmQuota(t.id, 'platform')).resolves.toBeUndefined();
  });

  it('free 租户不受 planExpiresAt 影响', async () => {
    const t = await mkTenant('free', past());
    expect((await getQuotaStatus(t.id)).plan).toBe('free');
  });

  it('🔒 plan 缓存里存的是原始值而不是判定结果 —— 缓存期内跨过到期点也会立刻降档', async () => {
    // 缓存判定结果的话，「缓存期内套餐到期」这一分钟里还会按旧档放行。
    // 这里把到期时间设在 50ms 后，先读一次把缓存热起来，等它跨过到期点再读。
    const t = await mkTenant('personal', new Date(Date.now() + 50));
    expect((await getQuotaStatus(t.id)).plan).toBe('personal'); // 热缓存
    await new Promise((r) => setTimeout(r, 80)); // 跨过到期点（缓存 TTL 是 60s，远没到）
    expect((await getQuotaStatus(t.id)).plan).toBe('free'); // ★ 不用等缓存过期
  });

  it('未到期的付费档 BYOK 走高护栏，不被平台档拦住（自带 Key 不占平台额度）', async () => {
    const t = await mkTenant('personal', future());
    await logCalls(t.id, 200); // 打满 personal 平台档
    await expect(assertLlmQuota(t.id, 'platform')).rejects.toThrow();
    await expect(assertLlmQuota(t.id, 'byok')).resolves.toBeUndefined(); // 护栏 5000
  });

  it('🔒 套餐到期后 BYOK 同样收口到 free 档（2026-07 起 BYOK 权益跟档位走，到期即回落）', async () => {
    const t = await mkTenant('personal', past());
    await logCalls(t.id, 100);
    await expect(assertLlmQuota(t.id, 'platform')).rejects.toThrow();
    await expect(assertLlmQuota(t.id, 'byok')).rejects.toThrow(QuotaExceededError); // free 档 BYOK 限 30/天
  });

  it('dev 缺省不限（零配置开发不被配额打断，这条铁律没被支付改动破坏）', async () => {
    vi.stubEnv('BEACON_QUOTA_ENABLED', '');
    vi.stubEnv('NODE_ENV', 'development');
    const t = await mkTenant('personal', past());
    await logCalls(t.id, 10_000);
    await expect(assertLlmQuota(t.id, 'platform')).resolves.toBeUndefined();
  });
});
