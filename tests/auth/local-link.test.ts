import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';
import { issueLocalLoginTicket, consumeLocalLoginTicket } from '@/lib/auth/local-link';

// 本机一次性登录链接。
//
// 【它补的是什么】企业版关掉了短信通道，登录唯一通路是私聊企业应用机器人。
// 客户没配飞书/钉钉/企微时，整台机器只有装机那个人能用——他的会话一过期自己也进不去。
//
// 【为什么不能拿装机口令顶】那是一次性装机凭证：明文写在 .env、装机时打印在终端、
// 还抄进了桌面的《安装说明》。延伸成登录口令 = 桌面上一张纸变成永久门钥匙。
// 所以这份用例除了验票据本身，还要钉死「这条路的权力来源不是装机口令」。

let tenantId: string;
let memberId: string;

beforeEach(async () => {
  await prisma.verificationCode.deleteMany();
  await prisma.authSession.deleteMany();
  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  tenantId = tenant.id;
  const m = await prisma.member.create({ data: { tenantId, name: '张三', role: 'owner' } });
  memberId = m.id;
});

describe('票据的基本性质', () => {
  it('签出来能换会话', async () => {
    const issued = await issueLocalLoginTicket(tenantId, memberId);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const r = await consumeLocalLoginTicket(issued.ticket, 'UA');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const session = await prisma.authSession.findFirst({ where: { token: r.token } });
    expect(session?.memberId).toBe(memberId);
  });

  it('**只能用一次**（链接会被复制到聊天记录里）', async () => {
    const issued = await issueLocalLoginTicket(tenantId, memberId);
    if (!issued.ok) throw new Error('签票失败');

    expect((await consumeLocalLoginTicket(issued.ticket)).ok).toBe(true);
    const second = await consumeLocalLoginTicket(issued.ticket);
    expect(second.ok, '第二次还能换会话 = 谁看到聊天记录谁都能进').toBe(false);
  });

  it('过期就不认（有效期 5 分钟）', async () => {
    const issued = await issueLocalLoginTicket(tenantId, memberId);
    if (!issued.ok) throw new Error('签票失败');
    expect(issued.expiresInMinutes).toBe(5);

    await prisma.verificationCode.updateMany({
      where: { code: issued.ticket },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await consumeLocalLoginTicket(issued.ticket)).ok).toBe(false);
  });

  it('乱填的票据当场打回，不去查库', async () => {
    for (const bad of ['', 'abc', '不是票据', 'x'.repeat(200)]) {
      expect((await consumeLocalLoginTicket(bad)).ok, `${bad} 不该通过`).toBe(false);
    }
  });

  it('签票之后成员被删了 → 票据作废（还在有效期内也不行）', async () => {
    const issued = await issueLocalLoginTicket(tenantId, memberId);
    if (!issued.ok) throw new Error('签票失败');
    await prisma.member.delete({ where: { id: memberId } });

    const r = await consumeLocalLoginTicket(issued.ticket);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('停用');
  });
});

describe('跨租户越权', () => {
  it('给别家租户的成员签不出票', async () => {
    const other = await prisma.tenant.create({ data: { name: 'O', plan: 'free' } });
    const otherMember = await prisma.member.create({ data: { tenantId: other.id, name: '李四', role: 'owner' } });

    // 不校验的话，拿到一个任意 memberId 就能给别家的人签一张登录票
    const r = await issueLocalLoginTicket(tenantId, otherMember.id);
    expect(r.ok).toBe(false);
    expect(await prisma.verificationCode.count()).toBe(0);
  });
});

describe('权力来源：已登录的管理员，不是装机口令', () => {
  const read = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');

  it('签发动作要 member.invite 权限，并且挡掉演示租户', () => {
    const src = read('app/(app)/members/actions.ts');
    const fn = src.slice(src.indexOf('export async function actIssueLoginLink'));
    expect(fn, '没有权限校验 = 任何成员都能给自己签一张 owner 的票').toMatch(/requireRole\(s, 'member\.invite'\)/);
    expect(fn, '演示租户不该能签真会话').toMatch(/assertNotDemo/);
  });

  it('**绝不**读装机口令（那是印在桌面说明书上的一次性凭证）', () => {
    for (const p of ['lib/auth/local-link.ts', 'app/api/auth/local/magic/route.ts']) {
      const src = read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(src, `${p} 碰了装机口令——那会让桌面上的一张纸变成永久门钥匙`)
        .not.toMatch(/BEACON_SETUP_TOKEN|setupToken|assertSetupAllowed/);
    }
  });

  it('SaaS 形态下这条通道不存在（两处各判一次）', () => {
    const route = read('app/api/auth/local/magic/route.ts');
    expect(route, '落地路由没有形态闸').toMatch(/edition\(\) === 'saas'/);
    const action = read('app/(app)/members/actions.ts');
    const fn = action.slice(action.indexOf('export async function actIssueLoginLink'));
    expect(fn, '签发那侧也要判——只拦落地不拦签发，票据照样能被签出来').toMatch(/edition\(\) === 'saas'/);
  });

  it('中间件放行了这条路（不放行的话点链接会被 307 弹回登录页）', () => {
    const mw = read('middleware.ts');
    expect(mw).toMatch(/'\/api\/auth\/local'/);
  });
});
