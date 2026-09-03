import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '@/lib/db';

// 群里派任务（/派 /执行 /任务 /终止）。
//
// 【最不能松的四条，与 lib/bot/dispatch.ts 文件头一一对应】
// ① 默认开：dispatch 与其他命令一样吃「空=全开」的祖荫——身份闸+站内确认已经两道关卡了；
// ② 身份闸：没绑企业应用身份的群成员一条任务都派不出去（群是共享空间）；
// ③ 授权收口：/执行 走 origin:'bot'（缺省直接跑完，与页面同权），/派 用卡上的合同——
//    群里没有确认通道，发布类操作必然停在 awaiting_confirm；
// ④ 圈地：/任务 /终止 只看 botChatRef 等于本群的运行，碰不到站内/别的群派的。

const h = vi.hoisted(() => ({
  script: [] as { text?: string; toolCalls?: { id: string; name: string; arguments: string }[] }[],
}));

vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async () => {
    const next = h.script.shift() ?? { text: '（剧本演完了）' };
    return {
      text: next.text ?? '', provider: 'scripted', model: 'scripted', mocked: false,
      promptTokens: 1, completionTokens: 1,
      ...(next.toolCalls ? { toolCalls: next.toolCalls } : {}),
    };
  },
}));
vi.mock('@/lib/memory/core', () => ({ buildMemoryContext: async () => '' }));

const { handleInbound } = await import('@/lib/bot/router');
const { isCommandAllowed, DEFAULT_OFF_COMMANDS, sanitizeAllowCommands } = await import('@/lib/bot/types');
const botIndex = await import('@/lib/bot/index');
const { echoRunToChat, chatRefOf } = await import('@/lib/bot/dispatch');
const { settleAgentKicks } = await import('@/lib/agent/kick');

// 群里那条消息的上下文：飞书群 oc_1，发送者 ou_alice
const GROUP = { provider: 'feishu', integrationId: 'bi1', chatId: 'oc_1', senderId: 'ou_alice', isGroup: true };
const REF = chatRefOf('feishu', 'bi1', 'oc_1');

async function withBot(allowCommands: string[]) {
  await prisma.botIntegration.create({
    data: {
      id: 'bi1', workspaceId: 'w1', provider: 'feishu', label: 'B', inboundKey: 'cli_x',
      pushEvents: '[]', allowCommands: JSON.stringify(allowCommands),
    },
  });
}

async function withMember(role = 'editor', oa: string | null = 'feishu:ou_alice', tenantId = 't1') {
  return prisma.member.create({
    data: { id: `m-${oa ?? 'x'}-${tenantId}`, tenantId, name: '爱丽丝', role, status: 'active', oaIdentity: oa },
  });
}

beforeEach(async () => {
  h.script = [];
  vi.restoreAllMocks();
  await prisma.notification.deleteMany();
  await prisma.agentStep.deleteMany();
  await prisma.agentRun.deleteMany();
  await prisma.taskPreset.deleteMany();
  await prisma.tenant.deleteMany({});
  await prisma.tenant.create({ data: { id: 't1', name: 'T', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: 'W' } });
  await prisma.creatorAccount.create({ data: { id: 'a1', workspaceId: 'w1', name: '测试号', platform: 'douyin', status: 'active' } });
});

describe('① 默认开：空白名单也算开（身份闸+站内确认已经两道关卡）', () => {
  it('dispatch 在空/未配置白名单下与其他命令一样是开的', () => {
    expect(isCommandAllowed('dispatch', [])).toBe(true);
    expect(isCommandAllowed('dispatch', null)).toBe(true);
    expect(isCommandAllowed('dispatch', undefined)).toBe(true);
    expect(isCommandAllowed('chat', [])).toBe(true);
    expect(isCommandAllowed('hot', null)).toBe(true);
    expect(isCommandAllowed('dispatch', ['dispatch'])).toBe(true);
    expect(isCommandAllowed('dispatch', ['help', 'chat'])).toBe(false);
    expect(DEFAULT_OFF_COMMANDS).not.toContain('dispatch');
  });

  it('sanitizeAllowCommands 认得 dispatch（设置页存得进去）', () => {
    expect(sanitizeAllowCommands(['dispatch', 'chat', 'nope'])).toEqual(['dispatch', 'chat']);
  });

  it('群里 /派 在未配置的机器人上也能用（身份闸仍然在）', async () => {
    await withBot([]);
    await withMember();
    const reply = await handleInbound('w1', '/派', GROUP);
    expect(reply).not.toContain('在这个群没有开');
  });
});

describe('② 身份闸：没绑身份/权限不够都派不动', () => {
  beforeEach(() => withBot(['dispatch', 'help']));

  it('没绑定的群成员：给绑定引导，不建运行', async () => {
    const reply = await handleInbound('w1', '/执行 帮我看看数据', { ...GROUP, senderId: 'ou_stranger' });
    expect(reply).toContain('绑定');
    expect(reply).toContain('私聊');
    expect(await prisma.agentRun.count()).toBe(0);
  });

  it('取不到 senderId 的通道：如实说，不建运行', async () => {
    const reply = await handleInbound('w1', '/执行 帮我看看数据', { ...GROUP, senderId: undefined });
    expect(reply).toContain('取不到你的企业应用账号');
    expect(await prisma.agentRun.count()).toBe(0);
  });

  it('viewer 角色：拒绝并说清找谁开权限', async () => {
    await withMember('viewer');
    const reply = await handleInbound('w1', '/执行 帮我看看数据', GROUP);
    expect(reply).toContain('没有派任务的权限');
    expect(await prisma.agentRun.count()).toBe(0);
  });

  it('身份绑在别的租户：不能给本工作区派活', async () => {
    await prisma.tenant.create({ data: { id: 't2', name: 'T2', plan: 'free' } });
    await withMember('owner', 'feishu:ou_alice', 't2');
    const reply = await handleInbound('w1', '/执行 帮我看看数据', GROUP);
    expect(reply).toContain('另一个团队');
    expect(await prisma.agentRun.count()).toBe(0);
  });
});

describe('③ 授权收口与真实派发', () => {
  beforeEach(async () => {
    await withBot(['dispatch', 'help']);
    await withMember('editor');
  });

  it('/执行：origin=bot、直接跑完（unattended）、botChatRef 记回本群', async () => {
    h.script = [{ text: '看完了，一切正常。' }];
    const reply = await handleInbound('w1', '/执行 看看我最近的数据', GROUP);
    expect(reply).toContain('✅ 任务已开始');
    expect(reply).toContain('直接跑完');

    const run = await prisma.agentRun.findFirstOrThrow();
    expect(run.origin).toBe('bot');
    // 2026-09-03 用户拍板：群里派的活也直接完成。此前走 origin:'api' 被强制成每步确认。
    expect(run.authMode).toBe('unattended');
    expect(run.origin, '群通道绝不能再走 api 那条强制确认的路').not.toBe('api');
    expect(run.botChatRef).toBe(REF);
    expect(run.goal).toBe('看看我最近的数据');

    await settleAgentKicks();
    const done = await prisma.agentRun.findFirstOrThrow();
    expect(done.status).toBe('done');
  });

  it('/派：无参数列卡；按名派发用卡上的授权合同（origin=preset）', async () => {
    await prisma.taskPreset.create({
      data: { id: 'p1', tenantId: 't1', workspaceId: 'w1', title: '日更三件套', goal: '把今天的日更做出来', authMode: 'confirm_each' },
    });
    const list = await handleInbound('w1', '/派', GROUP);
    expect(list).toContain('日更三件套');
    expect(await prisma.agentRun.count()).toBe(0); // 列卡不派

    h.script = [{ text: '做完了。' }];
    const reply = await handleInbound('w1', '/派 日更三件套', GROUP);
    expect(reply).toContain('已派出「日更三件套」');
    const run = await prisma.agentRun.findFirstOrThrow();
    expect(run.origin).toBe('preset');
    expect(run.botChatRef).toBe(REF);
    await settleAgentKicks();
  });

  it('/派 名字撞到多张卡：列候选，不猜、不派', async () => {
    await prisma.taskPreset.createMany({
      data: [
        { id: 'p1', tenantId: 't1', workspaceId: 'w1', title: '日更甲', goal: 'a' },
        { id: 'p2', tenantId: 't1', workspaceId: 'w1', title: '日更乙', goal: 'b' },
      ],
    });
    const reply = await handleInbound('w1', '/派 日更', GROUP);
    expect(reply).toContain('匹配到多张卡');
    expect(await prisma.agentRun.count()).toBe(0);
  });
});

describe('④ 圈地：/任务 /终止 只碰本群派出的运行', () => {
  beforeEach(async () => {
    await withBot(['dispatch', 'help']);
    await withMember('editor');
    await prisma.agentRun.createMany({
      data: [
        { id: 'r-mine', workspaceId: 'w1', accountId: 'a1', memberId: 'm-feishu:ou_alice-t1', goal: '本群派的活', status: 'running', messages: '[]', botChatRef: REF },
        { id: 'r-site', workspaceId: 'w1', accountId: 'a1', memberId: 'm-feishu:ou_alice-t1', goal: '站内派的活', status: 'running', messages: '[]', botChatRef: null },
        { id: 'r-other', workspaceId: 'w1', accountId: 'a1', memberId: 'm-feishu:ou_alice-t1', goal: '别的群派的活', status: 'running', messages: '[]', botChatRef: chatRefOf('feishu', 'bi1', 'oc_2') },
      ],
    });
  });

  it('/任务 只列本群的', async () => {
    const reply = await handleInbound('w1', '/任务', GROUP);
    expect(reply).toContain('本群派的活');
    expect(reply).not.toContain('站内派的活');
    expect(reply).not.toContain('别的群派的活');
  });

  it('/终止 只取消本群最新的活运行，站内与别的群纹丝不动', async () => {
    const reply = await handleInbound('w1', '/终止', GROUP);
    expect(reply).toContain('已终止');
    const statuses = Object.fromEntries(
      (await prisma.agentRun.findMany({ select: { id: true, status: true } })).map((r) => [r.id, r.status]),
    );
    expect(statuses['r-mine']).toBe('cancelled');
    expect(statuses['r-site']).toBe('running');
    expect(statuses['r-other']).toBe('running');
  });

  it('本群没有活运行时如实说', async () => {
    await prisma.agentRun.update({ where: { id: 'r-mine' }, data: { status: 'done' } });
    const reply = await handleInbound('w1', '/终止', GROUP);
    expect(reply).toContain('没有还在跑的任务');
  });
});

describe('闭环：终态回执发回派它的群', () => {
  beforeEach(async () => {
    await withBot(['dispatch', 'help']);
    await withMember('editor');
  });

  it('echoRunToChat：done 的运行按 botChatRef 发回对应集成；无 ref/状态不符则不发', async () => {
    const send = vi.spyOn(botIndex, 'sendToChat').mockResolvedValue({ ok: true });
    await prisma.agentRun.create({
      data: { id: 'r1', workspaceId: 'w1', accountId: 'a1', memberId: 'm-feishu:ou_alice-t1', goal: '跑个数据', status: 'done', answer: '搞定了', messages: '[]', botChatRef: REF },
    });
    expect(await echoRunToChat('r1', 'done')).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const [wsId, integrationId, chatId, msg] = send.mock.calls[0];
    expect(wsId).toBe('w1');
    expect(integrationId).toBe('bi1');
    // 🔒 定点到派它的那个群（oc_1），不是集成级广播——集成级会发到机器人所在的所有群
    expect(chatId).toBe('oc_1');
    expect(JSON.stringify(msg)).toContain('跑个数据');

    // 状态已被后来的变化盖过 → 不发（别把过期消息推进群）
    expect(await echoRunToChat('r1', 'failed')).toBe(false);
    // 站内派的（无 botChatRef）永远不发
    await prisma.agentRun.create({
      data: { id: 'r2', workspaceId: 'w1', accountId: 'a1', memberId: 'm-feishu:ou_alice-t1', goal: 'x', status: 'done', messages: '[]' },
    });
    expect(await echoRunToChat('r2', 'done')).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('端到端：群里 /执行 → 跑完 → afterTransition 自动把回执发回群（去重借站内通知）', async () => {
    const send = vi.spyOn(botIndex, 'sendToChat').mockResolvedValue({ ok: true });
    const broadcast = vi.spyOn(botIndex, 'sendToIntegration').mockResolvedValue({ ok: true });
    h.script = [{ text: '数据看完了。' }];
    await handleInbound('w1', '/执行 看看数据', GROUP);
    await settleAgentKicks();

    const run = await prisma.agentRun.findFirstOrThrow();
    expect(run.status).toBe('done');
    // 回执恰好一次，发给本群的集成
    // 派出时的进度卡（startProgressCard，「已排队」）也走 sendToChat，且是 void 的异步——
    // 与断言的先后不定，所以只数「跑完了」那条回执，不数总调用次数
    const echoCalls = send.mock.calls.filter((c) => c[1] === 'bi1' && c[2] === 'oc_1' && JSON.stringify(c[3]).includes('跑完了'));
    expect(echoCalls.length).toBe(1);
    // 🔒 回执绝不走集成级广播
    expect(broadcast).not.toHaveBeenCalled();
    // 站内通知也在（去重的锚点）
    expect(await prisma.notification.count({ where: { workspaceId: 'w1' } })).toBeGreaterThan(0);
  });
});
