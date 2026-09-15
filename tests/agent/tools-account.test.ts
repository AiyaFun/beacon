import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { toolByName, AGENT_TOOLS } from '@/lib/agent/tools';

// 自有账号类工具：页面上能做的（加账号 / 改账号），对话里也要能做。
// 钉四条口径，每条都是「做错了不会报错、只会静默产生一条错账号」的那种：
//   ① 注册占位行（没 handle 的「我的账号」）要**就地升级**，不能旁边再建一条，否则顶栏两个「我的账号」；
//   ② 同平台同 handle 重复添加要幂等，不能建重；
//   ③ 平台认不出就报错，绝不猜（猜错平台，自有数据会回流到别人的号上）；
//   ④ 点名改账号对上多条时不挑，要用 id 点名。

let ctx: { tenantId: string; workspaceId: string; accountId: string; memberId: string; role: string };
let placeholderId: string;

beforeEach(async () => {
  await prisma.creatorAccount.deleteMany();
  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  // 与 lib/auth.ts 注册时建的占位行同形：没 handle、platform=multi、名字缺省
  const placeholder = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, name: '我的账号', platform: 'multi', personaCard: '{}' },
  });
  placeholderId = placeholder.id;
  const member = await prisma.member.create({ data: { tenantId: tenant.id, name: '张三', role: 'owner' } });
  ctx = { tenantId: tenant.id, workspaceId: ws.id, accountId: placeholder.id, memberId: member.id, role: 'owner' };
});

const run = (name: string, args: Record<string, unknown> = {}) => toolByName(name)!.run(ctx, args);

describe('账号工具已注册', () => {
  it('list_accounts / add_account / update_account 都在 AGENT_TOOLS 里，且 add/update 标了 write', () => {
    for (const n of ['list_accounts', 'add_account', 'update_account']) expect(AGENT_TOOLS.some((t) => t.name === n), n).toBe(true);
    expect(toolByName('add_account')!.write).toBe(true);
    expect(toolByName('update_account')!.write).toBe(true);
    expect(toolByName('list_accounts')!.write).toBe(false);
  });
});

describe('add_account', () => {
  it('① 当前账号是注册占位行 → 就地升级，不另建一条', async () => {
    const r = await run('add_account', { platform: 'x', handle: '@aiyafun' });
    expect(r.ok).toBe(true);
    const rows = await prisma.creatorAccount.findMany({ where: { workspaceId: ctx.workspaceId } });
    expect(rows, '占位行应被升级而不是旁边再建一条').toHaveLength(1);
    expect(rows[0].id).toBe(placeholderId);
    expect(rows[0].platform).toBe('x');
    expect(rows[0].handle, 'handle 要去掉 @').toBe('aiyafun');
    expect(rows[0].name, '缺省名要换成「平台 @handle」，顶栏一眼看出是自己的号').toBe('X @aiyafun');
  });

  it('接受主页链接，平台与 handle 从链接里解析', async () => {
    const r = await run('add_account', { url: 'https://x.com/aiyafun' });
    expect(r.ok).toBe(true);
    const row = await prisma.creatorAccount.findFirstOrThrow({ where: { workspaceId: ctx.workspaceId } });
    expect(row.platform).toBe('x');
    expect(row.handle).toBe('aiyafun');
  });

  it('接受中文平台名', async () => {
    const r = await run('add_account', { platform: '小红书', handle: 'xhs123' });
    expect(r.ok).toBe(true);
    expect((r.data as { platform: string }).platform).toBe('xiaohongshu');
  });

  it('② 同平台同 handle 再加一次 → 幂等复用，不建重', async () => {
    await run('add_account', { platform: 'x', handle: 'aiyafun' });
    const again = await run('add_account', { platform: 'x', handle: 'aiyafun' });
    expect(again.ok).toBe(true);
    expect((again.data as { reused?: boolean }).reused).toBe(true);
    expect(await prisma.creatorAccount.count({ where: { workspaceId: ctx.workspaceId } })).toBe(1);
  });

  it('当前账号已被别的平台占了 → 新建一条，不覆盖', async () => {
    await run('add_account', { platform: 'x', handle: 'aiyafun' });
    const r = await run('add_account', { platform: 'douyin', handle: 'dy001' });
    expect(r.ok).toBe(true);
    expect((r.data as { created?: boolean }).created).toBe(true);
    const rows = await prisma.creatorAccount.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0].platform, '原来那条不能被改掉').toBe('x');
    expect(rows[1].platform).toBe('douyin');
  });

  it('③ 平台认不出 → 报错不猜，库里不动', async () => {
    const r = await run('add_account', { platform: 'instagram', handle: 'x' });
    expect(r.ok).toBe(false);
    const row = await prisma.creatorAccount.findFirstOrThrow({ where: { id: placeholderId } });
    expect(row.platform, '占位行不能被写成一个认不出的平台').toBe('multi');
  });

  it('③ 链接认不出 → 报错不猜', async () => {
    const r = await run('add_account', { url: 'https://example.com/whatever' });
    expect(r.ok).toBe(false);
    expect(await prisma.creatorAccount.count({ where: { workspaceId: ctx.workspaceId } })).toBe(1);
  });

  it('只认 ToolContext 的工作区：别的工作区的同名账号不算「已存在」', async () => {
    const other = await prisma.workspace.create({ data: { tenantId: ctx.tenantId, name: 'W2' } });
    await prisma.creatorAccount.create({ data: { workspaceId: other.id, name: 'x', platform: 'x', handle: 'aiyafun', personaCard: '{}' } });
    const r = await run('add_account', { platform: 'x', handle: 'aiyafun' });
    expect(r.ok).toBe(true);
    expect((r.data as { reused?: boolean }).reused, '不能把别人工作区的账号当成自己的').toBeFalsy();
  });
});

describe('update_account', () => {
  it('不点名 = 改当前账号；只改传了的字段', async () => {
    const r = await run('update_account', { handle: '@aiyafun', platform: 'X' });
    expect(r.ok).toBe(true);
    const row = await prisma.creatorAccount.findFirstOrThrow({ where: { id: placeholderId } });
    expect(row.handle).toBe('aiyafun');
    expect(row.platform).toBe('x');
    expect(row.name, '没传 name 就不能动名字').toBe('我的账号');
  });

  it('按 handle 点名', async () => {
    await run('add_account', { platform: 'x', handle: 'aiyafun' });
    const r = await run('update_account', { account: 'aiyafun', name: '我的 X' });
    expect(r.ok).toBe(true);
    const row = await prisma.creatorAccount.findFirstOrThrow({ where: { handle: 'aiyafun' } });
    expect(row.name).toBe('我的 X');
  });

  it('④ 点名对上多条 → 不挑，要求用 id', async () => {
    await prisma.creatorAccount.create({ data: { workspaceId: ctx.workspaceId, name: '同名', platform: 'x', personaCard: '{}' } });
    await prisma.creatorAccount.create({ data: { workspaceId: ctx.workspaceId, name: '同名', platform: 'douyin', personaCard: '{}' } });
    const r = await run('update_account', { account: '同名', name: '改了' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('id');
    expect(await prisma.creatorAccount.count({ where: { name: '改了' } }), '一条都不许被改').toBe(0);
  });

  it('什么都没传 → 报错', async () => {
    const r = await run('update_account', {});
    expect(r.ok).toBe(false);
  });

  it('平台认不出 → 报错不改', async () => {
    const r = await run('update_account', { platform: 'facebook' });
    expect(r.ok).toBe(false);
    const row = await prisma.creatorAccount.findFirstOrThrow({ where: { id: placeholderId } });
    expect(row.platform).toBe('multi');
  });
});

describe('list_accounts', () => {
  it('列出本工作区的账号并标出当前', async () => {
    await run('add_account', { platform: 'x', handle: 'aiyafun' });
    const r = await run('list_accounts');
    expect(r.ok).toBe(true);
    const rows = r.data as { id: string; current: boolean }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].current).toBe(true);
    expect(r.summary).toContain('← 当前');
  });
});
