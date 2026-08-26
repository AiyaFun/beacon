import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { encryptKey } from '@/lib/crypto';
import { resolveProvider } from '@/lib/llm/gateway';
import { invalidatePlatformProviderCache } from '@/lib/llm/platform-providers';

// 执行模式可以单独指一条渠道。
//
// 【为什么要这一项】执行模式对模型的要求与聊天完全不同：它必须稳定地发**结构化工具调用**。
// 2026-08-23 真机实测，平台默认的 MiniMax-Text-01 会把调用写成正文
//（「我这就去建草稿」＋一段 functions.create_draft(...) 文本），而同一条渠道回答问题是够用的。
// 所以要的不是「换掉默认模型」，是「让执行模式能单独指一条更会用工具的渠道」。
//
// 【这一组真正在守的是「零影响」】fn 仍然是 'chat'（它同时是记账口径与 BYOK 的既有路由键），
// 只是选路时多问一句「有没有专门指给 agent 的渠道」。**没配 = 与以前一模一样**——
// 这条要是破了，所有只配了 chat 路由的存量租户会静默换渠道，
// 没配默认渠道的直接落 Mock，而 Mock 在执行器里是硬停 failed。

let tenantId: string;

beforeEach(async () => {
  vi.unstubAllEnvs();
  invalidatePlatformProviderCache();
  await prisma.platformProvider.deleteMany();
  await prisma.modelProvider.deleteMany();
  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  tenantId = tenant.id;
});

/** 建一条租户自己的渠道；routeFns 里的每个功能都指到它自己。 */
async function mkTenant(model: string, opts: { isDefault?: boolean; routeFns?: string[] } = {}) {
  const row = await prisma.modelProvider.create({
    data: {
      tenantId, label: model, vendor: 'doubao',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKeyEnc: encryptKey('sk-t'), model, isDefault: opts.isDefault ?? false,
    },
  });
  if (opts.routeFns?.length) {
    const routing: Record<string, string> = {};
    for (const f of opts.routeFns) routing[f] = row.id;
    await prisma.modelProvider.update({ where: { id: row.id }, data: { routing: JSON.stringify(routing) } });
  }
  return row;
}

async function mkPlatform(model: string, opts: { isDefault?: boolean; routeFns?: string[] } = {}) {
  const row = await prisma.platformProvider.create({
    data: {
      label: model, vendor: 'doubao',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKeyEnc: encryptKey('sk-p'), model, isDefault: opts.isDefault ?? false,
    },
  });
  if (opts.routeFns?.length) {
    const routing: Record<string, string> = {};
    for (const f of opts.routeFns) routing[f] = row.id;
    await prisma.platformProvider.update({ where: { id: row.id }, data: { routing: JSON.stringify(routing) } });
  }
  invalidatePlatformProviderCache();
  return row;
}

describe('🔒 没配 agent 路由时必须与以前完全一致', () => {
  it('只配了 chat 路由的存量租户：执行模式仍然走那条', async () => {
    await mkTenant('弱模型', { isDefault: true });
    await mkTenant('聊天模型', { routeFns: ['chat'] });
    const p = await resolveProvider(tenantId, 'chat', { preferFn: 'agent' });
    expect(p.model, '存量租户被静默换到了别的渠道').toBe('聊天模型');
  });

  it('只有默认渠道、什么路由都没配：还是走默认', async () => {
    await mkTenant('默认模型', { isDefault: true });
    const p = await resolveProvider(tenantId, 'chat', { preferFn: 'agent' });
    expect(p.model).toBe('默认模型');
  });

  it('平台渠道也一样：没指 agent 就跟随默认，不许落 Mock', async () => {
    await mkPlatform('平台默认', { isDefault: true });
    const p = await resolveProvider(null, 'chat', { preferFn: 'agent' });
    expect(p.model, '落到 Mock 了 —— 那在执行器里是硬停 failed').toBe('平台默认');
  });
});

describe('配了 agent 路由才改道', () => {
  it('租户侧：指给 agent 的那条优先于 chat', async () => {
    await mkTenant('聊天模型', { isDefault: true, routeFns: ['chat'] });
    await mkTenant('会用工具的模型', { routeFns: ['agent'] });

    expect((await resolveProvider(tenantId, 'chat', { preferFn: 'agent' })).model).toBe('会用工具的模型');
    // 【同一条 fn，不带 preferFn 就不该改道】普通问答仍然走 chat 那条
    expect((await resolveProvider(tenantId, 'chat')).model, '把普通问答也改道了').toBe('聊天模型');
  });

  it('平台侧：指给 agent 的那条优先于「跟随默认」', async () => {
    await mkPlatform('平台默认', { isDefault: true });
    await mkPlatform('平台强模型', { routeFns: ['agent'] });
    expect((await resolveProvider(null, 'chat', { preferFn: 'agent' })).model).toBe('平台强模型');
    expect((await resolveProvider(null, 'chat')).model, '把普通问答也改道了').toBe('平台默认');
  });

  it('🔒 默认渠道不许把「问一句 agent」这一轮兜住', async () => {
    // 【这条是整套设计的关键】平台侧选路的最后一步是「回落到 isDefault」。
    // 第一轮问 agent 的时候要是也允许回落，默认渠道当场就把它接住了 ——
    // 于是 chat 那条显式路由永远轮不到，preferFn 等于把所有人都换到了默认渠道上。
    await mkPlatform('平台默认', { isDefault: true });
    await mkPlatform('平台聊天', { routeFns: ['chat'] });
    expect((await resolveProvider(null, 'chat', { preferFn: 'agent' })).model,
      'agent 那一轮被默认渠道兜住了，chat 的显式路由被跳过').toBe('平台聊天');
  });

  it('租户自己配了 agent，就轮不到平台渠道（BYOK 永远优先）', async () => {
    await mkPlatform('平台强模型', { isDefault: true, routeFns: ['agent'] });
    await mkTenant('我自己的模型', { routeFns: ['agent'] });
    expect((await resolveProvider(tenantId, 'chat', { preferFn: 'agent' })).model).toBe('我自己的模型');
  });
});

describe('执行器确实在用这个偏好', () => {
  it('主循环那次调用带了 preferFn: agent', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(process.cwd(), 'lib/agent/run.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src, '执行器没带 preferFn —— 那这一项配了也不生效').toMatch(/preferFn:\s*'agent'/);
    // fn 必须还是 chat：它同时是记账口径与 BYOK 的既有路由键
    expect(src, "执行器把 fn 改成了 'agent' —— 存量租户会静默换渠道甚至落 Mock")
      .toMatch(/llmComplete\(ctx\.tenantId,\s*'chat'/);
  });

  it('运维台与租户设置页都摆出了这一项（配不了等于没有）', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const ops = fs.readFileSync(path.join(process.cwd(), 'app/(ops)/ops/ai/page.tsx'), 'utf8');
    const keys = fs.readFileSync(path.join(process.cwd(), 'app/(app)/settings/keys/page.tsx'), 'utf8');
    expect(ops, '运维台没有「执行模式」这个功能位').toMatch(/agent:\s*'/);
    expect(keys, '租户设置页没有「执行模式」这个功能位').toMatch(/agent:\s*\{/);
    expect(keys, '没告诉用户不配会怎样').toMatch(/不配就跟随/);
  });
});

describe('env 兜底也要认这个偏好（生产就是这种形态）', () => {
  // 【为什么这一组不能省】按功能路由是**库里**的能力，而一台什么都没在库里配的机器
  // 全靠 env 兜底——生产恰恰就是这样：PlatformProvider 表是空的，7492 次调用全走 env。
  // 不给 env 一个同形状的出口，「执行模式单独指一条渠道」在最常见的部署形态下等于不存在。
  beforeEach(() => {
    vi.stubEnv('BEACON_DEFAULT_LLM_BASE_URL', 'https://api.example.com/v1');
    vi.stubEnv('BEACON_DEFAULT_LLM_API_KEY', 'sk-env');
    vi.stubEnv('BEACON_DEFAULT_LLM_MODEL', '默认弱模型');
  });

  it('🔒 没配 BEACON_AGENT_LLM_MODEL 就完全照旧', async () => {
    const p = await resolveProvider(null, 'chat', { preferFn: 'agent' });
    expect(p.model, '没配也改道了 —— 存量部署会静默换模型').toBe('默认弱模型');
  });

  it('配了就只在执行模式生效，普通问答不动', async () => {
    vi.stubEnv('BEACON_AGENT_LLM_MODEL', '会用工具的模型');
    expect((await resolveProvider(null, 'chat', { preferFn: 'agent' })).model).toBe('会用工具的模型');
    expect((await resolveProvider(null, 'chat')).model, '把普通问答也换了').toBe('默认弱模型');
  });

  it('只换模型时沿用同一个端点与 Key（最常见的用法，别逼人抄三遍）', async () => {
    vi.stubEnv('BEACON_AGENT_LLM_MODEL', '会用工具的模型');
    const p = await resolveProvider(null, 'chat', { preferFn: 'agent' });
    // 换了名字才好在账本里分得清这次执行走的是哪条
    expect(p.name).toBe('platform-agent');
  });

  it('库里配了渠道的话，轮不到 env（env 只是兜底）', async () => {
    await mkPlatform('平台强模型', { routeFns: ['agent'] });
    expect((await resolveProvider(null, 'chat', { preferFn: 'agent' })).model).toBe('平台强模型');
  });
});
