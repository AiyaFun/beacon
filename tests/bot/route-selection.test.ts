import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { prisma } from '@/lib/db';
import { writeBotSecrets, testPush } from '@/lib/bot';

// 回归测试：出站选路。
//
// 真实事故：一条集成同时存了 webhookUrl（旧群机器人）和 inboundKey（自建应用），
// 旧实现是 `webhookUrl ? webhook : app`，webhook 无条件优先 —— 于是自建应用配置从没被用过。
// 群机器人被停用后返回 19007 Bot Not Enabled，整条推送断掉，
// 而界面徽标仍显示「双向全能 (自建应用)」，排查方向被彻底带偏。
//
// 现在的口径必须与徽标一致：有 inboundKey 且凭据齐备 → 走自建应用。

const HOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/dead-bot';

function mockFetch() {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    // 模拟那个已停用的群机器人
    if (url.includes('/bot/v2/hook/')) return { ok: true, status: 200, json: async () => ({ code: 19007, msg: 'Bot Not Enabled' }) } as any;
    if (url.includes('tenant_access_token')) return { ok: true, status: 200, json: async () => ({ code: 0, tenant_access_token: 't' }) } as any;
    if (url.includes('/im/v1/chats')) return { ok: true, status: 200, json: async () => ({ code: 0, data: { items: [{ chat_id: 'oc_1' }] } }) } as any;
    return { ok: true, status: 200, json: async () => ({ code: 0 }) } as any;
  }));
  return calls;
}

async function seed(opts: { webhookUrl?: string | null; inboundKey?: string | null; secrets?: object }) {
  await prisma.tenant.deleteMany({});
  await prisma.tenant.create({ data: { id: 't1', name: 'T', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: 'W' } });
  const row = await prisma.botIntegration.create({
    data: {
      workspaceId: 'w1',
      provider: 'feishu',
      label: '飞书',
      webhookUrl: opts.webhookUrl ?? null,
      inboundKey: opts.inboundKey ?? null,
      secretsEnc: writeBotSecrets(opts.secrets ?? {}),
      pushEvents: '[]',
    },
  });
  return row.id;
}

afterEach(() => vi.unstubAllGlobals());

describe('出站选路 · 自建应用优先于残留 webhook', () => {
  it('两者并存 + 凭据齐备 → 走自建应用，完全不碰那个已停用的 webhook', async () => {
    const calls = mockFetch();
    const id = await seed({ webhookUrl: HOOK, inboundKey: 'cli_x', secrets: { appSecret: 's' } });

    const r = await testPush(id, 'w1');

    expect(r.ok).toBe(true);
    expect(calls.some((u) => u.includes('/im/v1/messages'))).toBe(true);
    expect(calls.some((u) => u.includes('/bot/v2/hook/'))).toBe(false); // 关键：死 webhook 一次都不该被调用
  });

  it('只有 webhook → 照常走 webhook（没有 inboundKey 时行为不变）', async () => {
    const calls = mockFetch();
    const id = await seed({ webhookUrl: HOOK });

    const r = await testPush(id, 'w1');

    expect(r.ok).toBe(false);
    expect(r.error).toContain('Bot Not Enabled');
    expect(calls.some((u) => u.includes('/bot/v2/hook/'))).toBe(true);
  });

  it('有 inboundKey 但缺 App Secret → 退回 webhook（不能因为选路把能用的通道也弄断）', async () => {
    const calls = mockFetch();
    const id = await seed({ webhookUrl: HOOK, inboundKey: 'cli_x', secrets: {} });

    await testPush(id, 'w1');

    expect(calls.some((u) => u.includes('/bot/v2/hook/'))).toBe(true);
    expect(calls.some((u) => u.includes('/im/v1/messages'))).toBe(false);
  });

  it('只有自建应用 → 走自建应用', async () => {
    const calls = mockFetch();
    const id = await seed({ inboundKey: 'cli_x', secrets: { appSecret: 's' } });

    const r = await testPush(id, 'w1');

    expect(r.ok).toBe(true);
    expect(calls.some((u) => u.includes('/im/v1/messages'))).toBe(true);
  });

  it('两者都没有 → 明确报错，不静默', async () => {
    mockFetch();
    const id = await seed({});
    const r = await testPush(id, 'w1');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('未配置');
  });
});
