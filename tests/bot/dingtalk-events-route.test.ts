import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { prisma } from '@/lib/db';
import { writeBotSecrets } from '@/lib/bot';
import { POST } from '@/app/api/bot/dingtalk/events/[key]/route';

// 钉钉企业内部机器人回调端点：验签 / 未知 app 404 / 文本消息快速 ack。

const KEY = 'dingtest123';
const SECRET = 'my-app-secret';

beforeEach(async () => {
  await prisma.tenant.deleteMany({});
  await prisma.tenant.create({ data: { id: 't1', name: 'T', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: 'W' } });
  await prisma.botIntegration.create({
    data: {
      workspaceId: 'w1',
      provider: 'dingtalk',
      label: '钉钉测试',
      inboundKey: KEY,
      secretsEnc: writeBotSecrets({ appSecret: SECRET }),
      pushEvents: '[]',
    },
  });
});

function makeSign(timestamp: string, secret: string): string {
  const str = `${timestamp}\n${secret}`;
  return crypto.createHmac('sha256', secret).update(str).digest('base64');
}

function post(key: string, body: unknown, headers: Record<string, string> = {}) {
  const req = new Request(`http://localhost/api/bot/dingtalk/events/${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ key }) });
}

describe('POST /api/bot/dingtalk/events/[key]', () => {
  it('未知 key → 404', async () => {
    const res = await post('unknown_key', {}, {});
    expect(res.status).toBe(404);
  });

  it('验签失败 → 401', async () => {
    const res = await post(KEY, { msgtype: 'text', text: { content: '/帮助' } }, {
      timestamp: '1700000000000',
      sign: 'wrong-sign',
    });
    expect(res.status).toBe(401);
  });

  it('验签正确 + 文本消息 → 200', async () => {
    const ts = '1700000000000';
    const sign = makeSign(ts, SECRET);
    const res = await post(KEY, {
      msgtype: 'text',
      text: { content: '/帮助' },
      sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession',
    }, { timestamp: ts, sign });
    expect(res.status).toBe(200);
  });

  it('非文本消息 → 静默 ack', async () => {
    const ts = '1700000000000';
    const sign = makeSign(ts, SECRET);
    const res = await post(KEY, { msgtype: 'image' }, { timestamp: ts, sign });
    expect(res.status).toBe(200);
  });

  it('空内容 → 静默 ack', async () => {
    const ts = '1700000000000';
    const sign = makeSign(ts, SECRET);
    const res = await post(KEY, {
      msgtype: 'text',
      text: { content: '  ' },
    }, { timestamp: ts, sign });
    expect(res.status).toBe(200);
  });
});
