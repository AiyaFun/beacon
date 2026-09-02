import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '@/lib/db';
import { at, orderedBefore } from '../helpers/anchor';

// 微信官方 iLink 机器人接口（2026-09-02）。
// 假 iLink 服务端：get_bot_qrcode / get_qrcode_status / getupdates / sendmessage。
// 收信循环用真库跑（secrets.ilinkBaseUrl 指到假服务端），验的是行为不是源码：
// 游标先落库 / 自己的回执跳过 / 只服务绑定的号 / 回复带 context_token 与 Bearer / -14 标过期停循环。

vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async () => ({ text: '（桩）', provider: 'x', model: 'x', mocked: false, promptTokens: 1, completionTokens: 1 }),
}));
vi.mock('@/lib/memory/core', () => ({ buildMemoryContext: async () => '' }));

const ROOT = process.cwd();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 假 iLink ──
type Call = { path: string; headers: http.IncomingHttpHeaders; body?: unknown };
const calls: Call[] = [];
let mode: 'msgs' | 'idle' | 'expired' = 'idle';
let delivered = false;
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const url = new URL(req.url ?? '/', 'http://x');
    calls.push({ path: url.pathname, headers: req.headers, body: body ? JSON.parse(body) : undefined });
    res.setHeader('content-type', 'application/json');
    if (url.pathname.endsWith('/get_bot_qrcode')) return res.end(JSON.stringify({ qrcode: 'qrc_1', qrcode_img_content: 'https://ilink.example/x' }));
    if (url.pathname.endsWith('/get_qrcode_status')) {
      // slow=1：模拟微信那头 hold 住不回（真机实测一次 hold 了 21 秒）
      if (url.searchParams.get('qrcode') === 'qrc_slow') { await sleep(1500); return res.end(JSON.stringify({ status: 'wait' })); }
      return res.end(JSON.stringify({ status: 'confirmed', bot_token: 'ilinkbot_T', ilink_bot_id: 'b1@im.bot', ilink_user_id: 'u1@im.wechat', baseurl: '' }));
    }
    if (url.pathname.endsWith('/getupdates')) {
      if (mode === 'expired') return res.end(JSON.stringify({ ret: -14, errcode: -14, errmsg: 'session timeout' }));
      if (mode === 'msgs' && !delivered) {
        delivered = true;
        return res.end(JSON.stringify({
          ret: 0,
          get_updates_buf: 'cur-1',
          msgs: [
            { from_user_id: 'u1@im.wechat', to_user_id: 'b1@im.bot', context_token: 'ctx-owner', message_type: 1, message_state: 2, item_list: [{ type: 1, text_item: { text: '/热点' } }] },
            { from_user_id: 'b1@im.bot', to_user_id: 'u1@im.wechat', context_token: 'ctx-self', message_type: 2, item_list: [{ type: 1, text_item: { text: '我自己的回执' } }] },
            { from_user_id: 'stranger@im.wechat', to_user_id: 'b1@im.bot', context_token: 'ctx-stranger', message_type: 1, item_list: [{ type: 1, text_item: { text: '在吗' } }] },
            { from_user_id: 'u1@im.wechat', to_user_id: 'b1@im.bot', context_token: 'ctx-img', message_type: 1, item_list: [{ type: 2, image_item: {} }] },
          ],
        }));
      }
      // 空轮：模拟服务端 hold 一小会儿
      await sleep(250);
      return res.end(JSON.stringify({ ret: 0, get_updates_buf: 'cur-1', msgs: [] }));
    }
    if (url.pathname.endsWith('/sendmessage')) return res.end(JSON.stringify({}));
    res.statusCode = 404;
    res.end('{}');
  });
});
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
afterAll(() => srv.close());

const { ilinkGetQr, ilinkQrStatus, ilinkSendText, ilinkGetUpdates } = await import('@/lib/bot/wechat-ilink');
const { reconcileIlinkLoops, stopIlinkSupervisor } = await import('@/lib/bot/wechat-ilink-poller');
const { writeBotSecrets, readBotSecrets } = await import('@/lib/bot');
const { toJson } = await import('@/lib/json');

beforeEach(async () => {
  calls.length = 0;
  mode = 'idle';
  delivered = false;
  stopIlinkSupervisor();
  await prisma.tenant.deleteMany({});
  await prisma.tenant.create({ data: { id: 't1', name: '租户', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: 'W' } });
  await prisma.creatorAccount.create({ data: { id: 'a1', workspaceId: 'w1', name: '号', platform: 'douyin', status: 'active' } });
});

async function bindOne(extra: Record<string, unknown> = {}) {
  return prisma.botIntegration.create({
    data: {
      id: 'il1', workspaceId: 'w1', provider: 'wechat', label: '微信', inboundKey: 'wxilink_b1@im.bot',
      secretsEnc: writeBotSecrets({ ilinkBotToken: 'ilinkbot_T', ilinkBotId: 'b1@im.bot', ilinkUserId: 'u1@im.wechat', ilinkBaseUrl: BASE, ilinkCursor: '', boundMemberId: 'm1' }),
      allowCommands: toJson([]),
      ...extra,
    },
  });
}

describe('iLink · 客户端协议', () => {
  it('拿码 / 查状态 / 发消息：路径、头、体都按协议', async () => {
    const q = await ilinkGetQr(BASE);
    expect(q).toMatchObject({ ok: true, qrcode: 'qrc_1', qrUrl: 'https://ilink.example/x' });
    expect(calls[0].path).toBe('/ilink/bot/get_bot_qrcode');
    const st = await ilinkQrStatus('qrc_1', BASE);
    expect(st).toMatchObject({ ok: true, status: 'confirmed', botToken: 'ilinkbot_T', botId: 'b1@im.bot', userId: 'u1@im.wechat' });

    const long = Array.from({ length: 3 }, (_, i) => `第${i + 1}段${'字'.repeat(900)}`).join('\n\n');
    const s = await ilinkSendText(BASE, 'ilinkbot_T', 'u1@im.wechat', 'ctx-1', long);
    expect(s.ok).toBe(true);
    const sends = calls.filter((c) => c.path.endsWith('/sendmessage'));
    expect(sends.length, '超长要拆段').toBeGreaterThan(1);
    for (const c of sends) {
      const b = c.body as { msg: { context_token: string; message_type: number; client_id: string; to_user_id: string; item_list: { type: number; text_item: { text: string } }[] } };
      expect(b.msg.context_token, '回复必须带入站的 context_token').toBe('ctx-1');
      expect(b.msg.message_type).toBe(2);
      expect(b.msg.to_user_id).toBe('u1@im.wechat');
      expect(b.msg.item_list[0].text_item.text.length).toBeLessThanOrEqual(1500);
      expect(c.headers.authorization).toBe('Bearer ilinkbot_T');
      expect(c.headers.authorizationtype).toBe('ilink_bot_token');
      expect(typeof c.headers['x-wechat-uin']).toBe('string');
    }
    const ids = new Set(sends.map((c) => (c.body as { msg: { client_id: string } }).msg.client_id));
    expect(ids.size, '每段独立 client_id').toBe(sends.length);
  });

  it('🔒 查状态：微信 hold 住超过我们的等待上限 → 当 wait，不是错误（server action 不能挂 35 秒）', async () => {
    const r = await ilinkQrStatus('qrc_slow', BASE, 300);
    expect(r.ok).toBe(true);
    expect(r.status).toBe('wait');
  });

  it('getupdates：ret=-14 → expired（不当成普通错误重试）', async () => {
    mode = 'expired';
    const r = await ilinkGetUpdates(BASE, 'ilinkbot_T', '');
    expect(r.ok).toBe(false);
    expect(r.expired).toBe(true);
  });
});

describe('iLink · 收信循环（真库 + 假服务端）', () => {
  it('🔒 游标先落库；自己的回执跳过；只服务绑定的号；非文字回一句；回复带对应 context_token', async () => {
    await bindOne();
    mode = 'msgs';
    const { running } = await reconcileIlinkLoops();
    expect(running).toBe(1);
    // 等它拉到那一批并回完
    for (let i = 0; i < 40 && calls.filter((c) => c.path.endsWith('/sendmessage')).length < 3; i++) await sleep(100);
    stopIlinkSupervisor();

    const sends = calls.filter((c) => c.path.endsWith('/sendmessage')).map((c) => (c.body as { msg: { context_token: string; to_user_id: string; item_list: { text_item: { text: string } }[] } }).msg);
    const byCtx = new Map(sends.map((m) => [m.context_token, m]));
    expect(byCtx.has('ctx-self'), '机器人自己的回执被当成用户消息答了——自嗨').toBe(false);
    expect(byCtx.get('ctx-owner')?.item_list[0].text_item.text, '/热点 应走确定性命令').toMatch(/热榜/);
    expect(byCtx.get('ctx-stranger')?.item_list[0].text_item.text).toMatch(/只服务/);
    expect(byCtx.get('ctx-stranger')?.to_user_id).toBe('stranger@im.wechat');
    expect(byCtx.get('ctx-img')?.item_list[0].text_item.text).toMatch(/只能看懂文字/);

    const row = await prisma.botIntegration.findUnique({ where: { id: 'il1' } });
    expect(readBotSecrets(row!.secretsEnc).ilinkCursor, '游标没落库——下次重启会重放这一批').toBe('cur-1');
    expect(row!.lastInboundAt).not.toBeNull();
    expect(row!.lastOutboundAt).not.toBeNull();
    // 拉取带了 Bearer 且游标从空串开始
    const first = calls.find((c) => c.path.endsWith('/getupdates'));
    expect(first?.headers.authorization).toBe('Bearer ilinkbot_T');
    expect((first?.body as { get_updates_buf: string }).get_updates_buf).toBe('');
  });

  it('🔒 -14：标 expired、清游标、写 lastError、循环停下且对账不再起它', async () => {
    await bindOne();
    mode = 'expired';
    await reconcileIlinkLoops();
    for (let i = 0; i < 40; i++) {
      const s = readBotSecrets((await prisma.botIntegration.findUnique({ where: { id: 'il1' } }))!.secretsEnc);
      if (s.ilinkExpired) break;
      await sleep(100);
    }
    const row = await prisma.botIntegration.findUnique({ where: { id: 'il1' } });
    const s = readBotSecrets(row!.secretsEnc);
    expect(s.ilinkExpired).toBe(true);
    expect(s.ilinkCursor).toBe('');
    expect(row!.lastError).toMatch(/过期/);
    const { running } = await reconcileIlinkLoops();
    expect(running, '过期的还在被起——会一直 -14 打空转').toBe(0);
    stopIlinkSupervisor();
  });

  it('停用 / 删除 → 对账收掉循环', async () => {
    await bindOne();
    expect((await reconcileIlinkLoops()).running).toBe(1);
    await prisma.botIntegration.update({ where: { id: 'il1' }, data: { enabled: false } });
    expect((await reconcileIlinkLoops()).running).toBe(0);
    stopIlinkSupervisor();
  });
});

describe('iLink · 接线口径（源码级）', () => {
  it('🔒 只在 worker 与整机版 web 进程各起一次监督者（游标消费性，两处同时拉会互吞）', () => {
    const w = readFileSync(join(ROOT, 'worker.ts'), 'utf8');
    at(w, 'startIlinkSupervisor()');
    at(w, 'stopIlinkSupervisor()');
    const inst = readFileSync(join(ROOT, 'instrumentation.node.ts'), 'utf8');
    const local = inst.slice(at(inst, "schedulerKind() === 'local'"), inst.length);
    at(local, 'startIlinkSupervisor()');
  });

  it('🔒 循环里游标落库在处理消息之前', () => {
    const src = readFileSync(join(ROOT, 'lib/bot/wechat-ilink-poller.ts'), 'utf8');
    const loop = src.slice(at(src, 'async function runLoop'), at(src, 'async function handleOne'));
    orderedBefore(loop, 'writeBotSecrets(next)', 'handleOne(');
  });

  it('🔒 微信 iLink 在只答不推名单里、不在对外名单里；扫码状态 action 把绑定成员写进 secrets', () => {
    const types = readFileSync(join(ROOT, 'lib/bot/types.ts'), 'utf8');
    expect(types).toMatch(/REPLY_ONLY_PROVIDERS[^\n]*'wechat'/);
    expect(types).not.toMatch(/EXTERNAL_PROVIDERS[^\n]*'wechat'[,\]]/);
    const act = readFileSync(join(ROOT, 'app/(app)/settings/bot-actions.ts'), 'utf8');
    const fn = act.slice(at(act, 'export async function actWechatIlinkStatus'), act.length);
    expect(fn).toContain('boundMemberId: s.memberId');
    expect(fn, '新登录态要清游标，否则拿旧游标去拉新会话').toContain("ilinkCursor: ''");
    expect(fn).toContain('ilinkExpired: false');
  });

  it('🔒 体检不打 getupdates（会和收信循环互吞消息）', () => {
    const d = readFileSync(join(ROOT, 'lib/bot/diagnose.ts'), 'utf8');
    const fn = d.slice(at(d, 'function diagnoseWechatIlink'), d.length);
    expect(fn).not.toContain('ilinkGetUpdates');
  });

  it('🔒 已删除的网关扫码通道没有残留（非官方协议那套整个撤掉）', () => {
    for (const f of ['lib/bot/wechat-gateway.ts', 'components/WechatScanConnect.tsx', 'app/api/bot/wechat-scan/events/[key]/route.ts']) {
      expect(() => readFileSync(join(ROOT, f)), `${f} 还在`).toThrow();
    }
    const types = readFileSync(join(ROOT, 'lib/bot/types.ts'), 'utf8');
    expect(types).not.toContain('wechat_scan');
    expect(readFileSync(join(ROOT, 'lib/edition.ts'), 'utf8')).not.toContain('wechatProtocolBot');
  });
});
