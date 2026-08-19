import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import {
  canonicalRemovalHandle,
  isRemovalRequested,
  normalizeRemovalTarget,
  purgeRemovedAccountData,
  removalHandleVariants,
} from '@/lib/legal/removal';

// 移除申请里「同一个号的不同写法」。
//
// 申请页写的是「主页链接**或标识**」。贴链接那条早就归一了；**手打标识**那条却是原样存的，
// 而 @ 平台上的人写自己的名字天然带 @——X/TikTok 的人写 `@AiyaFun`，采集侧存的是 `AiyaFun`；
// YouTube 恰好相反（库里带 @），人却常常只写名字。两边永远差一个字符，于是：
//   · 停采闸 isRemovalRequested 一次都拦不住，采集照常继续；
//   · purgeRemovedAccountData 找不到档案，「已移除」的回执下面是 0 条。
// 这不是显示问题：申请页对外承诺的是「停止采集并移除已收集的相关公开信息」，
// 匹配不上就等于这句承诺没兑现——与本模块头注释要防的是同一件事，只是换了个入口。
//
// ⚠️ 归一**必须按平台分**。douyin 的 sec_user_id、xiaohongshu 的 user_id 是不透明 ID，
// 大小写有意义，一刀切转小写会把两个不同的号判成同一个——那比漏拦更坏（删错人的数据）。

beforeEach(async () => {
  await prisma.dataRemovalRequest.deleteMany();
  await prisma.crawledPost.deleteMany();
  await prisma.watchlistItem.deleteMany();
  await prisma.competitorAccount.deleteMany();
  await prisma.inspirationItem.deleteMany();
});

describe('归一化 · 按平台分口径', () => {
  it('X / TikTok：去掉 @、转小写（库里存的是不带 @ 的用户名）', () => {
    expect(canonicalRemovalHandle('x', '@AiyaFun')).toBe('aiyafun');
    expect(canonicalRemovalHandle('tiktok', '@SomeCreator')).toBe('somecreator');
  });

  it('YouTube：补上 @（库里存的就是 @handle，见 lib/competitor-url.ts）', () => {
    expect(canonicalRemovalHandle('youtube', 'SomeChannel')).toBe('@somechannel');
    expect(canonicalRemovalHandle('youtube', '@SomeChannel')).toBe('@somechannel');
  });

  it('🔒 YouTube 频道 ID 原样不动：UC… 里的大小写是有意义的', () => {
    const id = 'UCabcdEFGH1234567890xyz';
    expect(canonicalRemovalHandle('youtube', id)).toBe(id);
  });

  it('🔒 抖音 / 小红书的不透明 ID 一律原样：转小写会把两个不同的号并成一个', () => {
    expect(canonicalRemovalHandle('douyin', 'MS4wLjABAAAAxYz')).toBe('MS4wLjABAAAAxYz');
    expect(canonicalRemovalHandle('xiaohongshu', '5Ff3AbC')).toBe('5Ff3AbC');
  });

  it('贴链接那条路仍然按原口径解析，并同样归一', () => {
    expect(normalizeRemovalTarget('x', 'https://x.com/AiyaFun')).toEqual({ platform: 'x', handle: 'aiyafun' });
    expect(normalizeRemovalTarget('bilibili', 'https://space.bilibili.com/123456'))
      .toEqual({ platform: 'bilibili', handle: '123456' });
  });

  it('等价写法里必然含「带 @」「不带 @」两种（历史申请行也要能匹配上）', () => {
    const vs = removalHandleVariants('x', 'AiyaFun');
    expect(vs).toContain('AiyaFun');
    expect(vs).toContain('@AiyaFun');
    expect(vs).toContain('aiyafun');
    // 抖音不做变体：不透明 ID 不许模糊匹配
    expect(removalHandleVariants('douyin', 'MS4wLjABAAAAxYz')).toEqual(['MS4wLjABAAAAxYz']);
  });
});

describe('停采闸 · 人怎么写都要拦住', () => {
  const file = (platform: string, handle: string) =>
    prisma.dataRemovalRequest.create({
      data: { platform, handle: normalizeRemovalTarget(platform, handle).handle, contact: 'a@b.com', status: 'pending' },
    });

  it('🔒 申请人写 @AiyaFun，采集侧拿到的是 AiyaFun → 必须拦住', async () => {
    await file('x', '@AiyaFun');
    expect(await isRemovalRequested('x', 'AiyaFun')).toBe(true);
  });

  it('🔒 大小写不同也要拦住（X/TikTok 用户名不区分大小写）', async () => {
    await file('x', '@aiyafun');
    expect(await isRemovalRequested('x', 'AiyaFun')).toBe(true);
  });

  it('🔒 YouTube：申请人只写名字，采集侧存的是 @名字', async () => {
    await file('youtube', 'SomeChannel');
    expect(await isRemovalRequested('youtube', '@SomeChannel')).toBe(true);
  });

  it('🔒 本次修复之前存进去的历史申请行（没归一过）同样要能匹配上', async () => {
    // 直接写库，绕开 normalizeRemovalTarget——模拟旧数据
    await prisma.dataRemovalRequest.create({
      data: { platform: 'x', handle: '@AiyaFun', contact: 'a@b.com', status: 'pending' },
    });
    expect(await isRemovalRequested('x', 'AiyaFun')).toBe(true);
  });

  it('不同的号不许被误拦（变体匹配不能变成模糊匹配）', async () => {
    await file('x', '@AiyaFun');
    expect(await isRemovalRequested('x', 'AiyaFunny')).toBe(false);
    expect(await isRemovalRequested('x', 'Aiya')).toBe(false);
  });

  it('🔒 抖音两个只差大小写的 sec_user_id 是两个号，不许互相误拦', async () => {
    await file('douyin', 'MS4wLjABAAAAxYz');
    expect(await isRemovalRequested('douyin', 'MS4wLjABAAAAxYz')).toBe(true);
    expect(await isRemovalRequested('douyin', 'ms4wljabaaaaxyz')).toBe(false);
  });
});

describe('执行移除 · 写法不同也要真的删掉', () => {
  it('🔒 申请写 @AiyaFun、档案存 AiyaFun → 档案与读者提问都要清掉', async () => {
    const ws = await prisma.workspace.findFirst();
    const acc = await prisma.competitorAccount.create({
      data: { platform: 'x', handle: 'AiyaFun', name: 'Aiya' },
    });
    await prisma.crawledPost.create({
      data: { competitorId: acc.id, platform: 'x', platformItemId: 'p1', title: '一条作品', url: 'https://x.com/AiyaFun/status/1' },
    });
    if (ws) {
      await prisma.inspirationItem.create({
        data: { workspaceId: ws.id, title: '这个怎么收费呢', source: 'rival-comment', platform: 'x', author: 'AiyaFun' },
      });
    }

    const r = await purgeRemovedAccountData('x', canonicalRemovalHandle('x', '@AiyaFun'));
    expect(r.accounts).toBe(1);
    expect(r.posts).toBe(1);
    if (ws) expect(r.commentQuestions).toBe(1);
    expect(await prisma.competitorAccount.findUnique({ where: { id: acc.id } })).toBeNull();
  });

  it('别人的提问一条都不许被带走（按 author 定位，不是按 platform）', async () => {
    const ws = await prisma.workspace.findFirst();
    if (!ws) return;
    await prisma.inspirationItem.create({
      data: { workspaceId: ws.id, title: '甲的提问怎么办呢', source: 'rival-comment', platform: 'x', author: 'AiyaFun' },
    });
    await prisma.inspirationItem.create({
      data: { workspaceId: ws.id, title: '乙的提问怎么办呢', source: 'rival-comment', platform: 'x', author: 'SomeoneElse' },
    });
    await purgeRemovedAccountData('x', 'aiyafun');
    const left = await prisma.inspirationItem.findMany({ where: { source: 'rival-comment' }, select: { author: true } });
    expect(left.map((r) => r.author)).toEqual(['SomeoneElse']);
  });
});
