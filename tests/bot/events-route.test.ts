import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { writeBotSecrets } from '@/lib/bot';
import { POST } from '@/app/api/bot/feishu/events/[key]/route';

// 飞书事件端点：URL 校验握手 / token 校验 / 未知 app 404 / 消息事件快速 ack。
// 直接调用 route handler（它就是个函数），不需要起服务器。

const KEY = 'cli_testapp';

beforeEach(async () => {
  await prisma.tenant.deleteMany({});
  await prisma.tenant.create({ data: { id: 't1', name: 'T', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: 'W' } });
  await prisma.botIntegration.create({
    data: {
      workspaceId: 'w1',
      provider: 'feishu',
      label: '测试机器人',
      inboundKey: KEY,
      secretsEnc: writeBotSecrets({ verificationToken: 'vt-1' }), // 不设 encryptKey/appSecret → 明文、无回复网络
      pushEvents: '[]',
    },
  });
});

function post(key: string, body: unknown) {
  const req = new Request(`http://localhost/api/bot/feishu/events/${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ key }) });
}

describe('POST /api/bot/feishu/events/[key]', () => {
  it('URL 校验握手 → 回 challenge', async () => {
    const res = await post(KEY, { type: 'url_verification', challenge: 'ch-123', token: 'vt-1' });
    expect(res.status).toBe(200);
    expect((await res.json()).challenge).toBe('ch-123');
  });

  it('URL 校验 token 不符 → 401', async () => {
    const res = await post(KEY, { type: 'url_verification', challenge: 'x', token: 'WRONG' });
    expect(res.status).toBe(401);
  });

  it('未知 app_id → 404', async () => {
    const res = await post('cli_unknown', { type: 'url_verification', challenge: 'x', token: 'vt-1' });
    expect(res.status).toBe(404);
  });

  it('事件 token 不符 → ack 401 码（不处理）', async () => {
    const res = await post(KEY, { header: { event_type: 'im.message.receive_v1', token: 'WRONG' }, event: {} });
    expect(res.status).toBe(200); // 快速 ack（避免飞书重推），码位表明拒绝
    expect((await res.json()).code).toBe(401);
  });

  it('文本消息事件 → 快速 ack code 0', async () => {
    const res = await post(KEY, {
      header: { event_type: 'im.message.receive_v1', token: 'vt-1' },
      event: { message: { message_type: 'text', chat_id: 'oc_1', content: JSON.stringify({ text: '/帮助' }) } },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).code).toBe(0);
  });

  it('非消息事件 → 静默 ack', async () => {
    const res = await post(KEY, { header: { event_type: 'im.chat.member.bot.added_v1', token: 'vt-1' }, event: {} });
    expect(res.status).toBe(200);
  });
});
