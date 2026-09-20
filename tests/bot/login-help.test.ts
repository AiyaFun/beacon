import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '@/lib/db';

// 「卡在登录页了，把那一页发给我」（2026-09-17，用户：「遇到问题比如登录的话，
// 可以以截图的方式发送登录后，再进行采集」）。
//
// 这一组钉的是三件事：
//   ① 二维码只**私聊**给派活的人——群里那条永远不带图（二维码等于一把钥匙）；
//   ② 私发不出去时如实降级成文字，绝不假装发过了；
//   ③ 限流：执行器每几秒重判一次登录状态，不能把人的私聊刷屏。

const sent: { kind: string; to: string; body: unknown }[] = [];

vi.mock('@/lib/bot/image', async (orig) => {
  const actual = await orig<typeof import('@/lib/bot/image')>();
  return {
    ...actual,
    dmImage: async (input: { userId: string; image: { data: Buffer }; caption: string }) => {
      sent.push({ kind: 'dm-image', to: input.userId, body: { bytes: input.image.data.length, caption: input.caption } });
      return dmResult;
    },
  };
});

vi.mock('@/lib/bot/index', async (orig) => {
  const actual = await orig<typeof import('@/lib/bot/index')>();
  return {
    ...actual,
    sendToChat: async (_ws: string, _iid: string, chatId: string, message: unknown) => {
      sent.push({ kind: 'chat', to: chatId, body: message });
      return { ok: true };
    },
  };
});

let dmResult: { ok: boolean; error?: string; unsupported?: boolean } = { ok: true };

const { requestLoginHelp, MAX_HELPS_PER_TASK } = await import('@/lib/bot/login-help');
const { decodeDataUrl } = await import('@/lib/bot/data-url');

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const SHOT = { data: Buffer.from('fake-jpeg-bytes'), mime: 'image/jpeg' };

async function seed(opts: { oa?: string | null; botChatRef?: string | null } = {}) {
  await prisma.tenant.create({ data: { id: 't1', name: 'T', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: 'W' } });
  await prisma.creatorAccount.create({ data: { id: 'a1', workspaceId: 'w1', name: '号', platform: 'douyin', status: 'active' } });
  await prisma.member.create({ data: { id: 'm1', tenantId: 't1', name: '爱丽丝', role: 'editor', status: 'active', oaIdentity: opts.oa === undefined ? 'feishu:ou_alice' : opts.oa } });
  await prisma.botIntegration.create({ data: { id: 'bi1', workspaceId: 'w1', provider: 'feishu', label: 'B', inboundKey: 'cli_x', pushEvents: '[]' } });
  await prisma.browserTask.create({
    data: { id: 'bt1', workspaceId: 'w1', kind: 'collect_self_backend', payload: JSON.stringify({ kind: 'collect_self_backend', platform: 'douyin' }), status: 'claimed', createdBy: 'm1', expiresAt: new Date(Date.now() + 3600_000) },
  });
  await prisma.agentRun.create({
    data: {
      id: 'r1', workspaceId: 'w1', accountId: 'a1', memberId: 'm1', goal: '回填抖音后台',
      status: 'waiting_browser', waitingOn: 'browser:bt1',
      botChatRef: opts.botChatRef === undefined ? 'feishu:bi1:oc_1' : opts.botChatRef,
    },
  });
}

beforeEach(async () => {
  sent.length = 0;
  dmResult = { ok: true };
  await prisma.notification.deleteMany();
  await prisma.agentRun.deleteMany();
  await prisma.browserTask.deleteMany();
  await prisma.botIntegration.deleteMany();
  await prisma.tenant.deleteMany({});
});

describe('① 二维码只私聊给派活的人', () => {
  it('私发成功：图发给他本人，群里只有一句话、且不带图', async () => {
    await seed();
    const r = await requestLoginHelp({ workspaceId: 'w1', taskId: 'bt1', platform: 'douyin', url: 'https://creator.douyin.com/login', screenshot: SHOT });
    expect(r.delivered).toBe('dm');

    const dm = sent.find((x) => x.kind === 'dm-image');
    expect(dm?.to).toBe('ou_alice'); // oaIdentity 去掉 provider 前缀
    expect(String((dm?.body as { caption: string }).caption)).toMatch(/别转发/); // 提醒他这是凭证

    const chat = sent.find((x) => x.kind === 'chat');
    expect(chat?.to).toBe('oc_1');
    expect((chat?.body as { kind: string }).kind).toBe('text'); // 🔒 群里那条永远是纯文字
    expect(JSON.stringify(chat?.body)).not.toMatch(/base64|image|二维码图/);
  });

  it('🔒 群里那条**不带任何图**——这条路根本不给「发到群里」的入口', () => {
    const src = read('lib/bot/login-help.ts');
    // 群里只用 sendToChat + kind:'text'；发图只走 dmImage
    expect(src).toMatch(/kind: 'text', text: groupText/);
    const dmLines = src.split('\n').filter((l) => l.includes('dmImage('));
    expect(dmLines.length).toBe(1);
    // image.ts 的**代码里**没有任何往群里发的东西。
    // ⚠️ 不能简单地禁 chat_id：Telegram 的私聊收件人参数本来就叫 chat_id（一个人也是一个 chat）。
    // 要禁的是各家「发到群」的那几个具体写法。
    const img = read('lib/bot/image.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(img).not.toMatch(/receive_id_type=chat_id/); // 飞书发群
    expect(img).not.toMatch(/sendToChat|webhookUrl.*post|toparty|totag/); // 群 webhook / 企微发部门发标签
  });

  it('🔒 截图不落库：这条链路一个字节都不写进任何表', () => {
    const src = read('lib/bot/login-help.ts');
    expect(src).not.toMatch(/mediaAsset|material\.create|screenshot.*create\(/i);
  });
});

describe('② 发不出去就如实降级', () => {
  it('没配自建应用 / 私聊失败 → 群里说清原因，不假装发过了', async () => {
    await seed();
    dmResult = { ok: false, unsupported: true, error: '飞书要配成自建应用才能私聊发图' };
    const r = await requestLoginHelp({ workspaceId: 'w1', taskId: 'bt1', platform: 'douyin', screenshot: SHOT });
    expect(r.delivered).toBe('chat');
    const chat = sent.find((x) => x.kind === 'chat');
    expect(String((chat?.body as { text: string }).text)).toMatch(/自建应用/);
    expect(String((chat?.body as { text: string }).text)).toMatch(/要登录/);
  });

  it('认不出他的企业应用身份（没绑过）→ 不乱发给别人', async () => {
    await seed({ oa: null });
    const r = await requestLoginHelp({ workspaceId: 'w1', taskId: 'bt1', platform: 'douyin', screenshot: SHOT });
    expect(sent.find((x) => x.kind === 'dm-image')).toBeUndefined();
    expect(r.delivered).toBe('chat');
  });

  it('站内派的活（没有群上下文）→ 只写一条站内通知，且只给发起人看', async () => {
    await seed({ botChatRef: null });
    const r = await requestLoginHelp({ workspaceId: 'w1', taskId: 'bt1', platform: 'douyin', screenshot: SHOT });
    expect(r.delivered).toBe('notification');
    expect(sent).toHaveLength(0);
    const n = await prisma.notification.findFirst({ where: { workspaceId: 'w1' } });
    expect(n?.memberId).toBe('m1');
    expect(n?.title).toMatch(/要登录/);
  });
});

describe('③ 限流：不把人的私聊刷屏', () => {
  it(`同一条任务最多 ${MAX_HELPS_PER_TASK} 次，且两次之间要隔一会儿`, async () => {
    await seed();
    const first = await requestLoginHelp({ workspaceId: 'w1', taskId: 'bt1', screenshot: SHOT });
    expect(first.delivered).toBe('dm');
    // 紧接着再来一次：被限流挡掉，一条都不发
    sent.length = 0;
    const second = await requestLoginHelp({ workspaceId: 'w1', taskId: 'bt1', screenshot: SHOT });
    expect(second.delivered).toBe('skipped');
    expect(sent).toHaveLength(0);
  });

  it('🔒 求助失败绝不抛（采集卡住已经够糟，通知失败不该再把这次采集带崩）', async () => {
    // 什么都没建：库里查不到运行、集成，照样安静返回
    await expect(requestLoginHelp({ workspaceId: 'nope', taskId: 'nope', screenshot: SHOT })).resolves.toMatchObject({ delivered: expect.any(String) });
  });
});

describe('④ data URL 解码', () => {
  it('认 jpeg/png/webp，别的一律不收', () => {
    const png = `data:image/png;base64,${Buffer.from('x').toString('base64')}`;
    expect(decodeDataUrl(png)?.mime).toBe('image/png');
    expect(decodeDataUrl('data:text/html;base64,aaa')).toBeNull();
    expect(decodeDataUrl('https://example.com/a.png')).toBeNull();
    expect(decodeDataUrl('')).toBeNull();
    expect(decodeDataUrl(null)).toBeNull();
  });
});

describe('⑤ 执行器怎么求助（接口行为）', () => {
  it('鉴权、状态、落地都对：claimed 的活能求助，任务状态一个字不动', async () => {
    await seed();
    const { issueIngestToken } = await import('@/lib/ingest/token');
    const { POST } = await import('@/app/api/ingest/tasks/route');
    const { token } = await issueIngestToken({ workspaceId: 'w1', memberId: 'm1', label: '桌面执行器' });

    const call = (body: unknown, tk: string | null = token) =>
      POST(new Request('http://x/api/ingest/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(tk ? { 'x-beacon-ingest-token': tk } : {}) },
        body: JSON.stringify(body),
      }));

    // 没令牌 → 401
    expect((await call({ taskId: 'bt1', action: 'need_login' }, null)).status).toBe(401);

    // 正常求助
    const res = await call({ taskId: 'bt1', action: 'need_login', url: 'https://creator.douyin.com/login', screenshot: `data:image/jpeg;base64,${Buffer.from('x').toString('base64')}` });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(sent.some((x) => x.kind === 'dm-image')).toBe(true);

    // 🔒 求助不是交活：任务还在 claimed，等执行器接着等
    const after = await prisma.browserTask.findUnique({ where: { id: 'bt1' } });
    expect(after?.status).toBe('claimed');
    expect(after?.result).toBeNull();
  });

  it('不是 claimed 的活不给求助（被取代/已交付的活不该再发通知）', async () => {
    await seed();
    await prisma.browserTask.update({ where: { id: 'bt1' }, data: { status: 'pending' } });
    const { issueIngestToken } = await import('@/lib/ingest/token');
    const { POST } = await import('@/app/api/ingest/tasks/route');
    const { token } = await issueIngestToken({ workspaceId: 'w1', memberId: 'm1', label: '桌面执行器' });
    const res = await POST(new Request('http://x/api/ingest/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-beacon-ingest-token': token },
      body: JSON.stringify({ taskId: 'bt1', action: 'need_login' }),
    }));
    expect(res.status).toBe(409);
    expect(sent).toHaveLength(0);
  });

  it('截图不是合法的 data:image → 丢掉截图，求助照发（与解析上报同一条「截断不打回」口径）', async () => {
    await seed();
    const { issueIngestToken } = await import('@/lib/ingest/token');
    const { POST } = await import('@/app/api/ingest/tasks/route');
    const { token } = await issueIngestToken({ workspaceId: 'w1', memberId: 'm1', label: '桌面执行器' });
    const res = await POST(new Request('http://x/api/ingest/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-beacon-ingest-token': token },
      body: JSON.stringify({ taskId: 'bt1', action: 'need_login', screenshot: 'javascript:alert(1)' }),
    }));
    expect(res.status).toBe(200);
    expect(sent.some((x) => x.kind === 'dm-image')).toBe(false); // 没图
    expect(sent.some((x) => x.kind === 'chat')).toBe(true); // 但群里说了一声
  });
});

describe('🔒 接线：三条执行路径都会求助', () => {
  it('服务端：任务接口认 need_login，且不改任务状态', () => {
    const src = read('app/api/ingest/tasks/route.ts');
    expect(src).toMatch(/body\.action === 'need_login'/);
    expect(src).toMatch(/requestLoginHelp/);
    // 求助不是交活：从判断 action 到返回的这一段里不许出现 completeTask，也不许改 status
    const from = src.indexOf("if (body.action === 'need_login')");
    const to = src.indexOf('return json({ ok: true, delivered', from);
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const seg = src.slice(from, to);
    expect(seg).not.toMatch(/completeTask|browserTask\.update/);
  });

  it('整机版本机浏览器：主页 / 配方 / 创作者后台三条都接了「先发图再等」', () => {
    const src = read('lib/browser/local-collect.ts');
    expect((src.match(/askAndWaitForLogin\(/g) ?? []).length).toBeGreaterThanOrEqual(4); // 1 处定义 + 3 处调用
    expect(src).toMatch(/LOGIN_WAIT_BUDGET_MS/);
    // 只在有人等的时候等：不传 help 就一秒都不等
    expect(src).toMatch(/if \(!help\) return false;/);
  });

  it('🔒 版本握手：服务端自报 supports，旧服务端上客户端一律不发（不然那条活会被判失败）', () => {
    const route = read('app/api/ingest/tasks/route.ts');
    expect(route).toMatch(/SERVER_SUPPORTS = \['need_login'\]/);
    expect(route).toMatch(/supports: SERVER_SUPPORTS/);
    const rs = read('desktop/src-tauri/src/executor.rs');
    expect(rs).toMatch(/fn server_supports_need_login/);
    expect(rs).toMatch(/__supportsNeedLogin/);
  });

  it('桌面执行器（Rust）：两处等登录都会先把那一页发出去', () => {
    const src = read('desktop/src-tauri/src/executor.rs');
    expect((src.match(/ask_login_help\(/g) ?? []).length).toBeGreaterThanOrEqual(3); // 1 定义 + 2 调用
    expect(src).toMatch(/Page\.captureScreenshot/);
    // 截图要过服务端那道 150000 字符的闸
    expect(src).toMatch(/150_000/);
  });

  it('🔒 等待预算与工具超时是一对（谁也不能单独改）', () => {
    expect(read('lib/agent/tools.ts')).toMatch(/LOGIN_WAIT_BUDGET_MS/);
    expect(read('lib/browser/local-collect.ts')).toMatch(/dispatch_browser_task 的\s*\n?\s*\/\/?\s*timeoutMs|dispatch_browser_task 的 timeoutMs/);
  });
});
