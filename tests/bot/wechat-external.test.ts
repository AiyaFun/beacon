import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';

// 微信两条通道是**对外渠道**（2026-09-02）：发消息的人不是企业应用认证过的成员。
// lib/auth/oa.ts「敢自动加入」的前提——能私聊到机器人的人已经过了公司 OA 认证——在微信这边不成立。
// 不拦的话：任何微信用户对客服号说一声「登录」→ issueOaLoginTicket 兜底当 feishu → autoJoin 收成成员 + 一次性登录链接。
// 这里用真库验行为，不验源码：拆掉那道闸，第一条就会红（Member 多出一条 feishu:wx-stranger）。

vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async () => ({ text: '（桩）', provider: 'x', model: 'x', mocked: false, promptTokens: 1, completionTokens: 1 }),
}));
vi.mock('@/lib/memory/core', () => ({ buildMemoryContext: async () => '' }));

const { handleInbound } = await import('@/lib/bot/router');
const { resolveDispatcher } = await import('@/lib/bot/dispatch');
const { testPush, writeBotSecrets } = await import('@/lib/bot');
const { toJson } = await import('@/lib/json');

beforeEach(async () => {
  await prisma.tenant.deleteMany({});
  await prisma.tenant.create({ data: { id: 't1', name: '租户', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: 'W' } });
  await prisma.creatorAccount.create({ data: { id: 'a1', workspaceId: 'w1', name: '号', platform: 'douyin', status: 'active' } });
  await prisma.botIntegration.create({
    data: { id: 'kf1', workspaceId: 'w1', provider: 'wechat_kf', label: '微信客服', inboundKey: 'ww1_kf', secretsEnc: '', allowCommands: toJson(['dispatch', 'chat', 'help']) },
  });
  // 微信 iLink：绑定的微信号 u1、绑定成员 m-owner（编辑角色，能派任务）
  await prisma.member.create({ data: { id: 'm-owner', tenantId: 't1', name: '扫码的人', role: 'editor', status: 'active' } });
  await prisma.botIntegration.create({
    data: {
      id: 'il1', workspaceId: 'w1', provider: 'wechat', label: '微信', inboundKey: 'wxilink_b1@im.bot',
      secretsEnc: writeBotSecrets({ ilinkBotToken: 'tok', ilinkBotId: 'b1@im.bot', ilinkUserId: 'u1@im.wechat', boundMemberId: 'm-owner' }),
      allowCommands: toJson(['dispatch', 'chat', 'help']),
    },
  });
});

describe('对外渠道 · 登录/绑定不响应', () => {
  it('🔒 微信客服里说「登录」：拒绝，且**没有**成员被自动加入', async () => {
    const before = await prisma.member.count();
    const reply = await handleInbound('w1', '登录', { provider: 'wechat_kf', integrationId: 'kf1', chatId: 'wx-stranger', senderId: 'wx-stranger', isGroup: false });
    expect(reply).toMatch(/不支持登录|不会凭一条微信消息/);
    expect(reply, '回执里不该出现登录链接').not.toMatch(/magic\?t=/);
    expect(await prisma.member.count(), '陌生微信用户被 autoJoin 收成了成员').toBe(before);
    expect(await prisma.member.findFirst({ where: { oaIdentity: { contains: 'wx-stranger' } } })).toBeNull();
  });

  it('🔒 微信 iLink 里说「登录」：不发链接、不建成员（扫码绑定时人已经登录着）', async () => {
    const before = await prisma.member.count();
    const reply = await handleInbound('w1', '登录', { provider: 'wechat', integrationId: 'il1', chatId: 'u1@im.wechat', senderId: 'u1@im.wechat', isGroup: false });
    expect(reply).toMatch(/不用登录/);
    expect(reply).not.toMatch(/magic\?t=/);
    expect(await prisma.member.count()).toBe(before);
  });

  it('对照：飞书私聊说「登录」仍然走原路（自动加入 + 链接）——闸只拦对外渠道', async () => {
    const reply = await handleInbound('w1', '登录', { provider: 'feishu', integrationId: 'kf1', chatId: 'p2p', senderId: 'ou_new', isGroup: false });
    expect(reply).toMatch(/magic\?t=/);
    expect(await prisma.member.findFirst({ where: { oaIdentity: 'feishu:ou_new' } })).not.toBeNull();
  });
});

describe('对外渠道 · 派任务身份闸', () => {
  it('🔒 resolveDispatcher 对微信 provider 直接拒，不把 external_userid 当 feishu 身份去撞成员表', async () => {
    // 先造一个 oaIdentity 恰好等于 feishu:<同一串> 的成员——若闸没拦、兜底映射成 feishu，这个陌生微信 ID 就会「对上」
    await prisma.member.create({ data: { tenantId: 't1', name: '撞名', role: 'editor', status: 'active', oaIdentity: 'feishu:wx-collide' } });
    const r = await resolveDispatcher('w1', { provider: 'wechat_kf', senderId: 'wx-collide' }, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/无法确认你是哪位成员/);
  });
});

describe('微信 iLink · 派任务身份 = 扫码绑定的成员', () => {
  it('绑定的微信号发来 → 解析到绑定成员（不走 OA 身份表）', async () => {
    const r = await resolveDispatcher('w1', { provider: 'wechat', senderId: 'u1@im.wechat', integrationId: 'il1' }, null);
    expect(r.ok, r.ok ? '' : r.message).toBe(true);
    if (r.ok) expect(r.ctx.memberId).toBe('m-owner');
  });

  it('🔒 别的微信号冒充 / 绑定成员被停用 → 拒', async () => {
    const other = await resolveDispatcher('w1', { provider: 'wechat', senderId: 'stranger@im.wechat', integrationId: 'il1' }, null);
    expect(other.ok).toBe(false);
    await prisma.member.update({ where: { id: 'm-owner' }, data: { status: 'disabled' } });
    const gone = await resolveDispatcher('w1', { provider: 'wechat', senderId: 'u1@im.wechat', integrationId: 'il1' }, null);
    expect(gone.ok).toBe(false);
  });
});

describe('只答不推 · 出站入口', () => {
  it('🔒 testPush 对微信客服如实说没有「测试发送」，指向体检', async () => {
    const r = await testPush('kf1', 'w1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/体检/);
  });
});
