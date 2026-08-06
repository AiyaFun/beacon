import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import {
  issueIngestToken,
  listIngestTokens,
  revokeIngestToken,
  revokeAllIngestTokens,
  resolveIngestToken,
  deviceLabelFromUA,
} from '@/lib/ingest/token';
import { workspaceByIngestToken } from '@/lib/ingest/competitor';

// 采集令牌按设备签发（2026-07-30）。
//
// 【它替换掉的是什么】此前令牌是 `Workspace.ingestToken` 上的**一个字段**——整个工作区共用一串。
// 那个形状下「吊销」只有全有或全无两档：同事离职、笔记本丢了、只想收回自己那一台，
// 唯一手段是把整个工作区的采集一起掐掉（连还在正常用的同事一起）。
//
// 跑在真 SQLite 上，因为这里要验的**正是 DB 语义**：删 Member 时外键级联有没有真的把
// 他名下的令牌带走。这件事读应用层代码永远读不出来——那里根本没有删令牌的代码，
// 全靠 `onDelete: Cascade`。级联没生效 = 人已经离开工作区、他电脑上的插件还在往里写数据。

let phoneSeq = 0;
const nextPhone = () => `1390000${String(1000 + phoneSeq++).slice(-4)}`;

async function seed() {
  const tenant = await prisma.tenant.create({ data: { name: '令牌测试' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: '主工作区' } });
  const alice = await prisma.member.create({
    data: { tenantId: tenant.id, name: 'Alice', phone: nextPhone(), role: 'owner' },
  });
  const bob = await prisma.member.create({
    data: { tenantId: tenant.id, name: 'Bob', phone: nextPhone(), role: 'editor' },
  });
  return { tenant, ws, alice, bob };
}

beforeEach(async () => {
  await prisma.tenant.deleteMany();
});

describe('采集令牌 · 签发与鉴权', () => {
  it('签发的令牌能解析回本工作区，7 条 ingest 路由用的入口也认', async () => {
    const { ws, alice } = await seed();
    const t = await issueIngestToken({ workspaceId: ws.id, memberId: alice.id, label: 'Chrome · macOS' });

    const r = await resolveIngestToken(t.token);
    expect(r?.workspace.id).toBe(ws.id);
    expect(r?.legacy).toBe(false);

    // 路由侧的入口没改签名，端到端也必须通
    const wsFromRoute = await workspaceByIngestToken(t.token);
    expect(wsFromRoute?.id).toBe(ws.id);
  });

  it('🔒 吊销后立即失效，且不许再落回旧字段兜底', async () => {
    const { ws, alice } = await seed();
    // 同一个工作区**同时**有旧字段令牌和新表令牌：兜底分支写错顺序的话，
    // 吊销掉的那一枚会被旧字段"救活"。这里刻意造出这个现场。
    await prisma.workspace.update({ where: { id: ws.id }, data: { ingestToken: 'bcn_legacy_one' } });
    const t = await issueIngestToken({ workspaceId: ws.id, memberId: alice.id, label: 'Chrome · macOS' });

    await revokeIngestToken(ws.id, t.id, '测试吊销');

    expect(await resolveIngestToken(t.token)).toBeNull();
    // 旧字段那一枚不受影响——吊销的是「一台设备」，不是「整个工作区」
    expect((await resolveIngestToken('bcn_legacy_one'))?.workspace.id).toBe(ws.id);
  });

  it('旧的工作区级令牌仍然认——否则部署那一刻所有已装插件集体失效', async () => {
    const { ws } = await seed();
    await prisma.workspace.update({ where: { id: ws.id }, data: { ingestToken: 'bcn_old_style' } });
    const r = await resolveIngestToken('bcn_old_style');
    expect(r?.workspace.id).toBe(ws.id);
    expect(r?.legacy).toBe(true);
  });

  it('空令牌 / 不存在的令牌一律 null', async () => {
    await seed();
    expect(await resolveIngestToken('')).toBeNull();
    expect(await resolveIngestToken(null)).toBeNull();
    expect(await resolveIngestToken('bcn_nope')).toBeNull();
  });
});

describe('🔒 成员被删除 → 他名下的令牌必须跟着消失（本轮的核心）', () => {
  it('删 Bob → Bob 那台设备当场失效，Alice 的照常能用', async () => {
    const { ws, alice, bob } = await seed();
    const aliceToken = await issueIngestToken({ workspaceId: ws.id, memberId: alice.id, label: 'Chrome · macOS' });
    const bobToken = await issueIngestToken({ workspaceId: ws.id, memberId: bob.id, label: 'Edge · Windows' });

    // 成员退出（lib/account/delete.ts 的 member 分支就是这一句）
    await prisma.member.delete({ where: { id: bob.id } });

    expect(await resolveIngestToken(bobToken.token), 'Bob 已离开工作区，他的插件还能往里写数据').toBeNull();
    expect((await resolveIngestToken(aliceToken.token))?.workspace.id).toBe(ws.id);
  });

  it('删的是行不是标记：Bob 的令牌不该只是被标吊销而留在列表里', async () => {
    const { ws, bob } = await seed();
    await issueIngestToken({ workspaceId: ws.id, memberId: bob.id, label: 'Edge · Windows' });
    await prisma.member.delete({ where: { id: bob.id } });
    expect(await prisma.ingestToken.count({ where: { workspaceId: ws.id } })).toBe(0);
  });
});

describe('采集令牌 · 签发策略', () => {
  it('同一个人同一台设备再点一次 = 复用那一枚，不攒出一屏分不清谁是谁', async () => {
    const { ws, alice } = await seed();
    const a = await issueIngestToken({ workspaceId: ws.id, memberId: alice.id, label: 'Chrome · macOS' });
    const b = await issueIngestToken({ workspaceId: ws.id, memberId: alice.id, label: 'Chrome · macOS' });
    expect(b.reused).toBe(true);
    expect(b.token).toBe(a.token);
    expect(await prisma.ingestToken.count({ where: { workspaceId: ws.id } })).toBe(1);
  });

  it('force = 另发一枚（同一台机器上的两个浏览器配置）', async () => {
    const { ws, alice } = await seed();
    const a = await issueIngestToken({ workspaceId: ws.id, memberId: alice.id, label: 'Chrome · macOS' });
    const b = await issueIngestToken({ workspaceId: ws.id, memberId: alice.id, label: 'Chrome · macOS', force: true });
    expect(b.token).not.toBe(a.token);
    expect((await listIngestTokens(ws.id)).active).toHaveLength(2);
  });

  it('已吊销的那一枚不参与复用——否则「吊销」会被下一次点击撤销掉', async () => {
    const { ws, alice } = await seed();
    const a = await issueIngestToken({ workspaceId: ws.id, memberId: alice.id, label: 'Chrome · macOS' });
    await revokeIngestToken(ws.id, a.id);
    const b = await issueIngestToken({ workspaceId: ws.id, memberId: alice.id, label: 'Chrome · macOS' });
    expect(b.reused).toBe(false);
    expect(b.token).not.toBe(a.token);
  });

  it('不同的人在同一种设备上各拿各的', async () => {
    const { ws, alice, bob } = await seed();
    const a = await issueIngestToken({ workspaceId: ws.id, memberId: alice.id, label: 'Chrome · macOS' });
    const b = await issueIngestToken({ workspaceId: ws.id, memberId: bob.id, label: 'Chrome · macOS' });
    expect(a.token).not.toBe(b.token);
  });
});

describe('采集令牌 · 吊销', () => {
  it('🔒 吊销必须带 workspaceId：只按 id 吊销 = 跨工作区的 IDOR', async () => {
    const { ws, alice } = await seed();
    const other = await seed();
    const t = await issueIngestToken({ workspaceId: ws.id, memberId: alice.id, label: 'Chrome · macOS' });

    const r = await revokeIngestToken(other.ws.id, t.id);
    expect(r.ok).toBe(false);
    expect((await resolveIngestToken(t.token))?.workspace.id).toBe(ws.id);
  });

  it('「全部停用」要一枚不剩，含旧字段那一枚', async () => {
    const { ws, alice, bob } = await seed();
    await prisma.workspace.update({ where: { id: ws.id }, data: { ingestToken: 'bcn_legacy_two' } });
    const a = await issueIngestToken({ workspaceId: ws.id, memberId: alice.id, label: 'Chrome · macOS' });
    const b = await issueIngestToken({ workspaceId: ws.id, memberId: bob.id, label: 'Edge · Windows' });

    const r = await revokeAllIngestTokens(ws.id, '全部停用');
    expect(r.revoked).toBe(2);
    expect(await resolveIngestToken(a.token)).toBeNull();
    expect(await resolveIngestToken(b.token)).toBeNull();
    // 🔒 只清新表的话，装着旧令牌的插件照采不误——那是最难查的那种「停用了但没停」
    expect(await resolveIngestToken('bcn_legacy_two')).toBeNull();
  });

  it('已吊销的进「最近吊销」而不是凭空消失（用户要看得到什么时候被收回的）', async () => {
    const { ws, alice } = await seed();
    const t = await issueIngestToken({ workspaceId: ws.id, memberId: alice.id, label: 'Chrome · macOS' });
    await revokeIngestToken(ws.id, t.id, '由 Alice 手动吊销');
    const list = await listIngestTokens(ws.id);
    expect(list.active).toHaveLength(0);
    expect(list.revoked[0]?.revokedNote).toBe('由 Alice 手动吊销');
  });
});

describe('采集令牌 · lastUsedAt 节流', () => {
  it('第一次用就记上，紧接着再用不重复写库', async () => {
    const { ws, alice } = await seed();
    const t = await issueIngestToken({ workspaceId: ws.id, memberId: alice.id, label: 'Chrome · macOS' });

    await resolveIngestToken(t.token);
    const first = (await prisma.ingestToken.findUnique({ where: { id: t.id } }))!.lastUsedAt;
    expect(first).not.toBeNull();

    await resolveIngestToken(t.token);
    const second = (await prisma.ingestToken.findUnique({ where: { id: t.id } }))!.lastUsedAt;
    // 每条回传都更新 = 给每个采集请求平白加一次写库
    expect(second?.getTime()).toBe(first?.getTime());
  });

  it('隔得够久就更新——它要能回答「这台设备还在用吗」', async () => {
    const { ws, alice } = await seed();
    const t = await issueIngestToken({ workspaceId: ws.id, memberId: alice.id, label: 'Chrome · macOS' });
    const long_ago = new Date(Date.now() - 3600_000);
    await prisma.ingestToken.update({ where: { id: t.id }, data: { lastUsedAt: long_ago } });

    await resolveIngestToken(t.token);
    const after = (await prisma.ingestToken.findUnique({ where: { id: t.id } }))!.lastUsedAt!;
    expect(after.getTime()).toBeGreaterThan(long_ago.getTime());
  });
});

describe('设备标签', () => {
  it('认得出常见浏览器与系统', () => {
    expect(deviceLabelFromUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'))
      .toBe('Chrome · macOS');
    expect(deviceLabelFromUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'))
      .toBe('Edge · Windows');
    expect(deviceLabelFromUA('Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0'))
      .toBe('Firefox · Linux');
  });

  it('认不出来不猜——猜错的标签比没有标签更误导', () => {
    expect(deviceLabelFromUA('')).toBe('浏览器插件');
    expect(deviceLabelFromUA(null)).toBe('浏览器插件');
    expect(deviceLabelFromUA('curl/8.4.0')).toBe('浏览器插件');
  });
});
