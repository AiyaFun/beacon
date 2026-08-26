import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prisma } from '@/lib/db';
import {
  isRemovalRequested,
  resolveRemovalRequest,
  purgeOneComment,
  ACCOUNT_KIND,
  COMMENT_KIND,
} from '@/lib/legal/removal';

// 评论者本人的删除权（《个保法》第 27 条拒绝权 / 第 47 条删除权）——2026-08-24 加。
//
// 这条通道最危险的地方不是「删不掉」，而是**删太多**：评论者填的 handle 是
// **作品作者**的账号（他自己的身份我们一个字段都没存，只能靠作品链接定位）。
// 如果这条申请混进停采闸，就成了「张三删掉自己在李四视频下的一条评论」
// → 全平台停采李四并删光李四的档案、作品、订阅与台账。
// 拿一个人的权利去伤害另一个人，比不执行这个权利更坏。本文件把这条边界钉死。

let seq = 0;
async function seedRivalComment(platform: string, author: string, text: string) {
  seq += 1;
  const tenant = await prisma.tenant.create({ data: { name: `t${seq}` } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: `w${seq}` } });
  await prisma.readerComment.create({
    data: {
      workspaceId: ws.id, platform, scope: 'rival', author,
      workKey: `work${seq}`, text, kind: 'other', textHash: `hash${seq}`,
    },
  });
  return ws.id;
}

async function seedAuthorAccount(platform: string, handle: string) {
  const acc = await prisma.competitorAccount.create({ data: { platform, handle, name: '作者' } });
  await prisma.crawledPost.create({
    data: { competitorId: acc.id, platform, platformItemId: `${handle}-post`, title: '作者的作品' },
  });
  return acc.id;
}

beforeEach(async () => {
  await prisma.readerComment.deleteMany();
  await prisma.dataRemovalRequest.deleteMany();
  await prisma.crawledPost.deleteMany();
  await prisma.competitorAccount.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
});

describe('🔒 评论者的申请绝不能停采作品作者', () => {
  it('comment 类申请挂着，作者照采不误', async () => {
    await prisma.dataRemovalRequest.create({
      data: {
        platform: 'douyin', handle: 'https://douyin.com/video/123', contact: 'a@b.c',
        kind: COMMENT_KIND, commentText: '这个太贵了吧',
      },
    });
    // 就算 handle 恰好被写成作者的账号标识，也不许停采
    await prisma.dataRemovalRequest.create({
      data: {
        platform: 'douyin', handle: 'author_mid', contact: 'x@y.z',
        kind: COMMENT_KIND, commentText: '另一句',
      },
    });
    expect(await isRemovalRequested('douyin', 'author_mid')).toBe(false);
    expect(await isRemovalRequested('douyin', 'https://douyin.com/video/123')).toBe(false);
  });

  it('account 类申请仍然照常停采（别把闸门整个关掉了）', async () => {
    await prisma.dataRemovalRequest.create({
      data: { platform: 'douyin', handle: 'author_mid', contact: 'a@b.c', kind: ACCOUNT_KIND },
    });
    expect(await isRemovalRequested('douyin', 'author_mid')).toBe(true);
  });

  it('存量行（建列前就有的申请）默认是 account，行为不变', async () => {
    // 迁移用的是 DEFAULT 'account'——这条钉住「不写 kind 时按老语义走」，
    // 否则升级当天所有生效中的停采申请会集体失效，而且没有任何报错。
    const row = await prisma.dataRemovalRequest.create({
      data: { platform: 'x', handle: 'someone', contact: 'a@b.c' },
    });
    expect(row.kind).toBe(ACCOUNT_KIND);
    expect(await isRemovalRequested('x', 'someone')).toBe(true);
  });
});

describe('执行评论删除：只删那一条', () => {
  it('删掉申请人那条，同作品下别人的评论不受影响', async () => {
    await seedRivalComment('douyin', 'author_mid', '这个太贵了吧');
    await seedRivalComment('douyin', 'author_mid', '什么时候上新');
    const { readerComments } = await purgeOneComment('douyin', '这个太贵了吧');
    expect(readerComments).toBe(1);
    const left = await prisma.readerComment.findMany({ select: { text: true } });
    expect(left.map((r) => r.text)).toEqual(['什么时候上新']);
  });

  it('同一句话在别的平台留过 → 只删本平台那条', async () => {
    await seedRivalComment('douyin', 'a', '一模一样的话');
    await seedRivalComment('bilibili', 'b', '一模一样的话');
    await purgeOneComment('douyin', '一模一样的话');
    const left = await prisma.readerComment.findMany({ select: { platform: true } });
    expect(left.map((r) => r.platform)).toEqual(['bilibili']);
  });

  it('评论原文为空时一条都不删', async () => {
    // ⚠️ 这条**守不住**「空串防护」本身：当前实现是 `where: { text }` 精确匹配，
    // 空串本来就删不到东西，把入口那行 `if (!text) return` 删掉它照样绿
    // （2026-08-24 mutation 验证确认过）。它验的是结果，不是防护。
    // 真正让空串安全的是「精确匹配」这个性质，由下面那条源码守卫钉住。
    await seedRivalComment('douyin', 'a', '还在的评论');
    for (const empty of ['', '   ']) {
      const { readerComments } = await purgeOneComment('douyin', empty);
      expect(readerComments).toBe(0);
    }
    expect(await prisma.readerComment.count()).toBe(1);
  });

  it('🔒 按评论原文删除必须是精确匹配 —— contains/startsWith 会一句话删掉一片', async () => {
    // 改成 `text: { contains }` 的那天，申请人填「谢谢」就会删掉所有含「谢谢」的评论；
    // 而空串配 contains 更是匹配全表。这是空串防护真正在防的东西。
    const src = readFileSync(resolve(process.cwd(), 'lib/legal/removal.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export async function purgeOneComment'));
    const whole = fn.slice(0, fn.indexOf('\n}\n') + 1);
    // ⚠️ 只看**代码行**。函数注释里就写着「一旦哪天有人改成 contains」——
    // 不剥注释的话这条否定断言当场自己红，而且是被自己要防的那个词骗的
    // （2026-08-24 第一版就是这么红的，同 tests/web/robots.test.ts 里那条守卫的坑）。
    const body = whole.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(body).toContain('where: { platform, text }');
    expect(body).not.toMatch(/contains|startsWith|endsWith|search:/);
    // 防护那一行也要在——它挡的是「将来有人把精确匹配换掉」的那一刻
    expect(body).toMatch(/if \(!text\) return/);
  });

  it('🔒 部分匹配删不掉 —— 填一个子串不该命中整条评论', async () => {
    await seedRivalComment('douyin', 'a', '这个太贵了吧，等降价');
    const { readerComments } = await purgeOneComment('douyin', '太贵');
    expect(readerComments).toBe(0);
    expect(await prisma.readerComment.count()).toBe(1);
  });

  it('🔒 resolve 一条 comment 申请：作者的档案与作品一根毫毛都不能少', async () => {
    await seedRivalComment('douyin', 'author_mid', '这个太贵了吧');
    await seedAuthorAccount('douyin', 'author_mid');
    const req = await prisma.dataRemovalRequest.create({
      data: {
        platform: 'douyin', handle: 'https://douyin.com/video/123', contact: 'a@b.c',
        kind: COMMENT_KIND, commentText: '这个太贵了吧',
      },
    });

    const r = await resolveRemovalRequest(req.id, 'removed');
    expect(r.ok).toBe(true);
    expect(r.purged?.readerComments).toBe(1);
    // 这四个必须是 0——它们不为 0 就意味着评论者的申请动了作者的数据
    expect(r.purged?.accounts).toBe(0);
    expect(r.purged?.posts).toBe(0);
    expect(r.purged?.watchlistItems).toBe(0);
    expect(r.purged?.runs).toBe(0);
    expect(await prisma.competitorAccount.count()).toBe(1);
    expect(await prisma.crawledPost.count()).toBe(1);
    expect(await prisma.readerComment.count()).toBe(0);
  });

  it('resolve 一条 account 申请：老行为不变，作者档案连同评论一起走', async () => {
    await seedRivalComment('douyin', 'author_mid', '这个太贵了吧');
    await seedAuthorAccount('douyin', 'author_mid');
    const req = await prisma.dataRemovalRequest.create({
      data: { platform: 'douyin', handle: 'author_mid', contact: 'a@b.c', kind: ACCOUNT_KIND },
    });

    const r = await resolveRemovalRequest(req.id, 'removed');
    expect(r.purged?.accounts).toBe(1);
    expect(r.purged?.readerComments).toBe(1);
    expect(await prisma.competitorAccount.count()).toBe(0);
    expect(await prisma.readerComment.count()).toBe(0);
  });

  it('驳回一条 comment 申请：什么都不删', async () => {
    await seedRivalComment('douyin', 'author_mid', '这个太贵了吧');
    const req = await prisma.dataRemovalRequest.create({
      data: {
        platform: 'douyin', handle: 'https://douyin.com/v/1', contact: 'a@b.c',
        kind: COMMENT_KIND, commentText: '这个太贵了吧',
      },
    });
    await resolveRemovalRequest(req.id, 'rejected');
    expect(await prisma.readerComment.count()).toBe(1);
  });
});
