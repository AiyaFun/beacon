import { prisma } from '../db';
import { createLogger } from '../logger';
import { readBotSecrets, writeBotSecrets } from './index';
import { ilinkGetUpdates, ilinkSendText, ilinkTextOf, ILINK_BASE, type IlinkMsg } from './wechat-ilink';
import { handleInbound } from './router';
import type { BotSecrets } from './types';

const log = createLogger({ module: 'bot-wechat-ilink-poller' });

// 微信 iLink 的收信监督者（2026-09-02）。
//
// 【为什么是常驻循环而不是定时任务】iLink 没有回调，只有长轮询（服务端 hold 35 秒）。
// 做成「每分钟一跳、每跳拉一次」用户要等最多一分钟才有回音，聊天工具里那是坏了。
// 所以每个已绑定的机器人一条 while 循环常驻拉，监督者每 30 秒对一遍库：新绑的起、停用/删除/过期的收。
//
// 【只能有一个进程在拉】get_updates_buf 是消费性游标，两处同时拉同一个 token 会互相吞消息。
// 所以只在两处起：worker.ts（SaaS / 私有化，单 worker 进程）与 instrumentation.node.ts 的
// BEACON_QUEUE=local 分支（整机版：web 进程唯一）。本机开发不设 BEACON_QUEUE → 不起，界面上要说破。
// 进程内再用 globalThis 单例挡 next dev 的模块重载。
//
// 【口径与客服通道一致】游标先落库再处理（宁漏答不重放）/ message_type=2 是自己的回执要跳过 /
// 停用的机器人循环直接退出（监督者下一轮不会再起它）。

type Loop = { stop: boolean };
const loops = new Map<string, Loop>();
let supervisor: ReturnType<typeof setInterval> | null = null;
const g = globalThis as unknown as { __beaconIlinkSupervisor?: boolean };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function startIlinkSupervisor(opts: { intervalMs?: number } = {}): void {
  if (supervisor || g.__beaconIlinkSupervisor) return;
  g.__beaconIlinkSupervisor = true;
  void reconcileIlinkLoops().catch((e) => log.warn('iLink 监督者首轮失败', { err: e }));
  supervisor = setInterval(() => {
    void reconcileIlinkLoops().catch((e) => log.warn('iLink 监督者对账失败', { err: e }));
  }, opts.intervalMs ?? 30_000);
  supervisor.unref?.();
  log.info('微信 iLink 收信监督者已启动');
}

export function stopIlinkSupervisor(): void {
  if (supervisor) clearInterval(supervisor);
  supervisor = null;
  g.__beaconIlinkSupervisor = false;
  for (const loop of loops.values()) loop.stop = true;
  loops.clear();
}

/** 对一遍库：该跑的起、不该跑的停。返回当前循环数（测试与 /api/health 看）。 */
export async function reconcileIlinkLoops(): Promise<{ running: number }> {
  const rows = await prisma.botIntegration.findMany({
    where: { provider: 'wechat', enabled: true },
    select: { id: true, secretsEnc: true },
  });
  const want = new Set<string>();
  for (const r of rows) {
    const s = readBotSecrets(r.secretsEnc);
    if (s.ilinkBotToken && !s.ilinkExpired) want.add(r.id);
  }
  for (const [id, loop] of loops) {
    if (!want.has(id)) { loop.stop = true; loops.delete(id); }
  }
  for (const id of want) {
    if (loops.has(id)) continue;
    const loop: Loop = { stop: false };
    loops.set(id, loop);
    void runLoop(id, loop).catch((e) => log.error('iLink 收信循环异常退出', { integrationId: id, err: e }))
      .finally(() => { if (loops.get(id) === loop) loops.delete(id); });
  }
  return { running: loops.size };
}

async function runLoop(id: string, loop: Loop): Promise<void> {
  let backoff = 2_000;
  while (!loop.stop) {
    // 每轮现读：token/游标/启用状态都可能刚被改过（重新扫码、停用），闭包旧快照会拉错
    const it = await prisma.botIntegration.findUnique({ where: { id } });
    if (!it || !it.enabled) return;
    const secrets = readBotSecrets(it.secretsEnc);
    if (!secrets.ilinkBotToken || secrets.ilinkExpired) return;
    const base = secrets.ilinkBaseUrl || ILINK_BASE;

    const startedAt = Date.now();
    const r = await ilinkGetUpdates(base, secrets.ilinkBotToken, secrets.ilinkCursor ?? '');
    if (loop.stop) return;

    if (!r.ok) {
      if (r.expired) {
        // 登录态过期：标记 + 停。重试只会一直 -14，等用户重新扫码（扫码成功会清掉这个标记）
        await prisma.botIntegration.updateMany({
          where: { id },
          data: {
            secretsEnc: writeBotSecrets({ ...secrets, ilinkExpired: true, ilinkCursor: '' }),
            lastError: '微信登录态已过期，请到「设置」重新扫码',
          },
        }).catch(() => {});
        log.warn('微信 iLink 登录态过期', { integrationId: id });
        return;
      }
      await prisma.botIntegration.updateMany({ where: { id }, data: { lastError: `收信失败：${r.error}`.slice(0, 300) } }).catch(() => {});
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60_000);
      continue;
    }
    backoff = 2_000;
    // 正常情况服务端会 hold 35 秒才回空；若它立刻回空（代理截断/服务端异常），别打成每秒几十次的热循环
    if (r.msgs.length === 0) {
      const elapsed = Date.now() - startedAt;
      if (elapsed < 1_000) await sleep(1_000 - elapsed);
    }

    // 游标先落库再处理：处理途中崩了宁可漏答一条，不可重放旧消息
    const next: BotSecrets = { ...secrets, ilinkCursor: r.cursor ?? secrets.ilinkCursor ?? '' };
    if (next.ilinkCursor !== secrets.ilinkCursor) {
      await prisma.botIntegration.updateMany({ where: { id }, data: { secretsEnc: writeBotSecrets(next) } }).catch(() => {});
    }
    for (const m of r.msgs) {
      if (loop.stop) return;
      await handleOne(id, it.workspaceId, next, base, m).catch((e) => log.warn('微信 iLink 单条处理失败', { integrationId: id, err: e }));
    }
  }
}

async function handleOne(integrationId: string, workspaceId: string, secrets: BotSecrets, base: string, m: IlinkMsg): Promise<void> {
  // 2 = 机器人自己发的回执——处理它会自嗨循环
  if (m.message_type === 2) return;
  const from = m.from_user_id;
  const contextToken = m.context_token;
  if (!from || !contextToken) return;

  await prisma.botIntegration.updateMany({ where: { id: integrationId }, data: { lastInboundAt: new Date() } }).catch(() => {});

  let reply: string;
  if (secrets.ilinkUserId && from !== secrets.ilinkUserId) {
    // 绑定的是「扫码的那个微信号」；别的号发来的一律不服务（也不进对话/收录）
    reply = '这个机器人只服务绑定它的那个微信号。';
  } else {
    const text = ilinkTextOf(m);
    reply = text
      ? await handleInbound(workspaceId, text, { provider: 'wechat', integrationId, chatId: from, senderId: from, isGroup: false })
      : '目前只能看懂文字消息，图片、语音、文件请转成文字再发我。';
  }

  const sent = await ilinkSendText(base, secrets.ilinkBotToken!, from, contextToken, reply);
  if (sent.ok) {
    await prisma.botIntegration.updateMany({ where: { id: integrationId }, data: { lastOutboundAt: new Date(), lastError: null } }).catch(() => {});
  } else {
    log.warn('微信 iLink 回复失败', { integrationId, error: sent.error });
    await prisma.botIntegration.updateMany({ where: { id: integrationId }, data: { lastError: `回复失败：${sent.error}`.slice(0, 300) } }).catch(() => {});
  }
}
