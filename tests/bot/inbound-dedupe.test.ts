import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '@/lib/db';
import { writeBotSecrets } from '@/lib/bot';
import { markSeen, __resetSeen } from '@/lib/bot/seen';

// 平台超时重推（飞书 3s / 企微 5s / 钉钉）此前只有微信客服挡了。飞书那条路的注释写着
// 「操作皆幂等」——对话烧额度、派任务起运行、试采，一个都不幂等。同一条消息 id 只处理一次。

const handled: string[] = [];
vi.mock('@/lib/bot/router', () => ({
  handleInbound: async (_ws: string, text: string) => { handled.push(text); return 'ok'; },
}));
const { POST } = await import('@/app/api/bot/feishu/events/[key]/route');

const KEY = 'cli_dedupe';
beforeEach(async () => {
  handled.length = 0;
  __resetSeen();
  await prisma.tenant.deleteMany({});
  await prisma.tenant.create({ data: { id: 't1', name: 'T', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: 'W' } });
  await prisma.botIntegration.create({
    data: { workspaceId: 'w1', provider: 'feishu', label: 'B', inboundKey: KEY, secretsEnc: writeBotSecrets({ verificationToken: 'vt' }), pushEvents: '[]' },
  });
});

function feishuText(messageId: string, text: string) {
  return {
    header: { event_type: 'im.message.receive_v1', token: 'vt' },
    event: {
      sender: { sender_id: { open_id: 'ou_1' } },
      message: { message_id: messageId, chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }) },
    },
  };
}
async function post(body: unknown) {
  const req = new Request(`http://localhost/api/bot/feishu/events/${KEY}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return POST(req, { params: Promise.resolve({ key: KEY }) });
}
const settle = () => new Promise((r) => setTimeout(r, 30));

describe('markSeen', () => {
  it('第一次 true、再见 false；按集成隔离', () => {
    expect(markSeen('a', 'm1')).toBe(true);
    expect(markSeen('a', 'm1')).toBe(false);
    expect(markSeen('b', 'm1')).toBe(true);
  });
  it('有界：超过 500 条后最早的被忘掉（不是无限长大）', () => {
    for (let i = 0; i < 501; i++) markSeen('c', `m${i}`);
    expect(markSeen('c', 'm0')).toBe(true);
    expect(markSeen('c', 'm500')).toBe(false);
  });
});

describe('飞书重推', () => {
  it('同一条 message_id 推两次 → 只处理一次；不同 id 照常各处理', async () => {
    await post(feishuText('om_1', '帮我写一篇笔记'));
    await post(feishuText('om_1', '帮我写一篇笔记'));
    await post(feishuText('om_2', '今天有什么热点'));
    await settle();
    expect(handled).toEqual(['帮我写一篇笔记', '今天有什么热点']);
  });
});

describe('🔒 三条回调路都接了去重（写了没接的守卫）', () => {
  it.each([
    ['app/api/bot/feishu/events/[key]/route.ts', /markSeen\(integration\.id, `feishu:\$\{msgId\}`\)/],
    ['app/api/bot/wecom/events/[key]/route.ts', /markSeen\(integration\.id, `wecom:\$\{msgId\}`\)/],
    ['app/api/bot/dingtalk/events/[key]/route.ts', /markSeen\(integration\.id, `dingtalk:\$\{msgId\}`\)/],
  ])('%s', (file, re) => {
    expect(readFileSync(join(process.cwd(), file), 'utf8')).toMatch(re);
  });
  it('微信客服的 markSeen 与三条路是同一份实现', () => {
    expect(readFileSync(join(process.cwd(), 'lib/bot/wechat-kf.ts'), 'utf8')).toMatch(/export \{ markSeen \} from '\.\/seen'/);
  });
});
