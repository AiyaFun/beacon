import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import {
  normalizeAiConfig,
  applyFnParams,
  readPlatformAiConfig,
  writePlatformAiConfig,
  invalidatePlatformConfigCache,
  assertPlatformBudget,
  platformSpendUsd,
} from '@/lib/ops/platform-config';
import { resolveProvider, invalidatePlatformProviderCache } from '@/lib/llm/gateway';
import { QuotaExceededError } from '@/lib/quota';
import { encryptKey } from '@/lib/crypto';

// 全域 AI 配置。验三件会「配了不生效」的事：参数收敛、预算闸只数平台垫付、渠道优先级。

// 每个用例前清干净：per-file 的临时库是**整文件共享**的，上一条用例建的渠道/账单
// 会漏进下一条（第一版就是这么假红的：'平台主力' 活到了下一个用例里）。
beforeEach(async () => {
  invalidatePlatformConfigCache();
  invalidatePlatformProviderCache();
  vi.unstubAllEnvs();
  await prisma.llmCallLog.deleteMany();
  await prisma.platformProvider.deleteMany();
  await prisma.modelProvider.deleteMany();
  await prisma.platformSetting.deleteMany();
});

describe('配置收敛（坏值不许流进调用参数）', () => {
  it('超范围 / NaN / 空串一律回落 null，而不是被当成 0', () => {
    const cfg = normalizeAiConfig({
      functions: {
        scoring: { temperature: 5, timeoutMs: 10 }, // 都超范围
        chat: { temperature: '0.3', timeoutMs: '45000' }, // 字符串数字要能收进来
        generation: { temperature: Number.NaN, timeoutMs: null },
      },
      budget: { dailyUsdCap: -5, monthlyUsdCap: '20' },
    });
    expect(cfg.functions.scoring).toBeUndefined(); // 两个都无效 = 这条不留
    expect(cfg.functions.chat).toEqual({ temperature: 0.3, timeoutMs: 45000 });
    expect(cfg.functions.generation).toBeUndefined();
    expect(cfg.budget.dailyUsdCap).toBeNull(); // 负数不是「0 上限」，是没配
    expect(cfg.budget.monthlyUsdCap).toBe(20);
  });

  it('温度 0 是有效值，不能被当成「没配」', () => {
    const cfg = normalizeAiConfig({ functions: { scoring: { temperature: 0 } } });
    expect(cfg.functions.scoring?.temperature).toBe(0);
  });

  it('未知功能名不会被写进配置', () => {
    const cfg = normalizeAiConfig({ functions: { nosuchfn: { temperature: 1 } } });
    expect(Object.keys(cfg.functions)).toEqual([]);
  });
});

describe('参数覆盖', () => {
  it('没配 = 原样放过调用点的值', () => {
    expect(applyFnParams(undefined, { temperature: 0.7 })).toEqual({ temperature: 0.7 });
    expect(applyFnParams({ temperature: null, timeoutMs: null }, { temperature: 0.7 })).toEqual({ temperature: 0.7 });
  });

  it('配了就覆盖，含温度 0 这个边界', () => {
    expect(applyFnParams({ temperature: 0, timeoutMs: 5000 }, { temperature: 0.9 })).toEqual({ temperature: 0, timeoutMs: 5000 });
  });
});

describe('配置读写与缓存', () => {
  it('写完立刻能读到（写入即失效，不靠 TTL 熬）', async () => {
    await writePlatformAiConfig(
      { functions: { chat: { temperature: 0.2 } }, budget: { dailyUsdCap: 10, monthlyUsdCap: null } },
      'member-1',
    );
    const cfg = await readPlatformAiConfig();
    expect(cfg.functions.chat?.temperature).toBe(0.2);
    expect(cfg.budget.dailyUsdCap).toBe(10);
  });
});

describe('预算闸', () => {
  async function spend(source: string, usd: number) {
    await prisma.llmCallLog.create({
      data: { fn: 'generation', provider: 'p', model: 'm', costUsd: usd, source },
    });
  }

  it('只数平台垫付：用户自带 Key 烧再多也不占平台预算', async () => {
    await spend('byok', 999);
    await spend('mock', 999);
    await spend('unknown', 999); // 历史行同样不算
    invalidatePlatformConfigCache();
    expect(await platformSpendUsd('day')).toBe(0);

    await writePlatformAiConfig({ functions: {}, budget: { dailyUsdCap: 1, monthlyUsdCap: null } }, 'm');
    await expect(assertPlatformBudget()).resolves.toBeUndefined();
  });

  it('平台垫付超过日上限 → 抛 QuotaExceededError，并告诉用户怎么继续', async () => {
    await spend('platform', 2.5);
    await writePlatformAiConfig({ functions: {}, budget: { dailyUsdCap: 2, monthlyUsdCap: null } }, 'm');
    invalidatePlatformConfigCache();

    await expect(assertPlatformBudget()).rejects.toBeInstanceOf(QuotaExceededError);
    await expect(assertPlatformBudget()).rejects.toThrow(/API Key/); // 必须给出自救路径
  });

  it('没设上限 = 不设闸（默认状态不许悄悄拦人）', async () => {
    await spend('platform', 10_000);
    await writePlatformAiConfig({ functions: {}, budget: { dailyUsdCap: null, monthlyUsdCap: null } }, 'm');
    invalidatePlatformConfigCache();
    await expect(assertPlatformBudget()).resolves.toBeUndefined();
  });
});

describe('渠道优先级：租户 BYOK → 平台渠道 → env → Mock', () => {
  async function mkTenantProvider(tenantId: string, label: string, opts: { isDefault?: boolean; routing?: string } = {}) {
    await prisma.modelProvider.create({
      data: {
        tenantId,
        label,
        vendor: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        apiKeyEnc: encryptKey('sk-test'),
        model: 'deepseek-chat',
        isDefault: opts.isDefault ?? false,
        routing: opts.routing ?? '{}',
        status: 'ok',
      },
    });
  }

  async function mkPlatformProvider(label: string, opts: { isDefault?: boolean; enabled?: boolean } = {}) {
    return prisma.platformProvider.create({
      data: {
        label,
        vendor: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        apiKeyEnc: encryptKey('sk-platform'),
        model: 'deepseek-chat',
        isDefault: opts.isDefault ?? false,
        enabled: opts.enabled ?? true,
      },
    });
  }

  it('什么都没有 → Mock（全站不因缺配置而崩）', async () => {
    const p = await resolveProvider(null, 'generation');
    expect(p.mocked).toBe(true);
  });

  it('有平台渠道 → 走平台渠道，而不是 env', async () => {
    vi.stubEnv('BEACON_DEFAULT_LLM_BASE_URL', 'https://env.example.com');
    vi.stubEnv('BEACON_DEFAULT_LLM_API_KEY', 'sk-env');
    await mkPlatformProvider('平台主力', { isDefault: true });
    invalidatePlatformProviderCache();

    const p = await resolveProvider(null, 'generation');
    expect(p.name).toBe('平台主力');
  });

  it('停用的平台渠道不参与选路（停用要真的停用）', async () => {
    await mkPlatformProvider('已停用的', { isDefault: true, enabled: false });
    invalidatePlatformProviderCache();
    const p = await resolveProvider(null, 'generation');
    expect(p.mocked).toBe(true);
  });

  it('租户自带 Key 优先于平台渠道（平台不替已自备 Key 的用户花钱）', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 't', plan: 'personal' } });
    await mkTenantProvider(tenant.id, '我的 Key', { isDefault: true });
    await mkPlatformProvider('平台主力', { isDefault: true });
    invalidatePlatformProviderCache();

    const p = await resolveProvider(tenant.id, 'generation');
    expect(p.name).toBe('我的 Key');
  });

  it('平台渠道的按功能路由生效：指到某功能的那条优先于默认渠道', async () => {
    const def = await mkPlatformProvider('默认渠道', { isDefault: true });
    const special = await mkPlatformProvider('打分专用');
    await prisma.platformProvider.update({
      where: { id: special.id },
      data: { routing: JSON.stringify({ scoring: special.id }) },
    });
    invalidatePlatformProviderCache();

    expect((await resolveProvider(null, 'scoring')).name).toBe('打分专用');
    expect((await resolveProvider(null, 'generation')).name).toBe('默认渠道');
    expect(def.isDefault).toBe(true);
  });
});
