import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '@/lib/db';
import { writeBotSecrets, sendToChat, renderPlain } from '@/lib/bot';

// 2026-09-02 盘查抓到的真缺陷：群里派出的任务回执，echoRunToChat 解析出了 chatId
// 却只调集成级 sendToIntegration——飞书自建应用逐群广播、企微 @all、钉钉全员，
// 「你派的任务等你确认」发到机器人所在的所有群；微信两条只答不推的通道则被 routeSend 直接拒，
// 派出去的任务永远回不了「跑完了」。这里钉住：回执走**会话级**接口，且各渠道定点到那个 chatId。

const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
function stubFetch(reply: (url: string, body: any) => unknown) {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body, headers: (init?.headers as Record<string, string>) ?? {} });
    return new Response(JSON.stringify(reply(url, body)), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}
async function bot(provider: string, inboundKey: string | null, secrets: Record<string, unknown>) {
  return prisma.botIntegration.create({
    data: { workspaceId: 'w1', provider, label: provider, inboundKey, secretsEnc: writeBotSecrets(secrets), pushEvents: '[]', enabled: true },
  });
}
const MSG = { kind: 'card' as const, title: '✅ 任务跑完了：写笔记', lines: ['搞定了'], link: { text: '去看看', url: 'https://x/runs/1' } };

beforeEach(async () => {
  calls.length = 0;
  await prisma.tenant.deleteMany({});
  await prisma.tenant.create({ data: { id: 't1', name: 'T', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: 'W' } });
});
afterEach(() => vi.unstubAllGlobals());

describe('sendToChat：按渠道定点到那个会话', () => {
  it('飞书：receive_id=chatId 发到那个群，绝不列群逐群发', async () => {
    const it = await bot('feishu', 'cli_app', { appSecret: 'sec' });
    stubFetch((url) => url.includes('tenant_access_token') ? { tenant_access_token: 'tk' } : { code: 0 });
    const r = await sendToChat('w1', it.id, 'oc_target', MSG);
    expect(r.ok).toBe(true);
    const send = calls.find((c) => c.url.includes('/im/v1/messages'));
    expect(send?.url).toContain('receive_id_type=chat_id');
    expect(send?.body.receive_id).toBe('oc_target');
    expect(calls.some((c) => c.url.includes('/im/v1/chats'))).toBe(false); // 那是广播才要的
  });

  it('企微自建应用：touser=chatId，超长按段发', async () => {
    const it = await bot('wecom', 'ww_1000002', { corpId: 'ww', appSecret: 'sec', agentId: '1000002' });
    stubFetch((url) => url.includes('gettoken') ? { access_token: 'tk' } : { errcode: 0 });
    const long = { kind: 'text' as const, text: '一二三四五六七八九十。'.repeat(80) }; // 880 字 > 600
    const r = await sendToChat('w1', it.id, 'zhangsan', long);
    expect(r.ok).toBe(true);
    const sends = calls.filter((c) => c.url.includes('message/send'));
    expect(sends.length).toBe(2);
    for (const s of sends) {
      expect(s.body.touser).toBe('zhangsan');
      expect(s.body.text.content.length).toBeLessThanOrEqual(600);
    }
  });

  it('钉钉：群（cid…）走 groupMessages/send 带 openConversationId；单聊走 oToMessages/batchSend', async () => {
    const it = await bot('dingtalk', 'dingkey', { appSecret: 'sec' });
    stubFetch((url) => url.includes('gettoken') ? { access_token: 'tk' } : { processQueryKey: 'x' });
    expect((await sendToChat('w1', it.id, 'cidABC==', MSG)).ok).toBe(true);
    const g = calls.find((c) => c.url.includes('groupMessages/send'));
    expect(g?.body.openConversationId).toBe('cidABC==');
    expect(g?.body.robotCode).toBe('dingkey');
    expect(g?.headers['x-acs-dingtalk-access-token']).toBe('tk');
    expect(JSON.parse(g?.body.msgParam).content).toContain('任务跑完了');
    calls.length = 0;
    expect((await sendToChat('w1', it.id, 'staff001', MSG)).ok).toBe(true);
    const p = calls.find((c) => c.url.includes('oToMessages/batchSend'));
    expect(p?.body.userIds).toEqual(['staff001']);
  });

  it('微信客服：走 kf/send_msg 定点到 external_userid（集成级 routeSend 会把它当只答不推拒掉）', async () => {
    const it = await bot('wechat_kf', 'ww_kf', { corpId: 'ww', appSecret: 'sec', openKfId: 'wkXXX' });
    stubFetch((url) => url.includes('gettoken') ? { access_token: 'tk' } : { errcode: 0 });
    const r = await sendToChat('w1', it.id, 'wmUser', MSG);
    expect(r.ok).toBe(true);
    const s = calls.find((c) => c.url.includes('kf/send_msg'));
    expect(s?.body.touser).toBe('wmUser');
    expect(s?.body.open_kfid).toBe('wkXXX');
  });

  it('微信 iLink：挂在最近一条入站的 context_token 上；没有就如实说发不了', async () => {
    const noCtx = await bot('wechat', 'ilink_1', { ilinkBotToken: 'bt', ilinkUserId: 'u@im.wechat' });
    stubFetch(() => ({ ret: 0 }));
    const r0 = await sendToChat('w1', noCtx.id, 'u@im.wechat', MSG);
    expect(r0.ok).toBe(false);
    expect(r0.error).toContain('会话上下文');
    expect(calls.length).toBe(0);

    const withCtx = await bot('wechat', 'ilink_2', { ilinkBotToken: 'bt', ilinkUserId: 'u@im.wechat', ilinkContextToken: 'ctx-latest' });
    const r1 = await sendToChat('w1', withCtx.id, 'u@im.wechat', MSG);
    expect(r1.ok).toBe(true);
    const s = calls.find((c) => c.url.includes('sendmessage'));
    expect(s?.body.msg.context_token).toBe('ctx-latest');
    expect(s?.body.msg.to_user_id).toBe('u@im.wechat');
  });

  it('失败写进 lastError，成功写 lastOutboundAt', async () => {
    const it = await bot('feishu', 'cli_app', { appSecret: 'sec' });
    stubFetch((url) => url.includes('tenant_access_token') ? { code: 99991663, msg: 'bad secret' } : { code: 0 });
    expect((await sendToChat('w1', it.id, 'oc', MSG)).ok).toBe(false);
    const row = await prisma.botIntegration.findUniqueOrThrow({ where: { id: it.id } });
    expect(row.lastError).toContain('回执发送失败');
  });

  it('renderPlain：卡片在纯文本渠道上标题/行/链接各一行', () => {
    expect(renderPlain(MSG)).toBe('✅ 任务跑完了：写笔记\n搞定了\n去看看：https://x/runs/1');
  });
});

describe('🔒 回执与 iLink 上下文的接线', () => {
  it('dispatch.ts 的回执只走 sendToChat，不再 import 集成级 sendToIntegration', () => {
    const src = readFileSync(join(process.cwd(), 'lib/bot/dispatch.ts'), 'utf8');
    expect(src).toMatch(/sendToChat\(run\.workspaceId, ref\.integrationId, ref\.chatId/);
    expect(src).not.toMatch(/sendToIntegration/);
  });
  it('iLink 收信时把 context_token 记进 secrets（否则回执永远没有可挂的上下文）', () => {
    const src = readFileSync(join(process.cwd(), 'lib/bot/wechat-ilink-poller.ts'), 'utf8');
    expect(src).toMatch(/secrets\.ilinkContextToken = contextToken/);
    expect(src).toMatch(/secretsEnc: writeBotSecrets\(secrets\)/);
  });
});
