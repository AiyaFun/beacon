import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '@/lib/db';
import { at, orderedBefore } from '../helpers/anchor';

// 企微智能机器人长连接（2026-09-05）。守四件事：
//   ① 帧的拼与拆按官方协议；② 连接循环：订阅→鉴权→ping→收发，凭据错歇 5 分钟，断线退避重连；
//   ③ 派活类回复不收口、跑完续在后面；到时限先收口；④ 接线：只在 worker/整机版起、去重同一份、只答不推。

const h = vi.hoisted(() => ({
  inbound: [] as { text: string; ctx: Record<string, unknown> }[],
  reply: '好的',
  hook: null as null | (() => Promise<void>),
}));
vi.mock('@/lib/bot/router', () => ({
  handleInbound: async (_ws: string, text: string, ctx: Record<string, unknown>) => {
    h.inbound.push({ text, ctx });
    if (h.hook) await h.hook();
    return h.reply;
  },
}));

const { subscribeFrame, pingFrame, respondFrame, parseFrame, parseInbound, stripMention, AIBOT_TEXT_MAX } = await import('@/lib/bot/wecom-aibot');
const poller = await import('@/lib/bot/wecom-aibot-poller');
const { writeBotSecrets } = await import('@/lib/bot');
const { __resetSeen } = await import('@/lib/bot/seen');

const ROOT = process.cwd();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── 假 socket：记录发出的帧，能被测试喂入站帧 ──
type Fake = { sent: string[]; open(): void; feed(o: unknown): void; kill(reason?: string): void; closed: boolean };
let sockets: Fake[] = [];
function fakeFactory() {
  let onMsg: (raw: unknown) => void = () => {};
  let onClose: (r: string) => void = () => {};
  let onOpen: () => void = () => {};
  const f: Fake = {
    sent: [], closed: false,
    open: () => onOpen(),
    feed: (o) => onMsg(JSON.stringify(o)),
    kill: (r = 'close 1006') => { f.closed = true; onClose(r); },
  };
  sockets.push(f);
  return {
    send: (d: string) => { f.sent.push(d); },
    close: () => { if (!f.closed) { f.closed = true; onClose('close 1000'); } },
    onMessage: (cb: (raw: unknown) => void) => { onMsg = cb; },
    onClose: (cb: (r: string) => void) => { onClose = cb; },
    onOpen: (cb: () => void) => { onOpen = cb; },
  };
}
const frames = (f: Fake) => f.sent.map((s) => JSON.parse(s) as { cmd: string; headers: { req_id: string }; body?: { bot_id?: string; secret?: string; stream?: { id: string; finish: boolean; content: string } } });
const waitFor = async (pred: () => boolean, ms = 3000) => { const t0 = Date.now(); while (!pred() && Date.now() - t0 < ms) await sleep(20); return pred(); };

async function mkBot(id = 'ab1') {
  await prisma.tenant.create({ data: { id: 't1', name: 'T', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: 'W' } });
  return prisma.botIntegration.create({
    data: { id, workspaceId: 'w1', provider: 'wecom_aibot', label: '企微', enabled: true, inboundKey: 'wxaibot_BOT1', secretsEnc: writeBotSecrets({ aibotId: 'BOT1', aibotSecret: 'SEC' }) },
  });
}

beforeEach(async () => {
  h.inbound = []; h.reply = '好的'; h.hook = null;
  sockets = [];
  __resetSeen();
  poller.setAibotSocketFactory(fakeFactory);
  await prisma.agentRun.deleteMany();
  await prisma.botIntegration.deleteMany();
  await prisma.tenant.deleteMany();
});
afterEach(() => { poller.stopAibotSupervisor(); poller.setAibotSocketFactory(null); });

describe('帧', () => {
  it('订阅/ping/回复帧按协议；回复超长截断不拒发', () => {
    expect(JSON.parse(subscribeFrame('B', 'S'))).toMatchObject({ cmd: 'aibot_subscribe', body: { bot_id: 'B', secret: 'S' } });
    expect(JSON.parse(pingFrame())).toMatchObject({ cmd: 'ping' });
    const r = JSON.parse(respondFrame('req-1', 'st-1', 'x'.repeat(AIBOT_TEXT_MAX + 100), false));
    expect(r).toMatchObject({ cmd: 'aibot_respond_msg', headers: { req_id: 'req-1' }, body: { msgtype: 'stream', stream: { id: 'st-1', finish: false } } });
    expect(r.body.stream.content.length).toBe(AIBOT_TEXT_MAX);
  });
  it('拆回调：群消息 chatId=chatid，私聊 chatId=userid；非文字 text 为空；坏帧不炸', () => {
    const g = parseInbound(parseFrame(JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'r1' }, body: { msgid: 'm1', chatid: 'wr_g', chattype: 'group', from: { userid: 'zhangsan' }, msgtype: 'text', text: { content: '@烽火台 热榜' } } }))!)!;
    expect(g).toMatchObject({ reqId: 'r1', msgId: 'm1', chatId: 'wr_g', chatType: 'group', userId: 'zhangsan', text: '@烽火台 热榜' });
    const p = parseInbound({ cmd: 'aibot_msg_callback', headers: { req_id: 'r2' }, body: { msgid: 'm2', chattype: 'single', from: { userid: 'lisi' }, msgtype: 'image', image: {} } })!;
    expect(p).toMatchObject({ chatId: 'lisi', chatType: 'single', text: '' });
    expect(parseInbound({ cmd: 'ping' })).toBeNull();
    expect(parseFrame('{nope')).toBeNull();
    expect(stripMention('@烽火台 @小助手 今天写什么')).toBe('今天写什么');
  });
});

describe('连接循环（真库 + 假 socket）', () => {
  it('🔒 连上先订阅；鉴权过后 ping；文本入站 → handleInbound → 一帧收口回复；同 msgid 重投不再处理', async () => {
    await mkBot();
    expect((await poller.reconcileAibotLoops()).running).toBe(1);
    await waitFor(() => sockets.length === 1);
    const s = sockets[0];
    s.open();
    expect(frames(s)[0]).toMatchObject({ cmd: 'aibot_subscribe', body: { bot_id: 'BOT1', secret: 'SEC' } });
    s.feed({ errcode: 0, errmsg: 'ok', headers: { req_id: frames(s)[0].headers.req_id } });
    await waitFor(() => poller.aibotConnectionState('ab1').connected);
    expect(poller.aibotConnectionState('ab1').connected).toBe(true);

    s.feed({ cmd: 'aibot_msg_callback', headers: { req_id: 'r1' }, body: { msgid: 'm1', chatid: 'wr_g', chattype: 'group', from: { userid: 'zhangsan' }, msgtype: 'text', text: { content: '@烽火台 热榜' } } });
    await waitFor(() => frames(s).some((f) => f.cmd === 'aibot_respond_msg'));
    const reply = frames(s).find((f) => f.cmd === 'aibot_respond_msg')!;
    expect(reply.headers.req_id, '回复必须挂在那条回调的 req_id 上').toBe('r1');
    expect(reply.body!.stream).toMatchObject({ finish: true, content: '好的' });
    expect(h.inbound[0].text, '@昵称 没剥掉').toBe('热榜');
    expect(h.inbound[0].ctx).toMatchObject({ provider: 'wecom_aibot', integrationId: 'ab1', chatId: 'wr_g', senderId: 'zhangsan', isGroup: true });

    s.feed({ cmd: 'aibot_msg_callback', headers: { req_id: 'r1' }, body: { msgid: 'm1', chatid: 'wr_g', chattype: 'group', from: { userid: 'zhangsan' }, msgtype: 'text', text: { content: '热榜' } } });
    await sleep(100);
    expect(h.inbound.length, '重投的同一条被处理了第二遍').toBe(1);

    // 非文字：一句话收口，不进路由
    s.feed({ cmd: 'aibot_msg_callback', headers: { req_id: 'r3' }, body: { msgid: 'm3', chattype: 'single', from: { userid: 'lisi' }, msgtype: 'image', image: {} } });
    await waitFor(() => frames(s).filter((f) => f.cmd === 'aibot_respond_msg').length >= 2);
    expect(frames(s).find((f) => f.headers.req_id === 'r3')!.body!.stream!.content).toMatch(/只能看懂文字/);
    expect(h.inbound.length).toBe(1);
    const row = await prisma.botIntegration.findUniqueOrThrow({ where: { id: 'ab1' } });
    expect(row.lastInboundAt).not.toBeNull();
    expect(row.lastOutboundAt).not.toBeNull();
  });

  it('🔒 凭据错：写 lastError、不热重连（歇 5 分钟）；断线：退避重连', async () => {
    await mkBot();
    await poller.reconcileAibotLoops();
    await waitFor(() => sockets.length === 1);
    sockets[0].open();
    sockets[0].feed({ errcode: 40001, errmsg: 'invalid secret' });
    for (let i = 0; i < 50; i++) {
      if ((await prisma.botIntegration.findUnique({ where: { id: 'ab1' } }))?.lastError) break;
      await sleep(50);
    }
    await sleep(150);
    const row = await prisma.botIntegration.findUniqueOrThrow({ where: { id: 'ab1' } });
    expect(row.lastError).toMatch(/拒绝了连接/);
    expect(sockets.length, '鉴权失败后立刻又连了——错的凭据每秒重连会被封').toBe(1);
    expect(poller.AIBOT_AUTH_RETRY_MS).toBeGreaterThanOrEqual(60_000);
  });

  it('🔒 派活类回复不收口，跑完由 sendToChat 续在后面收口；断线后未收口的流作废', async () => {
    await mkBot();
    await poller.reconcileAibotLoops();
    await waitFor(() => sockets.length === 1);
    const s = sockets[0];
    s.open();
    s.feed({ errcode: 0 });
    await waitFor(() => poller.aibotConnectionState('ab1').connected);
    // 模拟 handleInbound 派了活：写一条带 botChatRef 的运行
    h.reply = '已排给情报员，跑完这里回你';
    h.hook = async () => {
      await prisma.creatorAccount.create({ data: { id: 'a1', workspaceId: 'w1', name: 'A', platform: 'x' } }).catch(() => {});
      await prisma.member.create({ data: { id: 'mem1', tenantId: 't1', name: 'M', role: 'owner' } }).catch(() => {});
      await prisma.agentRun.create({ data: { workspaceId: 'w1', accountId: 'a1', memberId: 'mem1', goal: '采一下', status: 'running', messages: '[]', botChatRef: 'wecom_aibot:ab1:wr_g' } });
    };
    s.feed({ cmd: 'aibot_msg_callback', headers: { req_id: 'r9' }, body: { msgid: 'm9', chatid: 'wr_g', chattype: 'group', from: { userid: 'zhangsan' }, msgtype: 'text', text: { content: '采一下' } } });
    await waitFor(() => frames(s).some((f) => f.cmd === 'aibot_respond_msg'));
    const first = frames(s).find((f) => f.cmd === 'aibot_respond_msg')!;
    expect(first.body!.stream!.finish, '派活的回复被立刻收口了——跑完的结果没地方回').toBe(false);
    expect(poller.__openStreamCount()).toBe(1);

    const { sendToChat } = await import('@/lib/bot');
    const r = await sendToChat('w1', 'ab1', 'wr_g', { kind: 'card', title: '✅ 跑完了', lines: ['更新 14 条'] });
    expect(r.ok).toBe(true);
    const last = frames(s).filter((f) => f.cmd === 'aibot_respond_msg').pop()!;
    expect(last.headers.req_id).toBe('r9');
    expect(last.body!.stream).toMatchObject({ id: first.body!.stream!.id, finish: true });
    expect(last.body!.stream!.content).toContain('已排给情报员');
    expect(last.body!.stream!.content).toContain('更新 14 条');
    expect(poller.__openStreamCount()).toBe(0);
    // 没有可续的流 → 如实报错
    expect((await sendToChat('w1', 'ab1', 'wr_g', { kind: 'text', text: 'x' })).ok).toBe(false);

    // 断线：未收口的流作废，且会重连（新 socket）
    s.feed({ cmd: 'aibot_msg_callback', headers: { req_id: 'r10' }, body: { msgid: 'm10', chatid: 'wr_g', chattype: 'group', from: { userid: 'zhangsan' }, msgtype: 'text', text: { content: '再采' } } });
    await waitFor(() => poller.__openStreamCount() === 1);
    s.kill();
    await waitFor(() => poller.__openStreamCount() === 0);
    expect(poller.aibotConnectionState('ab1').connected).toBe(false);
    await waitFor(() => sockets.length >= 2, 4000);
    expect(sockets.length, '断线后没重连').toBeGreaterThanOrEqual(2);
  });

  it('停用 / 删除 → 对账断开', async () => {
    await mkBot();
    expect((await poller.reconcileAibotLoops()).running).toBe(1);
    await prisma.botIntegration.update({ where: { id: 'ab1' }, data: { enabled: false } });
    expect((await poller.reconcileAibotLoops()).running).toBe(0);
  });
});

describe('接线口径（源码级）', () => {
  it('🔒 只在 worker 与整机版 web 进程各起一次（每个机器人只许一条活连接）', () => {
    const w = readFileSync(join(ROOT, 'worker.ts'), 'utf8');
    at(w, 'startAibotSupervisor()');
    at(w, 'stopAibotSupervisor()');
    const inst = readFileSync(join(ROOT, 'instrumentation.node.ts'), 'utf8');
    at(inst.slice(at(inst, "schedulerKind() === 'local'")), 'startAibotSupervisor()');
  });
  it('🔒 去重与三条回调路同一份实现；先去重再进路由；只答不推名单里有它、对外名单里没有', () => {
    const src = readFileSync(join(ROOT, 'lib/bot/wecom-aibot-poller.ts'), 'utf8');
    expect(src).toMatch(/markSeen\(integrationId, `wecom_aibot:\$\{m\.msgId\}`\)/);
    orderedBefore(src.slice(at(src, 'async function handleOne')), 'markSeen(', 'handleInbound(');
    const types = readFileSync(join(ROOT, 'lib/bot/types.ts'), 'utf8');
    expect(types).toMatch(/REPLY_ONLY_PROVIDERS[^\n]*'wecom_aibot'/);
    expect(types).not.toMatch(/EXTERNAL_PROVIDERS[^\n]*'wecom_aibot'/);
  });
  it('🔒 保存：BotID 进 inboundKey 且全局唯一（同一机器人不许两条）；没有 webhook；推送清空；诊断不另起连接', () => {
    const act = readFileSync(join(ROOT, 'app/(app)/settings/bot-actions.ts'), 'utf8');
    const fn = act.slice(at(act, 'async function saveWecomAibot'), at(act, 'async function saveWechatIlinkMeta'));
    expect(fn).toContain('const inboundKey = `wxaibot_${aibotId}`');
    expect(fn).toMatch(/findFirst\(\{ where: \{ inboundKey/);
    expect(fn).toContain('webhookUrl: null');
    expect(fn).toContain('pushEvents: toJson([])');
    const d = readFileSync(join(ROOT, 'lib/bot/diagnose.ts'), 'utf8');
    const seg = d.slice(at(d, "provider === 'wecom_aibot'"), at(d, "if (!inboundKey) {"));
    expect(seg).not.toMatch(/WebSocket|realSocketFactory/);
    const ui = readFileSync(join(ROOT, 'app/(app)/settings/BotIntegrationCard.tsx'), 'utf8');
    expect(ui).toContain('data-field="aibot-id"');
    expect(ui).toContain('data-field="aibot-secret"');
    expect(ui).toMatch(/provider === 'wecom_aibot' && r\.inboundKey\) setAppId\(r\.inboundKey\.replace\(\/\^wxaibot_\/, ''\)\)/);
    // 身份：智能机器人的 from.userid 就是企微成员，派任务按企微 OA 身份，不落到 feishu 兜底
    const disp = readFileSync(join(ROOT, 'lib/bot/dispatch.ts'), 'utf8');
    expect(disp).toMatch(/inbound\.provider === 'wecom_aibot' \? 'wecom'/);
    const router = readFileSync(join(ROOT, 'lib/bot/router.ts'), 'utf8');
    expect(router).toMatch(/provider === 'wecom_aibot' \? 'wecom'/);
  });
});
