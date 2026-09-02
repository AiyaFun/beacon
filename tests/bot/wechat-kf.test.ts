import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { at, orderedBefore } from '../helpers/anchor';

// 微信客服通道（官方，2026-09-01「微信直接做」）。
// 三层钉子：客户端协议形状 / 出站分发必须拒绝它 / 路由里两条最会静默坏的口径。

const ROOT = process.cwd();

// ── 假企微端点：gettoken / sync_msg / send_msg ──
const calls: { path: string; body?: unknown }[] = [];
let syncReply: unknown = { errcode: 0, msg_list: [], next_cursor: 'c-1' };
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    calls.push({ path, body: body ? JSON.parse(body) : undefined });
    res.setHeader('content-type', 'application/json');
    if (path.endsWith('/gettoken')) return res.end(JSON.stringify({ errcode: 0, access_token: 'tok-1', expires_in: 7200 }));
    if (path.endsWith('/kf/sync_msg')) return res.end(JSON.stringify(syncReply));
    if (path.endsWith('/kf/send_msg')) return res.end(JSON.stringify({ errcode: 0 }));
    if (path.endsWith('/kf/send_msg_on_event')) return res.end(JSON.stringify({ errcode: 0 }));
    if (path.endsWith('/kf/account/list')) return res.end(JSON.stringify({ errcode: 0, account_list: [{ open_kfid: 'kf-1', name: '客服小烽' }] }));
    res.end(JSON.stringify({ errcode: 0 }));
  });
});
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
const port = (srv.address() as AddressInfo).port;
afterAll(() => srv.close());

beforeEach(() => { calls.length = 0; });

describe('微信客服 · 客户端协议', () => {
  it('sync_msg 带上事件 Token 与 cursor；send_msg 带 open_kfid + touser', async () => {
    // 把企微域名重定向到本地假端点
    const real = globalThis.fetch;
    globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) =>
      real(String(url).replace('https://qyapi.weixin.qq.com', `http://127.0.0.1:${port}`), init)) as typeof fetch;
    try {
      const { kfSyncMsg, kfSendText } = await import('@/lib/bot/wechat-kf');
      syncReply = { errcode: 0, msg_list: [{ msgid: 'm1', msgtype: 'text', origin: 3, text: { content: '在吗' }, external_userid: 'wx-u1', open_kfid: 'kf-1' }], next_cursor: 'c-2' };
      const r = await kfSyncMsg('corp1', 'sec1', 'evt-token', 'c-1');
      expect(r.ok).toBe(true);
      expect(r.msgs[0]?.text?.content).toBe('在吗');
      expect(r.nextCursor).toBe('c-2');
      const syncCall = calls.find((c) => c.path.endsWith('/kf/sync_msg'))?.body as { token: string; cursor: string };
      expect(syncCall.token).toBe('evt-token');
      expect(syncCall.cursor, '不带 cursor 会每次从头拉、重放答过的消息').toBe('c-1');

      const s = await kfSendText('corp1', 'sec1', 'kf-1', 'wx-u1', '你好');
      expect(s.ok).toBe(true);
      const sendCall = calls.find((c) => c.path.endsWith('/kf/send_msg'))?.body as { open_kfid: string; touser: string; msgtype: string };
      expect(sendCall.open_kfid).toBe('kf-1');
      expect(sendCall.touser).toBe('wx-u1');
      expect(sendCall.msgtype).toBe('text');
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('微信客服 · 客户端协议（2026-09-02 加固）', () => {
  function redirect() {
    const real = globalThis.fetch;
    globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) =>
      real(String(url).replace('https://qyapi.weixin.qq.com', `http://127.0.0.1:${port}`), init)) as typeof fetch;
    return () => { globalThis.fetch = real; };
  }

  it('sync_msg 带 open_kfid 过滤，并把 has_more 带回来（宕机积压不止一页）', async () => {
    const restore = redirect();
    try {
      const { kfSyncMsg } = await import('@/lib/bot/wechat-kf');
      syncReply = { errcode: 0, msg_list: [], next_cursor: 'c-9', has_more: 1 };
      const r = await kfSyncMsg('corp1', 'sec1', 'evt', 'c-8', 'kf-A');
      expect(r.ok).toBe(true);
      expect(r.hasMore).toBe(true);
      const body = calls.find((c) => c.path.endsWith('/kf/sync_msg'))?.body as { open_kfid?: string };
      expect(body.open_kfid, '企业有多个客服号时不带 open_kfid 会把别的号的消息也拉进来').toBe('kf-A');
    } finally { restore(); }
  });

  it('🔒 超长回复拆成多条按序发，不截断（此前 slice(0,600) 把答案后半截扔了）', async () => {
    const restore = redirect();
    try {
      const { kfSendText } = await import('@/lib/bot/wechat-kf');
      // 4 段 × 303 字：拆开正好 4 条，不触段数上限（上限那条在 wechat-text.test.ts 单独验）
      const long = Array.from({ length: 4 }, (_, i) => `第${i + 1}段${'字'.repeat(300)}`).join('\n\n');
      const r = await kfSendText('corp1', 'sec1', 'kf-1', 'wx-u1', long);
      expect(r.ok).toBe(true);
      const sends = calls.filter((c) => c.path.endsWith('/kf/send_msg')).map((c) => (c.body as { text: { content: string } }).text.content);
      expect(sends.length).toBeGreaterThan(1);
      expect(sends.join('').replace(/\s/g, '')).toBe(long.replace(/\s/g, ''));
      for (const t of sends) expect(t.length).toBeLessThanOrEqual(600);
    } finally { restore(); }
  });

  it('进入会话的欢迎语走 send_msg_on_event 并带 welcome_code', async () => {
    const restore = redirect();
    try {
      const { kfSendWelcome } = await import('@/lib/bot/wechat-kf');
      const r = await kfSendWelcome('corp1', 'sec1', 'WELCOME-1', '你好');
      expect(r.ok).toBe(true);
      const body = calls.find((c) => c.path.endsWith('/kf/send_msg_on_event'))?.body as { code: string; msgtype: string };
      expect(body.code).toBe('WELCOME-1');
      expect(body.msgtype).toBe('text');
    } finally { restore(); }
  });

  it('kf/account/list 解析成 {openKfId,name}（体检第②步用）', async () => {
    const restore = redirect();
    try {
      const { kfListAccounts } = await import('@/lib/bot/wechat-kf');
      const r = await kfListAccounts('corp1', 'sec1');
      expect(r.ok).toBe(true);
      expect(r.accounts).toEqual([{ openKfId: 'kf-1', name: '客服小烽' }]);
    } finally { restore(); }
  });
});

describe('微信客服 · 并发与去重（进程内）', () => {
  it('🔒 runSerialized：同一 key 的两次调用串行执行（并行会读到同一个 cursor、答两遍）', async () => {
    const { runSerialized } = await import('@/lib/bot/wechat-kf');
    const order: string[] = [];
    const a = runSerialized('k', async () => { order.push('a-start'); await new Promise((r) => setTimeout(r, 30)); order.push('a-end'); });
    const b = runSerialized('k', async () => { order.push('b-start'); order.push('b-end'); });
    await Promise.all([a, b]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('runSerialized：前一个抛了不连坐后一个；不同 key 互不等待', async () => {
    const { runSerialized } = await import('@/lib/bot/wechat-kf');
    await expect(runSerialized('e', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    let ran = false;
    await runSerialized('e', async () => { ran = true; });
    expect(ran).toBe(true);
    const order: string[] = [];
    await Promise.all([
      runSerialized('x', async () => { await new Promise((r) => setTimeout(r, 30)); order.push('x'); }),
      runSerialized('y', async () => { order.push('y'); }),
    ]);
    expect(order).toEqual(['y', 'x']);
  });

  it('markSeen：同一 msgid 第二次返回 false；不同集成互不影响', async () => {
    const { markSeen } = await import('@/lib/bot/wechat-kf');
    expect(markSeen('i1', 'm1')).toBe(true);
    expect(markSeen('i1', 'm1')).toBe(false);
    expect(markSeen('i2', 'm1')).toBe(true);
  });
});

describe('微信客服 · 出站分发必须拒绝（48 小时窗口规则）', () => {
  it('🔒 sendVia 对 wechat_kf 如实说不支持，绝不静默成功', async () => {
    const { sendVia } = await import('@/lib/bot');
    const r = await sendVia('wechat_kf', 'https://x.example/hook', {}, { title: 't', lines: [] } as never);
    expect(r.ok, '客服通道被当成广播通道用了——48h 窗口外全是失败还计成功').toBe(false);
    expect(r.error).toMatch(/不支持/);
  });
});

describe('微信客服 · 路由口径（源码级）', () => {
  const SRC = readFileSync(join(ROOT, 'app/api/bot/wechat-kf/events/[key]/route.ts'), 'utf8');

  it('🔒 只处理 origin=3（微信用户发来）；不滤的话机器人会对自己的回执自嗨循环', () => {
    at(SRC, "m.origin !== 3");
  });

  it('🔒 cursor 先落库再逐条处理（宁可漏答一条，不可重放旧消息）', () => {
    orderedBefore(SRC, 'kfCursor: r.nextCursor', 'for (const m of r.msgs)');
  });

  it('🔒 secrets 现读现用（闭包旧快照的 cursor 会重放）', () => {
    const fn = SRC.slice(at(SRC, 'async function syncAndReply'), SRC.length);
    at(fn, 'prisma.botIntegration.findUnique');
    orderedBefore(fn, 'findUnique', 'kfSyncMsg');
  });

  it('🔒 同一集成的拉取串行 + msgid 去重（企微每条消息发一次回调，并行会答两遍）', () => {
    const fn = SRC.slice(at(SRC, 'async function syncAndReply'), SRC.length);
    at(fn, 'runSerialized(integrationId');
    at(fn, 'markSeen(integrationId, m.msgid)');
  });

  it('🔒 has_more 时继续拉，且回调里的 OpenKfId 传给 sync（多客服号时按它过滤）', () => {
    at(SRC, "wecomExtractXml(innerXml, 'OpenKfId')");
    const fn = SRC.slice(at(SRC, 'async function syncAndReply'), SRC.length);
    at(fn, 'if (!r.hasMore) break;');
  });

  it('🔒 缺 CorpID/Secret 不能静默退出：要写 lastError（此前这里直接 return，用户只看到永远不回话）', () => {
    const fn = SRC.slice(at(SRC, 'async function syncAndReply'), at(SRC, 'async function handleOne'));
    const gap = fn.slice(at(fn, '!secrets.corpId || !secrets.appSecret'), at(fn, 'kfSyncMsg('));
    expect(gap).toContain('lastError');
  });

  it('🔒 停用的机器人不回话（但 cursor 照推，恢复后不把积压全答一遍）', () => {
    const fn = SRC.slice(at(SRC, 'async function syncAndReply'), at(SRC, 'async function handleOne'));
    orderedBefore(fn, 'writeBotSecrets(secrets)', 'if (it.enabled)');
  });

  it('🔒 进入会话事件发欢迎语（一对一渠道的身份行开场）；非文字消息回一句能看懂什么', () => {
    const fn = SRC.slice(at(SRC, 'async function handleOne'), SRC.length);
    at(fn, "event_type === 'enter_session'");
    at(fn, 'kfSendWelcome(');
    at(fn, "m.msgtype !== 'text'");
    expect(fn).toMatch(/只能看懂文字/);
  });

  it('🔒 快速 200 + 后台处理（企微回调 5 秒超时，sync+LLM 必超）', () => {
    // 'success' 返回在文件里有多处（各早退分支）——锚定 void 调用之后的那一次
    const i = at(SRC, 'void syncAndReply');
    at(SRC, "return new Response('success')", i);
  });
});


describe('微信客服 · 保存与编辑口径（2026-09-02 三处真缺陷）', () => {
  const ACT = readFileSync(join(ROOT, 'app/(app)/settings/bot-actions.ts'), 'utf8');
  const CARD = readFileSync(join(ROOT, 'app/(app)/settings/BotIntegrationCard.tsx'), 'utf8');
  const JOBS = readFileSync(join(ROOT, 'lib/jobs/handlers.ts'), 'utf8');
  const save = ACT.slice(at(ACT, 'export async function actSaveBot'), at(ACT, 'export async function actRevealBotSecrets'));

  it('🔒 corpId 对 wechat_kf 也要写（此前只有 wecom 写，客服通道回调通了却永远不回话）', () => {
    const line = save.split('\n').find((l) => l.trim().startsWith('corpId:')) ?? '';
    expect(line, 'corpId 那行没把 wechat_kf 算进去').toMatch(/wechat_kf/);
  });

  it('🔒 编辑态 inboundKey（corpId_kf）剥后缀：actSaveBot 与 openEdit 两处都剥，否则每编辑一次多一节 _kf', () => {
    expect(save).toMatch(/replace\(\/_kf\$\/, ''\)/);
    const edit = CARD.slice(at(CARD, 'function openEdit'), at(CARD, 'function secretHint'));
    expect(edit).toMatch(/wechat_kf[\s\S]{0,200}replace\(\/_kf\$\/, ''\)/);
  });

  it('🔒 只答不推的渠道保存时清空 pushEvents，且晨报到点判断跳过它（否则每天一条假「推送失败」）', () => {
    expect(save).toMatch(/isReplyOnlyProvider\(provider\) \? \[\]/);
    const due = JOBS.slice(at(JOBS, 'const due = integrations.filter'), at(JOBS, 'if (due.length === 0)'));
    expect(due).toContain('!isReplyOnlyProvider(it.provider)');
  });

  it('🔒 卡片：只答不推的渠道没有「测试发送」按钮，且回调 URL 在已配置列表里可见', () => {
    const list = CARD.slice(at(CARD, '{/* 已配置列表与详细配置信息 */}'), at(CARD, '{showForm ? ('));
    // [^>]* 会被 onClick 里的 => 截断——按有限长度匹配
    expect(list).toMatch(/!isReplyOnlyProvider\(r\.provider\) && <button[\s\S]{0,200}?>测试发送/);
    expect(list).toContain("/api/bot/wechat-kf/events/${r.inboundKey}");
  });

  it('🔒 微信客服表单里仍有指令白名单：推送开关可以藏，「允许哪些操作」不能跟着藏（1.3.14 真藏了）', () => {
    const form = CARD.slice(at(CARD, '{showForm ? ('), at(CARD, '</Overlay>'));
    const hidden = [...form.matchAll(/!isReplyOnlyProvider\(provider\) && \(<>([\s\S]*?)<\/>\)\}/g)];
    expect(hidden.length, '只答不推渠道的隐藏段应该有（推送事件 + 定时时刻）').toBeGreaterThan(0);
    for (const m of hidden) expect(m[1], '指令白名单被和推送开关一起藏了——管理员没地方改对外渠道的权限').not.toContain('toggleCommand');
    expect(form).toContain('toggleCommand(c.key)');
  });

  it('🔒 对外渠道新建时默认指令只开低风险集（openAddFor 走 EXTERNAL_DEFAULT_COMMANDS）', () => {
    const fn = CARD.slice(at(CARD, 'function openAddFor'), at(CARD, 'function openEdit'));
    expect(fn).toContain('isExternalProvider(key)');
    expect(fn).toContain('EXTERNAL_DEFAULT_COMMANDS');
  });
});
