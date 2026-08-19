import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { encryptKey } from '@/lib/crypto';
import { writeBotSecrets } from '@/lib/bot';

// 一键检测。要钉死的是**它不做什么**：
// 不往用户群里发测试消息、不真出一张图。检测按钮被点一下就花钱/打扰人，比不检测还糟。

const h = vi.hoisted(() => ({
  pings: [] as string[],
  pingOk: true,
  fetches: [] as string[],
}));

vi.mock('@/lib/llm/connectivity', () => ({
  pingProvider: async (p: { label: string }) => {
    h.pings.push(p.label);
    return h.pingOk
      ? { ok: true, status: 'ok', detail: '连通正常' }
      : { ok: false, status: 'failed', detail: '401 invalid api key' };
  },
}));

// 出站请求一律记下来：用来证明「没有发消息、没有出图」
vi.stubGlobal('fetch', async (url: string) => {
  h.fetches.push(String(url));
  return new Response(JSON.stringify({ tenant_access_token: 't', access_token: 't', expires_in: 7200 }), { status: 200 });
});

const { checkTenantConnections } = await import('@/lib/settings/connectivity');

let ctx: { tenantId: string; workspaceId: string; accountId: string };

beforeEach(async () => {
  h.pings = [];
  h.fetches = [];
  h.pingOk = true;
  await prisma.botIntegration.deleteMany();
  await prisma.publishCredential.deleteMany();
  await prisma.modelProvider.deleteMany();

  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  const acc = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, name: '号', platform: 'douyin', personaCard: '{}' },
  });
  ctx = { tenantId: tenant.id, workspaceId: ws.id, accountId: acc.id };
});

describe('什么都没配', () => {
  it('全部报「未配」而不是「不通」——没配不是错误', async () => {
    const { rows } = await checkTenantConnections(ctx);
    const model = rows.find((r) => r.group === 'model')!;
    expect(model.state).toBe('idle');
    expect(rows.find((r) => r.group === 'publish')!.state).toBe('idle');
    expect(rows.find((r) => r.group === 'bot')!.state).toBe('idle');
    // 没配的项要给出「怎么办」，否则用户只知道缺了、不知道去哪补
    expect(model.fix).toBeTruthy();
  });
});

describe('模型渠道', () => {
  async function mkProvider(label: string, model = 'deepseek-chat') {
    return prisma.modelProvider.create({
      data: {
        tenantId: ctx.tenantId, label, vendor: 'deepseek', baseUrl: 'https://api.deepseek.com',
        apiKeyEnc: encryptKey('sk-x'), model, status: 'untested',
      },
    });
  }

  it('逐条 ping，并把结果写回渠道状态（点完检测列表上的小圆点要跟着变）', async () => {
    await mkProvider('主力');
    await mkProvider('备用');
    const { rows } = await checkTenantConnections(ctx);
    expect(h.pings.sort()).toEqual(['主力', '备用']);
    expect(rows.filter((r) => r.group === 'model')).toHaveLength(2);
    const saved = await prisma.modelProvider.findMany();
    expect(saved.every((p) => p.status === 'ok')).toBe(true);
  });

  it('ping 失败 → fail + 怎么办', async () => {
    await mkProvider('坏的');
    h.pingOk = false;
    const { rows } = await checkTenantConnections(ctx);
    const row = rows.find((r) => r.group === 'model')!;
    expect(row.state).toBe('fail');
    expect(row.fix).toBeTruthy();
    expect((await prisma.modelProvider.findFirst())!.status).toBe('failed');
  });

  it('图像/视频模型标成 warn（它没做真对话测试，报「通」是虚报）', async () => {
    await mkProvider('即梦', 'doubao-seedream-4-0-250828');
    const { rows } = await checkTenantConnections(ctx);
    expect(rows.find((r) => r.name.includes('即梦'))!.state).toBe('warn');
  });
});

describe('绝不产生副作用', () => {
  it('生图这一项不发任何出图请求', async () => {
    await prisma.modelProvider.create({
      data: {
        tenantId: ctx.tenantId, label: '方舟', vendor: 'doubao',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        apiKeyEnc: encryptKey('sk-ark'), model: 'doubao-pro-32k', isDefault: true, status: 'ok',
      },
    });
    const { rows } = await checkTenantConnections(ctx);
    const img = rows.find((r) => r.group === 'image')!;
    expect(img.state).toBe('warn');
    expect(img.detail).toContain('不真出图');
    expect(h.fetches.some((u) => u.includes('images/generations'))).toBe(false);
  });

  it('纯 Webhook 机器人不发测试消息，如实说「测不了」', async () => {
    await prisma.botIntegration.create({
      data: {
        workspaceId: ctx.workspaceId, provider: 'feishu', label: '运营群',
        webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx',
        secretsEnc: '{}', enabled: true,
      },
    });
    const { rows } = await checkTenantConnections(ctx);
    const bot = rows.find((r) => r.group === 'bot')!;
    expect(bot.state).toBe('warn');
    expect(bot.detail).toContain('无法静默检测');
    expect(bot.fix).toContain('测试发送');
    // 关键：一条出站消息都没发
    expect(h.fetches.some((u) => u.includes('/hook/'))).toBe(false);
  });

  it('自建应用的机器人只换 token（换 token 无痕，发消息才有痕）', async () => {
    await prisma.botIntegration.create({
      data: {
        workspaceId: ctx.workspaceId, provider: 'feishu', label: '自建应用',
        inboundKey: 'cli_app_id',
        secretsEnc: writeBotSecrets({ appSecret: 's' }),
        enabled: true,
      },
    });
    const { rows } = await checkTenantConnections(ctx);
    expect(rows.find((r) => r.group === 'bot')!.state).toBe('ok');
    expect(h.fetches.some((u) => u.includes('tenant_access_token'))).toBe(true);
    expect(h.fetches.some((u) => u.includes('/messages'))).toBe(false);
  });

  it('停用的机器人不去探（停用了就别再打人家接口）', async () => {
    await prisma.botIntegration.create({
      data: {
        workspaceId: ctx.workspaceId, provider: 'feishu', label: '停用的',
        inboundKey: 'cli_x', secretsEnc: writeBotSecrets({ appSecret: 's' }), enabled: false,
      },
    });
    const { rows } = await checkTenantConnections(ctx);
    expect(rows.find((r) => r.group === 'bot')!.state).toBe('idle');
    expect(h.fetches).toHaveLength(0);
  });
});
