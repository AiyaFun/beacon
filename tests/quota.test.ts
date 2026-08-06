import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '@/lib/db';
import { encryptKey } from '@/lib/crypto';
import { llmComplete } from '@/lib/llm/gateway';
import {
  tierFor,
  quotaEnabled,
  assertLlmQuota,
  releaseLlmQuota,
  getQuotaStatus,
  getUsageBill,
  QuotaExceededError,
} from '@/lib/quota';

// LLM 配额。计数复用 LlmCallLog 账本（不另起计数器），只统计 mocked=false 的真实调用。
// 走真 SQLite：要验的正是「按 mocked/时间窗过滤后 count 出来的数」是否正确。

// 假的 OpenAI 兼容端点（固定成功回复）：给「正常成功调用照常扣额」类用例当真实 provider。
// 监听 0 端口由系统分配，避免与并行测试文件抢端口。
const liveSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [{ message: { content: '真实端点的回复' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
  });
});
await new Promise<void>((r) => liveSrv.listen(0, '127.0.0.1', r));
const livePort = (liveSrv.address() as AddressInfo).port;
afterAll(() => liveSrv.close());

const useLiveProvider = () => {
  vi.stubEnv('BEACON_DEFAULT_LLM_BASE_URL', `http://127.0.0.1:${livePort}/v1`);
  vi.stubEnv('BEACON_DEFAULT_LLM_API_KEY', 'test-key');
};

// 端口 1 必然连不上：模拟真实 provider 全挂（llmComplete 会降级 Mock）
const useDeadProvider = () => {
  vi.stubEnv('BEACON_DEFAULT_LLM_BASE_URL', 'http://127.0.0.1:1/v1');
  vi.stubEnv('BEACON_DEFAULT_LLM_API_KEY', 'test-key');
};

async function mkTenant(plan = 'free') {
  return prisma.tenant.create({ data: { name: `${plan} 租户`, plan } });
}

// 直接种账本记录（模拟已发生的调用）
// ⚠️ 必须用 createMany 一次写入，不要退回逐条 create 的循环。
// 防跑飞护栏的用例要造 5000 条调用记录，逐条 create 就是 5000 个来回：
// 单条用例耗时 14.6s，而默认超时 15s——机器稍有负载就翻车，
// 于是整套测试隔三差五红一片，真正的失败反而被淹没（2026-07-28 连着三轮误报）。
// createMany 一条语句写完，同样是 5000 行，测的东西一点没变。
async function logCalls(tenantId: string, n: number, opts: { mocked?: boolean; at?: Date } = {}) {
  const row = {
    tenantId,
    provider: 'openai',
    model: 'gpt-4o-mini',
    fn: 'scoring',
    mocked: opts.mocked ?? false,
    costUsd: 0.001,
    ...(opts.at ? { createdAt: opts.at } : {}),
  };
  await prisma.llmCallLog.createMany({ data: Array.from({ length: n }, () => ({ ...row })) });
}

beforeEach(async () => {
  await prisma.llmCallLog.deleteMany();
  await prisma.tenant.deleteMany();
  vi.unstubAllEnvs();
});

afterEach(() => vi.unstubAllEnvs());

describe('quota · tierFor 分档', () => {
  it('平台 key 按 plan 分档（2026-07 定价改版：trial=标准版同档，byok 只给 free 级兜底）', () => {
    expect(tierFor('free', 'platform')).toEqual({ daily: 30, monthly: 300 });
    expect(tierFor('trial', 'platform')).toEqual({ daily: 200, monthly: 3_000 });
    expect(tierFor('personal', 'platform')).toEqual({ daily: 200, monthly: 3_000 });
    expect(tierFor('byok', 'platform')).toEqual({ daily: 30, monthly: 300 });
    expect(tierFor('enterprise', 'platform')).toEqual({ daily: 5_000, monthly: 100_000 });
  });

  it('未知 plan 回退最严档（free）—— 脏数据/已下线的 team 不该换来更高额度', () => {
    expect(tierFor('bogus', 'platform')).toEqual({ daily: 30, monthly: 300 });
    expect(tierFor('', 'platform')).toEqual({ daily: 30, monthly: 300 });
    expect(tierFor('team', 'platform')).toEqual({ daily: 30, monthly: 300 }); // 已下线
  });

  it('🔒 free 档自带 Key 收口到 free 级额度 —— 这是「自带 Key 版」能卖出去的前提', () => {
    expect(tierFor('free', 'byok')).toEqual({ daily: 30, monthly: 300 });
    expect(tierFor('bogus', 'byok')).toEqual({ daily: 30, monthly: 300 });
    expect(tierFor('team', 'byok')).toEqual({ daily: 30, monthly: 300 }); // 已下线同样收口
  });

  it('付费/试用档自带 Key 走高护栏（烧的是自己的钱，只防跑飞）', () => {
    expect(tierFor('byok', 'byok')).toEqual({ daily: 5_000, monthly: 100_000 });
    expect(tierFor('personal', 'byok')).toEqual({ daily: 5_000, monthly: 100_000 });
    expect(tierFor('trial', 'byok')).toEqual({ daily: 5_000, monthly: 100_000 });
  });

  it('BYOK 仍有防跑飞护栏，不是无限', () => {
    expect(tierFor('enterprise', 'byok').daily).toBeLessThan(Infinity);
  });

  it('档位单调：free=byok 兜底 < trial=personal < enterprise', () => {
    expect(tierFor('personal', 'platform').daily).toBeGreaterThan(tierFor('free', 'platform').daily);
    expect(tierFor('enterprise', 'platform').daily).toBeGreaterThan(tierFor('personal', 'platform').daily);
    expect(tierFor('byok', 'platform')).toEqual(tierFor('free', 'platform'));
    expect(tierFor('trial', 'platform')).toEqual(tierFor('personal', 'platform'));
  });
});

describe('quota · quotaEnabled 开关', () => {
  it('显式 1/true 开', () => {
    for (const v of ['1', 'true', 'TRUE']) {
      vi.stubEnv('BEACON_QUOTA_ENABLED', v);
      expect(quotaEnabled()).toBe(true);
    }
  });

  it('显式 0/false 关（即使生产态也关）', () => {
    vi.stubEnv('NODE_ENV', 'production');
    for (const v of ['0', 'false']) {
      vi.stubEnv('BEACON_QUOTA_ENABLED', v);
      expect(quotaEnabled()).toBe(false);
    }
  });

  it('缺省时生产开', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(quotaEnabled()).toBe(true);
  });

  it('缺省时 BEACON_ENV=prod 也开', () => {
    vi.stubEnv('BEACON_ENV', 'prod');
    expect(quotaEnabled()).toBe(true);
  });

  it('缺省时开发关（零配置开发不被打断）', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(quotaEnabled()).toBe(false);
  });
});

describe('quota · 计数只认真实调用', () => {
  beforeEach(() => vi.stubEnv('BEACON_QUOTA_ENABLED', '1'));

  it('mocked=true 不计数（Mock 不花钱，dev 无 key 时天然不受限）', async () => {
    const t = await mkTenant('free');
    await logCalls(t.id, 100, { mocked: true });
    const s = await getQuotaStatus(t.id);
    expect(s.dailyUsed).toBe(0);
    await expect(assertLlmQuota(t.id, 'platform')).resolves.toBeUndefined();
  });

  it('mocked=false 计数', async () => {
    const t = await mkTenant('free');
    await logCalls(t.id, 5);
    expect((await getQuotaStatus(t.id)).dailyUsed).toBe(5);
  });

  it('别的租户的调用不计到本租户头上', async () => {
    const [a, b] = [await mkTenant('free'), await mkTenant('free')];
    await logCalls(b.id, 40);
    expect((await getQuotaStatus(a.id)).dailyUsed).toBe(0);
    await expect(assertLlmQuota(a.id, 'platform')).resolves.toBeUndefined();
  });

  it('昨天的调用不计入今日用量', async () => {
    const t = await mkTenant('free');
    await logCalls(t.id, 40, { at: new Date(Date.now() - 25 * 3600_000) });
    expect((await getQuotaStatus(t.id)).dailyUsed).toBe(0);
  });

  it('monthlyCostUsd 汇总账本花费', async () => {
    const t = await mkTenant('personal');
    await logCalls(t.id, 10);
    expect((await getQuotaStatus(t.id)).monthlyCostUsd).toBeCloseTo(0.01, 5);
  });
});

describe('quota · 超额拦截', () => {
  beforeEach(() => vi.stubEnv('BEACON_QUOTA_ENABLED', '1'));

  it('日额度用尽 → 抛 QuotaExceededError', async () => {
    const t = await mkTenant('free');
    await logCalls(t.id, 30); // free 日档 30
    await expect(assertLlmQuota(t.id, 'platform')).rejects.toThrow(QuotaExceededError);
  });

  it('日额度差一次 → 放行（边界不应早拦）', async () => {
    const t = await mkTenant('free');
    await logCalls(t.id, 29);
    await expect(assertLlmQuota(t.id, 'platform')).resolves.toBeUndefined();
  });

  it('超额文案是可直接展示的中文，并给出出路（升套餐 / 配自己的 key）', async () => {
    const t = await mkTenant('free');
    await logCalls(t.id, 30);
    await expect(assertLlmQuota(t.id, 'platform')).rejects.toThrow(/额度已用尽.*升级套餐|模型接入/s);
  });

  it('月额度用尽 → 拦（且月度判定先于日度）', async () => {
    const t = await mkTenant('free');
    await logCalls(t.id, 300, { at: new Date(Date.now() - 5 * 24 * 3600_000) }); // 本月早些时候，非今日
    await expect(assertLlmQuota(t.id, 'platform')).rejects.toThrow(/本月/);
  });

  it('QuotaExceededError.code 供上层区分', async () => {
    const t = await mkTenant('free');
    await logCalls(t.id, 30);
    await assertLlmQuota(t.id, 'platform').catch((e) => {
      expect(e.code).toBe('QUOTA_EXCEEDED');
      expect(e.name).toBe('QuotaExceededError');
    });
  });

  it('高档 plan 用同样次数不被拦', async () => {
    const t = await mkTenant('personal');
    await logCalls(t.id, 30);
    await expect(assertLlmQuota(t.id, 'platform')).resolves.toBeUndefined();
  });
});

describe('quota · BYOK 分档（free 收口 / 付费豁免）', () => {
  beforeEach(() => vi.stubEnv('BEACON_QUOTA_ENABLED', '1'));

  it('付费租户超平台档，但走 BYOK → 放行（自带 Key 不占平台额度）', async () => {
    const t = await mkTenant('personal');
    await logCalls(t.id, 200); // 打满 personal 平台档 200
    await expect(assertLlmQuota(t.id, 'platform')).rejects.toThrow(); // 平台 key 被拦
    await expect(assertLlmQuota(t.id, 'byok')).resolves.toBeUndefined(); // BYOK 放行（护栏 5000）
  });

  it('🔒 free 租户自带 Key 超 30 次/天 → 拦（否则 free+BYOK=全功能白用，自带 Key 版没人买）', async () => {
    const t = await mkTenant('free');
    await logCalls(t.id, 30);
    await expect(assertLlmQuota(t.id, 'byok')).rejects.toThrow(QuotaExceededError);
  });

  it('free 档 BYOK 超额文案引导购买「自带 Key 版」而非「联系排查」', async () => {
    const t = await mkTenant('free');
    await logCalls(t.id, 30);
    await expect(assertLlmQuota(t.id, 'byok')).rejects.toThrow(/自带 Key 版/);
  });

  it('BYOK 超 5000 仍拦（防跑飞护栏真的生效）', async () => {
    const t = await mkTenant('byok');
    await logCalls(t.id, 5_000);
    await expect(assertLlmQuota(t.id, 'byok')).rejects.toThrow(/安全上限/);
  });

  it('付费档 BYOK 超额文案是「安全上限」而非「额度已用尽」（用户自付费，措辞不该像催升级）', async () => {
    const t = await mkTenant('personal');
    await logCalls(t.id, 5_000);
    await expect(assertLlmQuota(t.id, 'byok')).rejects.toThrow(/异常调用|安全上限/);
  });
});

describe('quota · 降级归还名额（调用失败不占名额）', () => {
  beforeEach(() => vi.stubEnv('BEACON_QUOTA_ENABLED', '1'));

  // VERIFICATION.md §二·2b 的复现场景：账本只统计 mocked=false，降级 Mock 后账本不涨、
  // 名额却被扣 —— 30 次全降级后仪表盘 0/30、第 31 次被拦。方案①：失败就归还。
  it('provider 全挂 30 次 → 名额全归还 → 第 31 次真实调用仍被放行', async () => {
    const t = await mkTenant('free'); // 日档 30
    useDeadProvider();
    for (let i = 0; i < 30; i++) {
      const r = await llmComplete(t.id, 'chat', [{ role: 'user', content: `你好 ${i}` }]);
      expect(r.mocked).toBe(true);
      expect(r.degraded).toBe(true); // 降级要如实打标，调用方才能提示「本次为示例内容」
    }
    // 账本只涨 mocked=true：仪表盘用量 0/30，此时名额也必须是满的
    expect((await getQuotaStatus(t.id)).dailyUsed).toBe(0);
    expect(await prisma.llmCallLog.count({ where: { tenantId: t.id, mocked: true } })).toBe(30);
    // provider 恢复后第 31 次真实调用：被放行且照常扣额
    useLiveProvider();
    const ok = await llmComplete(t.id, 'chat', [{ role: 'user', content: '你好' }]);
    expect(ok.mocked).toBe(false);
    expect(ok.degraded).toBeUndefined();
    expect((await getQuotaStatus(t.id)).dailyUsed).toBe(1);
  });

  it('归还不会把计数器减成负数（多余归还不产生额外额度）', async () => {
    const t = await mkTenant('free');
    useDeadProvider();
    await llmComplete(t.id, 'chat', [{ role: 'user', content: '你好' }]); // 占 1 还 1 → 计数器落在 0
    for (let i = 0; i < 5; i++) await releaseLlmQuota(t.id); // 多余归还应停在 0 而不是 -5
    // 若被减成负数，下面就能放行超过 30 次；正确行为是恰好 30 次后被拦
    for (let i = 0; i < 30; i++) await assertLlmQuota(t.id, 'platform');
    await expect(assertLlmQuota(t.id, 'platform')).rejects.toThrow(QuotaExceededError);
  });

  it('正常成功调用照常扣额（成功不归还）', async () => {
    const t = await mkTenant('free');
    await logCalls(t.id, 29);
    useLiveProvider();
    const r = await llmComplete(t.id, 'chat', [{ role: 'user', content: '你好' }]); // 恰好用掉第 30 个名额
    expect(r.mocked).toBe(false);
    expect(r.degraded).toBeUndefined();
    expect((await getQuotaStatus(t.id)).dailyUsed).toBe(30);
    await expect(assertLlmQuota(t.id, 'platform')).rejects.toThrow(QuotaExceededError); // 名额被占住没归还
  });

  it('BYOK 占额后失败同样归还（在防跑飞护栏边界上可观测）', async () => {
    const t = await mkTenant('byok'); // 付费档才有 5000 护栏；free 档 BYOK 已收口到 30/天
    // BYOK 日档 5000：账本垫到 4999，让「占/还一个名额」在边界上可观测
    await prisma.llmCallLog.createMany({
      data: Array.from({ length: 4_999 }, () => ({
        tenantId: t.id,
        provider: 'deepseek',
        model: 'deepseek-chat',
        fn: 'chat',
        mocked: false,
        costUsd: 0.001,
      })),
    });
    await prisma.modelProvider.create({
      data: {
        tenantId: t.id,
        label: '我的 DeepSeek',
        vendor: 'deepseek',
        baseUrl: 'http://127.0.0.1:1/v1', // 必然连不上
        apiKeyEnc: encryptKey('sk-test'),
        model: 'deepseek-chat',
        isDefault: true,
        status: 'ok',
      },
    });
    const r = await llmComplete(t.id, 'chat', [{ role: 'user', content: '你好' }]); // 占第 5000 个名额后失败
    expect(r.degraded).toBe(true);
    // 名额已归还：最后一个名额还能再占一次，之后才被拦
    await expect(assertLlmQuota(t.id, 'byok')).resolves.toBeUndefined();
    await expect(assertLlmQuota(t.id, 'byok')).rejects.toThrow(/安全上限/);
  });
});

describe('quota · 跳过条件', () => {
  it('tenantId 为 null（系统级调用，如广播轨热榜打分）→ 跳过', async () => {
    vi.stubEnv('BEACON_QUOTA_ENABLED', '1');
    await expect(assertLlmQuota(null, 'platform')).resolves.toBeUndefined();
  });

  it('开关关闭 → 不查库直接放行', async () => {
    vi.stubEnv('BEACON_QUOTA_ENABLED', '0');
    const t = await mkTenant('free');
    await logCalls(t.id, 10_000);
    await expect(assertLlmQuota(t.id, 'platform')).resolves.toBeUndefined();
  });

  it('dev 缺省不限（零配置开发不被配额打断）', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const t = await mkTenant('free');
    await logCalls(t.id, 10_000);
    await expect(assertLlmQuota(t.id, 'platform')).resolves.toBeUndefined();
  });
});

describe('quota · getUsageBill 消耗账单', () => {
  async function seedFn(tenantId: string, fn: string, n: number, mocked = false) {
    for (let i = 0; i < n; i++) {
      await prisma.llmCallLog.create({ data: { tenantId, provider: 'openai', model: 'm', fn, mocked, costUsd: 0.002 } });
    }
  }

  it('按功能分项降序，只算真实调用（排除 mocked）', async () => {
    const t = await mkTenant('personal');
    await seedFn(t.id, 'generation', 3);
    await seedFn(t.id, 'scoring', 2);
    await seedFn(t.id, 'chat', 1);
    await seedFn(t.id, 'generation', 5, true); // mocked：不计

    const bill = await getUsageBill(t.id);
    expect(bill.monthlyUsed).toBe(6);
    expect(bill.dailyUsed).toBe(6);
    expect(bill.byFn).toEqual([
      { fn: 'generation', count: 3 },
      { fn: 'scoring', count: 2 },
      { fn: 'chat', count: 1 },
    ]);
    expect(bill.recentDays).toHaveLength(7);
    expect(bill.recentDays[6].count).toBe(6); // 最后一格是今天
  });

  it('无调用 → 空账单不炸', async () => {
    const t = await mkTenant('free');
    const bill = await getUsageBill(t.id);
    expect(bill.monthlyUsed).toBe(0);
    expect(bill.byFn).toEqual([]);
    expect(bill.recentDays).toHaveLength(7);
  });
});
