import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { prisma } from '@/lib/db';
import {
  oaIdentity,
  issueBindCode,
  bindOaByCode,
  issueOaLoginTicket,
  consumeOaLoginTicket,
  joinByInvite,
  memberByOaIdentity,
} from '@/lib/auth/oa';
import { handleInbound } from '@/lib/bot/router';

// 企业应用登录。这是企业版**唯一**的进门方式（短信已在形态闸上关掉），
// 所以每条拒绝分支都要能说清楚下一步，每条放行分支都要一次性、可撤销。

let tenantId = '';
let memberId = '';

beforeEach(async () => {
  vi.stubEnv('BEACON_EDITION', 'appliance');
  vi.stubEnv('BEACON_SITE_URL', 'http://localhost:3070');
  await prisma.verificationCode.deleteMany();
  const t = await prisma.tenant.create({ data: { name: '星野文化', plan: 'enterprise' } });
  tenantId = t.id;
  const m = await prisma.member.create({ data: { tenantId, name: '老王', role: 'owner' } });
  memberId = m.id;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await prisma.tenant.deleteMany({ where: { id: tenantId } });
});

describe('身份串', () => {
  it('不透明 ID 原样保留，绝不转小写 —— 归一化会把两个人折叠成一个身份', () => {
    expect(oaIdentity('feishu', 'ou_AbC123')).toBe('feishu:ou_AbC123');
    expect(oaIdentity('feishu', '  ou_X  ')).toBe('feishu:ou_X');
    expect(() => oaIdentity('feishu', '  ')).toThrow();
  });
});

describe('绑定', () => {
  it('正确的码把 open_id 记到那个成员名下', async () => {
    const code = await issueBindCode(memberId);
    const r = await bindOaByCode(code, 'feishu', 'ou_wang');
    expect(r.ok).toBe(true);
    const m = await prisma.member.findUnique({ where: { id: memberId }, select: { oaIdentity: true } });
    expect(m?.oaIdentity).toBe('feishu:ou_wang');
  });

  it('🔒 同一个码只能用一次', async () => {
    const code = await issueBindCode(memberId);
    expect((await bindOaByCode(code, 'feishu', 'ou_wang')).ok).toBe(true);
    const second = await bindOaByCode(code, 'feishu', 'ou_someone_else');
    expect(second.ok).toBe(false);
  });

  it('🔒 已被别人绑走的 open_id 不许改挂 —— 否则后绑的把先绑的挤得登不进来', async () => {
    const other = await prisma.member.create({ data: { tenantId, name: '小李', role: 'editor', oaIdentity: 'feishu:ou_li' } });
    const code = await issueBindCode(memberId);
    const r = await bindOaByCode(code, 'feishu', 'ou_li');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/已经绑定/);
    // 小李的身份没被动
    const li = await prisma.member.findUnique({ where: { id: other.id }, select: { oaIdentity: true } });
    expect(li?.oaIdentity).toBe('feishu:ou_li');
  });

  it('过期的码不认', async () => {
    const code = await issueBindCode(memberId);
    await prisma.verificationCode.updateMany({ where: { code }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await bindOaByCode(code, 'feishu', 'ou_wang')).ok).toBe(false);
  });
});

describe('登录票据', () => {
  beforeEach(async () => {
    await prisma.member.update({ where: { id: memberId }, data: { oaIdentity: 'feishu:ou_wang' } });
  });

  it('已绑定的人拿得到票据，票据换得出会话', async () => {
    const t = await issueOaLoginTicket('feishu', 'ou_wang');
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    const r = await consumeOaLoginTicket(t.ticket, 'vitest');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sess = await prisma.authSession.findFirst({ where: { token: r.token } });
    expect(sess?.memberId).toBe(memberId);
  });

  it('🔒 票据只能用一次 —— 链接会留在聊天记录里', async () => {
    const t = await issueOaLoginTicket('feishu', 'ou_wang');
    if (!t.ok) throw new Error('should issue');
    expect((await consumeOaLoginTicket(t.ticket)).ok).toBe(true);
    const again = await consumeOaLoginTicket(t.ticket);
    expect(again.ok).toBe(false);
  });

  it('并发调用（SQLite 下）也只换出一个会话', async () => {
    const t = await issueOaLoginTicket('feishu', 'ou_wang');
    if (!t.ok) throw new Error('should issue');
    const results = await Promise.all([
      consumeOaLoginTicket(t.ticket),
      consumeOaLoginTicket(t.ticket),
      consumeOaLoginTicket(t.ticket),
    ]);
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(await prisma.authSession.count({ where: { memberId } })).toBe(1);
  });

  it('🔒 两个请求都越过 findFirst 时，只有一个抢得到消费权', async () => {
    // 【为什么要手工摆出这个交错】上面那条 Promise.all 证明不了原子闸：
    // SQLite 写全局串行、Prisma 连接池又把调用排成队，三次调用实际是依次跑完的，
    // 第二、三次在 findFirst(consumed:false) 就被挡掉 —— 把 updateMany 的 count 判断
    // 整个删掉，那条用例照样绿（mutation 实测如此）。
    // 但整机版是 SQLite，私有化版是 **Postgres**：多连接 + READ COMMITTED，
    // 两个请求真的可能同时读到同一条未消费记录。那道闸是为后者写的，
    // 所以这里直接验它依赖的原语：条件写在并发下恰好只放行一个。
    const t = await issueOaLoginTicket('feishu', 'ou_wang');
    if (!t.ok) throw new Error('should issue');
    const recA = await prisma.verificationCode.findFirst({ where: { code: t.ticket, consumed: false } });
    const recB = await prisma.verificationCode.findFirst({ where: { code: t.ticket, consumed: false } });
    expect(recA?.id).toBe(recB?.id); // 两边都认为自己拿到了这张票

    const a = await prisma.verificationCode.updateMany({ where: { id: recA!.id, consumed: false }, data: { consumed: true } });
    const b = await prisma.verificationCode.updateMany({ where: { id: recB!.id, consumed: false }, data: { consumed: true } });
    expect(a.count + b.count, '条件写放行了不止一个').toBe(1);
  });

  it('🔒 源码：消费走的是条件写而不是先读后写', async () => {
    // 行为层在 SQLite 上盖不住这道闸（见上一条），只能同时钉住代码形状：
    // 谁要是把它改成「读出来 → 判 consumed → update」，Postgres 上就能一票换多个会话。
    const fs = await import('node:fs');
    const src = fs.readFileSync('lib/auth/oa.ts', 'utf-8');
    const fn = src.slice(src.indexOf('export async function consumeOaLoginTicket'));
    expect(fn).toMatch(/updateMany\(\{[\s\S]*?where: \{ id: rec\.id, consumed: false \}/);
    expect(fn).toMatch(/consumed\.count === 0/);
  });

  it('🔒 签发后成员被停用，票据即便没过期也换不出会话', async () => {
    const t = await issueOaLoginTicket('feishu', 'ou_wang');
    if (!t.ok) throw new Error('should issue');
    await prisma.member.update({ where: { id: memberId }, data: { status: 'suspended' } });
    const r = await consumeOaLoginTicket(t.ticket);
    expect(r.ok).toBe(false);
  });

  it('没见过的人当场加入为「编辑」并拿到链接 —— 员工只需要记住「登录」两个字', async () => {
    const t = await issueOaLoginTicket('feishu', 'ou_stranger', '小张');
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    expect(t.joined, '应当标记为新加入，好让机器人把身份说清楚').toBe(true);
    expect(t.memberName).toBe('小张');
    const m = await memberByOaIdentity('feishu:ou_stranger');
    expect(m?.role, '自动加入固定 editor —— 不猜「第一个进来的人是管理员」').toBe('editor');
    expect((await consumeOaLoginTicket(t.ticket)).ok).toBe(true);
  });

  it('🔒 自动加入绝不静默：管理员要在通知里看得到是谁进来了', async () => {
    const ws = await prisma.workspace.create({ data: { tenantId, name: 'W-notify' } });
    await issueOaLoginTicket('feishu', 'ou_quiet', '小李');
    const n = await prisma.notification.findFirst({
      where: { workspaceId: ws.id, title: { contains: '小李' } },
    });
    expect(n, '新成员自动加入没有产生站内通知').not.toBeNull();
    expect(n?.link).toBe('/members');
    const { ROLE_LABEL: RL } = await import('@/lib/rbac');
    expect(n?.body).toContain(`「${RL.editor}」`);
  });

  it('已是成员的人再发「登录」不会重复加入', async () => {
    const first = await issueOaLoginTicket('feishu', 'ou_twice', '小王');
    expect(first.ok && first.joined).toBe(true);
    const second = await issueOaLoginTicket('feishu', 'ou_twice', '小王');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.joined).toBe(false);
    expect(await prisma.member.count({ where: { oaIdentity: 'feishu:ou_twice' } })).toBe(1);
  });

  it('乱填的票据直接拒（不去查库）', async () => {
    expect((await consumeOaLoginTicket('../../etc/passwd')).ok).toBe(false);
    expect((await consumeOaLoginTicket('')).ok).toBe(false);
  });
});

describe('凭邀请码加入', () => {
  async function makeInvite(role = 'editor') {
    return prisma.invite.create({
      data: {
        tenantId, role, token: `inv_${Math.random().toString(16).slice(2)}`,
        invitedBy: memberId, expiresAt: new Date(Date.now() + 86400_000),
      },
    });
  }

  it('建成员、绑身份、把邀请标成已用', async () => {
    const inv = await makeInvite('editor');
    const r = await joinByInvite(inv.token, 'feishu', 'ou_new', '小张');
    expect(r.ok).toBe(true);
    const m = await memberByOaIdentity('feishu:ou_new');
    expect(m?.name).toBe('小张');
    expect(m?.role).toBe('editor');
    const after = await prisma.invite.findUnique({ where: { id: inv.id } });
    expect(after?.status).toBe('accepted');
  });

  it('🔒 同一串邀请码不能用两次', async () => {
    const inv = await makeInvite();
    expect((await joinByInvite(inv.token, 'feishu', 'ou_a', 'A')).ok).toBe(true);
    const second = await joinByInvite(inv.token, 'feishu', 'ou_b', 'B');
    expect(second.ok).toBe(false);
    expect(await memberByOaIdentity('feishu:ou_b')).toBeNull();
  });

  it('🔒 并发使用同一串邀请码，只进得来一个人', async () => {
    // 同上：串行那条在 status !== 'pending' 就被挡了，证明不了事务里的 claimed.count 闸。
    // 邀请码会被贴在群里，多个人同时点是常态。
    const inv = await makeInvite();
    const results = await Promise.all([
      joinByInvite(inv.token, 'feishu', 'ou_p1', 'P1'),
      joinByInvite(inv.token, 'feishu', 'ou_p2', 'P2'),
      joinByInvite(inv.token, 'feishu', 'ou_p3', 'P3'),
    ]);
    expect(results.filter((r) => r.ok).length, '一串邀请码放进来了不止一个人').toBe(1);
    const joined = await prisma.member.count({ where: { tenantId, oaIdentity: { startsWith: 'feishu:ou_p' } } });
    expect(joined).toBe(1);
  });

  it('已经是成员的人不用再加入', async () => {
    await prisma.member.update({ where: { id: memberId }, data: { oaIdentity: 'feishu:ou_wang' } });
    const inv = await makeInvite();
    const r = await joinByInvite(inv.token, 'feishu', 'ou_wang', '老王');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/已经是成员/);
  });
});

describe('机器人指令', () => {
  it('🔒 群里说「登录」不发链接，而是让他私聊 —— 发进群等于谁点谁登进来', async () => {
    await prisma.member.update({ where: { id: memberId }, data: { oaIdentity: 'feishu:ou_wang' } });
    const ws = await prisma.workspace.create({ data: { tenantId, name: 'W' } });
    const reply = await handleInbound(ws.id, '登录', { provider: 'feishu', senderId: 'ou_wang', isGroup: true });
    expect(reply).toMatch(/私聊/);
    expect(reply).not.toMatch(/magic\?t=/);
  });

  it('私聊「登录」回一条一次性链接', async () => {
    await prisma.member.update({ where: { id: memberId }, data: { oaIdentity: 'feishu:ou_wang' } });
    const ws = await prisma.workspace.create({ data: { tenantId, name: 'W' } });
    const reply = await handleInbound(ws.id, '登录', { provider: 'feishu', senderId: 'ou_wang', isGroup: false });
    expect(reply).toMatch(/\/api\/auth\/oa\/magic\?t=[0-9a-f]+/);
    const ticket = reply.match(/magic\?t=([0-9a-f]+)/)?.[1] ?? '';
    expect((await consumeOaLoginTicket(ticket)).ok).toBe(true);
  });

  it('新人私聊「登录」一条命令就进来了，回复里说清身份', async () => {
    const ws = await prisma.workspace.create({ data: { tenantId, name: 'W2' } });
    const reply = await handleInbound(ws.id, '登录', {
      provider: 'feishu', senderId: 'ou_newbie', senderName: '小陈', isGroup: false,
    });
    expect(reply).toMatch(/欢迎，小陈/);
    // 角色名必须和成员页上的标签一字不差 —— 写死「成员」而页面显示「编辑」，
    // 用户会以为那是两种不同的身份（真机 2026-08-19 漂过一次）
    const { ROLE_LABEL } = await import('@/lib/rbac');
    expect(reply).toContain(`「${ROLE_LABEL.editor}」`);
    expect(reply).toMatch(/magic\?t=/);
  });

  it('取不到 open_id 时说清楚，不静默', async () => {
    const ws = await prisma.workspace.create({ data: { tenantId, name: 'W' } });
    const reply = await handleInbound(ws.id, '登录', { provider: 'feishu', isGroup: false });
    expect(reply).toMatch(/取不到/);
  });
});

// ── 网页授权（私有化版）────────────────────────────────────────────────
// 整机版走不了这条路（localhost 回跳只对本机浏览器有效），所以按钮只在 private 上渲染。
// 这里钉住的是三件会出安全事故的事：state 必须比对、网页路径不做自动加入、票据/凭证不留在地址栏。
describe('网页授权的安全形状（源码级）', () => {
  it('回调必须比对 state —— 不比对就是 CSRF：受害者会被登录成攻击者的账号', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('app/api/auth/oa/feishu/callback/route.ts', 'utf-8');
    expect(src).toMatch(/state !== cookieState/);
    expect(src).toMatch(/STATE_COOKIE, '', \{ path: '\/', maxAge: 0 \}/); // 用完即焚
  });

  it('🔒 网页这条路不做自动加入 —— 授权链接可以被转发到公司外', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('app/api/auth/oa/feishu/callback/route.ts', 'utf-8');
    // 没带邀请码就必须拒绝，而不是像私聊那条路一样当场建人
    expect(src).toMatch(/if \(!inviteToken\) return fail\(/);
    expect(src).not.toMatch(/autoJoin/);
  });

  it('两个端点都带形态闸', async () => {
    const fs = await import('node:fs');
    for (const f of [
      'app/api/auth/oa/feishu/callback/route.ts',
      'app/api/auth/oa/feishu/redirect/route.ts',
    ]) {
      const src = fs.readFileSync(f, 'utf-8');
      expect(src, `${f} 缺形态闸`).toMatch(/if \(!can\('oaLogin'\)\) return new NextResponse\('Not Found', \{ status: 404 \}\)/);
    }
  });

  it('登录页只在 private 上渲染网页授权按钮（整机版点了必然跳不回来）', async () => {
    const fs = await import('node:fs');
    const page = fs.readFileSync('app/login/page.tsx', 'utf-8');
    expect(page).toMatch(/webAuth=\{edition\(\) === 'private'\}/);
    const panel = fs.readFileSync('app/login/OaLoginPanel.tsx', 'utf-8');
    expect(panel).toMatch(/webAuth && name === '飞书'/);
  });
});
