import { prisma } from '../db';
import { createLogger } from '../logger';
import { readBotSecrets } from './index';
import { handleInbound } from './router';
import { markSeen } from './seen';
import {
  AIBOT_WS_URL, AIBOT_PING_MS, AIBOT_STREAM_TTL_MS,
  subscribeFrame, pingFrame, respondFrame, parseFrame, parseInbound, stripMention, reqId,
  realSocketFactory, type AibotSocket, type SocketFactory, type AibotInbound,
} from './wecom-aibot';

const log = createLogger({ module: 'bot-wecom-aibot' });

// 企微智能机器人的长连接监督者（2026-09-05）。形状照微信 iLink 的收信监督者（wechat-ilink-poller.ts）：
// 每个启用的机器人一条常驻连接，监督者每 30 秒对一遍库——新配的连、停用/删除的断。
//
// 【只能有一个进程连】协议规定每个机器人只许一条活连接，新连接会把旧的顶掉。两处进程同时连就是
// 互相踢、消息在两边乱跳。所以只在 worker.ts（SaaS/私有化）与整机版 web 进程（instrumentation.node.ts）起。
//
// 【只答不推，但派出去的任务要回得来】回复必须挂在入站帧的 req_id 上。用户在群里派了个活，几分钟后跑完，
// 这时候没有新的入站帧可挂——协议给了一条路：流式回复 10 分钟内可以不收口。所以：
//   派活类回复先发 finish=false 并把 (req_id, stream_id) 记在 openStreams 里；
//   跑完时 sendToChat → finishOpenStream 把结果续在原回复后面、finish=true 收口；
//   到 9.5 分钟还没跑完就先收口并说「还在跑，结果去任务台看」——不能让企微那头一直转圈。
//
// 【去重】平台在重连后可能重投；markSeen(integrationId, `wecom_aibot:${msgid}`) 与其它三条回调路同一份实现。

type Loop = { stop: boolean; socket: AibotSocket | null; connected: boolean; since: Date | null; lastError: string | null };
const loops = new Map<string, Loop>();
let supervisor: ReturnType<typeof setInterval> | null = null;
const g = globalThis as unknown as { __beaconAibotSupervisor?: boolean };
let factory: SocketFactory = realSocketFactory;
/** 测试注入假 socket；生产永远是 undici 的 WebSocket */
export function setAibotSocketFactory(f: SocketFactory | null): void { factory = f ?? realSocketFactory; }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 鉴权失败后多久再试：错的 BotID/Secret 每秒重连只会被封 */
export const AIBOT_AUTH_RETRY_MS = 5 * 60_000;

type OpenStream = { integrationId: string; chatId: string; reqId: string; streamId: string; content: string; expiresAt: number };
const openStreams = new Map<string, OpenStream>();
const streamKey = (integrationId: string, chatId: string) => `${integrationId}:${chatId}`;

export function startAibotSupervisor(opts: { intervalMs?: number } = {}): void {
  if (supervisor || g.__beaconAibotSupervisor) return;
  g.__beaconAibotSupervisor = true;
  void reconcileAibotLoops().catch((e) => log.warn('企微智能机器人监督者首轮失败', { err: e }));
  supervisor = setInterval(() => {
    void reconcileAibotLoops().catch((e) => log.warn('企微智能机器人监督者对账失败', { err: e }));
  }, opts.intervalMs ?? 30_000);
  supervisor.unref?.();
  log.info('企微智能机器人长连接监督者已启动');
}

export function stopAibotSupervisor(): void {
  if (supervisor) clearInterval(supervisor);
  supervisor = null;
  g.__beaconAibotSupervisor = false;
  for (const loop of loops.values()) { loop.stop = true; loop.socket?.close(); }
  loops.clear();
  openStreams.clear();
}

/** 对一遍库：该连的连、不该连的断。返回当前连接数（测试与 /api/health 看）。 */
export async function reconcileAibotLoops(): Promise<{ running: number }> {
  const rows = await prisma.botIntegration.findMany({
    where: { provider: 'wecom_aibot', enabled: true },
    select: { id: true, secretsEnc: true },
  });
  const want = new Set<string>();
  for (const r of rows) {
    const s = readBotSecrets(r.secretsEnc);
    if (s.aibotId && s.aibotSecret) want.add(r.id);
  }
  for (const [id, loop] of loops) {
    if (!want.has(id)) { loop.stop = true; loop.socket?.close(); loops.delete(id); }
  }
  for (const id of want) {
    if (loops.has(id)) continue;
    const loop: Loop = { stop: false, socket: null, connected: false, since: null, lastError: null };
    loops.set(id, loop);
    void runLoop(id, loop).catch((e) => log.error('企微智能机器人连接循环异常退出', { integrationId: id, err: e }))
      .finally(() => { if (loops.get(id) === loop) loops.delete(id); });
  }
  return { running: loops.size };
}

/** 给体检与连接状态页看：这条机器人现在连着没有 */
export function aibotConnectionState(integrationId: string): { running: boolean; connected: boolean; since: Date | null; lastError: string | null } {
  const l = loops.get(integrationId);
  return l ? { running: true, connected: l.connected, since: l.since, lastError: l.lastError } : { running: false, connected: false, since: null, lastError: null };
}

async function runLoop(id: string, loop: Loop): Promise<void> {
  let backoff = 2_000;
  while (!loop.stop) {
    const it = await prisma.botIntegration.findUnique({ where: { id } });
    if (!it || !it.enabled) return;
    const secrets = readBotSecrets(it.secretsEnc);
    if (!secrets.aibotId || !secrets.aibotSecret) return;

    const outcome = await runConnection(id, it.workspaceId, secrets.aibotId, secrets.aibotSecret, loop);
    if (loop.stop) return;
    if (outcome.kind === 'auth') {
      // 凭据错：写清楚，歇 5 分钟再试（用户改完凭据会触发对账，那时才会重新连）
      loop.lastError = outcome.error;
      await prisma.botIntegration.updateMany({ where: { id }, data: { lastError: `企微拒绝了连接：${outcome.error}`.slice(0, 300) } }).catch(() => {});
      log.warn('企微智能机器人鉴权失败', { integrationId: id, error: outcome.error });
      await sleep(AIBOT_AUTH_RETRY_MS);
      continue;
    }
    if (outcome.kind === 'closed') {
      loop.lastError = outcome.error;
      await prisma.botIntegration.updateMany({ where: { id }, data: { lastError: `连接断开：${outcome.error}`.slice(0, 300) } }).catch(() => {});
      await sleep(backoff);
      backoff = outcome.stableFor > 60_000 ? 2_000 : Math.min(backoff * 2, 60_000);
    }
  }
}

type Outcome = { kind: 'auth'; error: string } | { kind: 'closed'; error: string; stableFor: number } | { kind: 'stopped' };

/** 一条连接从连上到断开的全过程。返回为什么断。 */
function runConnection(integrationId: string, workspaceId: string, botId: string, secret: string, loop: Loop): Promise<Outcome> {
  return new Promise<Outcome>((resolve) => {
    let done = false;
    let openedAt = 0;
    let authed = false;
    let pendingPings = 0;
    let ping: ReturnType<typeof setInterval> | null = null;
    const finish = (o: Outcome) => {
      if (done) return;
      done = true;
      if (ping) clearInterval(ping);
      loop.connected = false;
      loop.socket = null;
      // 连接没了，挂在它上面的未收口回复也没了：清掉，跑完的结果走「没有可挂的会话」那条错
      for (const [k, s] of openStreams) if (s.integrationId === integrationId) openStreams.delete(k);
      resolve(o);
    };
    let socket: AibotSocket;
    try {
      socket = factory(AIBOT_WS_URL);
    } catch (e) {
      finish({ kind: 'closed', error: (e as Error).message, stableFor: 0 });
      return;
    }
    loop.socket = socket;
    socket.onOpen(() => {
      openedAt = Date.now();
      socket.send(subscribeFrame(botId, secret));
    });
    socket.onClose((reason) => {
      if (loop.stop) return finish({ kind: 'stopped' });
      finish(authed ? { kind: 'closed', error: reason, stableFor: Date.now() - openedAt } : { kind: 'auth', error: reason || '订阅未被接受' });
    });
    socket.onMessage((raw) => {
      const f = parseFrame(raw);
      if (!f) return;
      // 订阅/ping 的回应：只有 errcode 没有 cmd
      if (!f.cmd) {
        if (!authed) {
          if (f.errcode === 0) {
            authed = true;
            loop.connected = true;
            loop.since = new Date();
            loop.lastError = null;
            void prisma.botIntegration.updateMany({ where: { id: integrationId }, data: { lastError: null } }).catch(() => {});
            ping = setInterval(() => {
              if (pendingPings >= 2) {
                // 两次 ping 没回：连接其实已经死了（NAT 超时、平台重启），主动断开走重连
                socket.close();
                finish({ kind: 'closed', error: 'ping 无回应', stableFor: Date.now() - openedAt });
                return;
              }
              pendingPings += 1;
              socket.send(pingFrame());
              sweepExpiredStreams(socket);
            }, AIBOT_PING_MS);
            ping.unref?.();
          } else {
            socket.close();
            finish({ kind: 'auth', error: `${f.errcode} ${f.errmsg ?? ''}`.trim() });
          }
          return;
        }
        if (f.errcode === 0) pendingPings = 0;
        return;
      }
      const inbound = parseInbound(f);
      if (!inbound) return;
      void handleOne(socket, integrationId, workspaceId, inbound).catch((e) => log.warn('企微智能机器人单条处理失败', { integrationId, err: e }));
    });
  });
}

async function handleOne(socket: AibotSocket, integrationId: string, workspaceId: string, m: AibotInbound): Promise<void> {
  if (!markSeen(integrationId, `wecom_aibot:${m.msgId}`)) return;
  await prisma.botIntegration.updateMany({ where: { id: integrationId }, data: { lastInboundAt: new Date() } }).catch(() => {});

  const streamId = reqId('s');
  if (!m.text) {
    socket.send(respondFrame(m.reqId, streamId, '目前只能看懂文字消息，图片、语音、文件请转成文字再发我。', true));
    return;
  }
  const startedAt = new Date();
  const text = stripMention(m.text);
  const reply = await handleInbound(workspaceId, text, {
    provider: 'wecom_aibot', integrationId, chatId: m.chatId, senderId: m.userId, isGroup: m.chatType === 'group',
  });

  // 这句话有没有派出一个要跑一阵的任务？有的话回复先不收口，跑完再续（sendToChat → finishOpenStream）。
  // 判据不是猜文案，而是查库：派活会把 botChatRef 写在 AgentRun 上。
  const ref = `wecom_aibot:${integrationId}:${m.chatId}`;
  const dispatched = await prisma.agentRun.findFirst({
    where: { workspaceId, botChatRef: ref, createdAt: { gte: startedAt } },
    select: { id: true },
  }).catch(() => null);
  if (dispatched) {
    openStreams.set(streamKey(integrationId, m.chatId), {
      integrationId, chatId: m.chatId, reqId: m.reqId, streamId, content: reply, expiresAt: Date.now() + AIBOT_STREAM_TTL_MS,
    });
    socket.send(respondFrame(m.reqId, streamId, reply, false));
  } else {
    socket.send(respondFrame(m.reqId, streamId, reply, true));
  }
  await prisma.botIntegration.updateMany({ where: { id: integrationId }, data: { lastOutboundAt: new Date() } }).catch(() => {});
}

/** 跑完的结果续在原回复后面并收口。没有可续的流（超时/断线/根本不是这条路派的）→ false。 */
export function finishOpenStream(integrationId: string, chatId: string, appendText: string): boolean {
  const key = streamKey(integrationId, chatId);
  const s = openStreams.get(key);
  const loop = loops.get(integrationId);
  if (!s || !loop?.socket || !loop.connected) return false;
  openStreams.delete(key);
  loop.socket.send(respondFrame(s.reqId, s.streamId, `${s.content}\n\n${appendText}`, true));
  return true;
}

/** 到时限还没跑完的流：先收口并说明，别让企微那头一直转圈 */
function sweepExpiredStreams(socket: AibotSocket): void {
  const now = Date.now();
  for (const [k, s] of openStreams) {
    if (s.expiresAt > now) continue;
    openStreams.delete(k);
    socket.send(respondFrame(s.reqId, s.streamId, `${s.content}\n\n（还在跑。结果会记在任务台，跑完这里不再通知。）`, true));
  }
}

/** 测试用：有几条未收口的流 */
export function __openStreamCount(): number { return openStreams.size; }
