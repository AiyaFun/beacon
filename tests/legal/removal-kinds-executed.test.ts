import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '@/lib/db';
import {
  resolveRemovalRequest, countRemovedSiteData, countRemovedComment,
  SITE_KIND, COMMENT_KIND, SITE_PLATFORM,
} from '@/lib/legal/removal';
import { commentTextHash } from '@/lib/ingest/reader-comments';

// 三种 kind 都要**真的被执行**（2026-08-29 第二轮彻查）。
//
// ── 查出来的缺陷 ──
// 运营处理台 `scripts/removal-requests.ts` **从头到尾没判过 kind**，
// 而按 kind 分叉的那份实现（resolveRemovalRequest）**生产零调用点、只有测试在调**。
// 于是：
//   · comment 类 —— 脚本把**作品链接**当账号 handle 传进 purgeRemovedAccountData，
//     而那里按 author（账号 handle）删评论，永远匹配不上：**一条都删不掉，还报「0 条」**。
//     隐私政策白纸黑字写着读者本人可以要求删除自己那条评论 → **空承诺**。
//   · site 类 —— platform='site' 查不到任何竞对档案，同样删 0 条（已实测证实）。
//
// 这个文件锁住「三种 kind 都真的删得掉」，且**用真跑**——
// 源码断言证明不了这件事，上一轮就是这么漏的。

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('真跑：三种 kind 都执行得动', () => {
  beforeEach(async () => {
    await prisma.dataRemovalRequest.deleteMany({});
    await prisma.scrapeRecord.deleteMany({});
    await prisma.scrapeRecipe.deleteMany({});
    await prisma.readerComment.deleteMany({});
    await prisma.inspirationItem.deleteMany({});
  });

  it('🔒 site 类：真的删掉采集记录并停用配方', async () => {
    const t = await prisma.tenant.create({ data: { name: 't' } });
    const w = await prisma.workspace.create({ data: { tenantId: t.id, name: 'w' } });
    const rec = await prisma.scrapeRecipe.create({
      data: { tenantId: t.id, workspaceId: w.id, name: 'x', origin: 'https://example.com', createdBy: 'm' },
    });
    await prisma.scrapeRecord.create({
      data: { tenantId: t.id, workspaceId: w.id, recipeId: rec.id, url: 'https://example.com/a',
        values: '{"f1":"v"}', got: 1, want: 1, channel: 'server' },
    });
    const req = await prisma.dataRemovalRequest.create({
      data: { platform: SITE_PLATFORM, handle: 'example.com', kind: SITE_KIND, contact: 'a@b.com' },
    });

    // 【剪藏正文也要一起删】lib/clip 那条路（服务端直抓正文）存的是**他人作品全文**，
    // 2026-08-30 之前它既没挂停采闸、也不在任何清理路径里——嘴上说「删除已经从该站取到的
    // 数据」，正文却原封不动留着。这里造一条真的剪藏，验它确实被删。
    const clip = await prisma.inspirationItem.create({
      data: { workspaceId: w.id, title: '一篇文章', url: 'https://news.example.com/p/1', source: 'manual' },
    });
    // 同时造一条**不该被误删**的：域名相似但不是子域
    const other = await prisma.inspirationItem.create({
      data: { workspaceId: w.id, title: '别人的', url: 'https://notexample.com/p/1', source: 'manual' },
    });

    // dry-run 数出来的，必须和真删的对得上（说删了什么与删了什么要一致）
    const counted = await countRemovedSiteData('example.com');
    expect(counted).toEqual({ records: 1, recipes: 1, clips: 1 });

    const r = await resolveRemovalRequest(req.id, 'removed');
    expect(r.ok).toBe(true);
    expect(r.purged!.scrapeRecords).toBe(1);
    expect(r.purged!.scrapeRecipes).toBe(1);
    expect(r.purged!.clips, '剪藏正文没被删').toBe(1);
    expect(await prisma.scrapeRecord.count()).toBe(0);
    expect((await prisma.scrapeRecipe.findUnique({ where: { id: rec.id } }))!.status).toBe('stopped');
    expect(await prisma.inspirationItem.findUnique({ where: { id: clip.id } }), '子域的剪藏该删').toBeNull();
    expect(
      await prisma.inspirationItem.findUnique({ where: { id: other.id } }),
      'notexample.com 被误删了——域名必须按点分段比，不能用裸 contains',
    ).not.toBeNull();
  });

  it('🔒 comment 类：真的删掉那一条评论，且不碰作者的任何东西', async () => {
    const t = await prisma.tenant.create({ data: { name: 't' } });
    const w = await prisma.workspace.create({ data: { tenantId: t.id, name: 'w' } });
    // ReaderComment 有 textHash（去重键的一部分），建测试数据时必须给
    const mk = (text: string) => prisma.readerComment.create({
      data: {
        workspaceId: w.id, platform: 'douyin', scope: 'rival', author: '作者handle',
        text, textHash: commentTextHash(text),
      },
    });
    await mk('这条是我写的，请删掉');
    await mk('别人写的另一条');

    const req = await prisma.dataRemovalRequest.create({
      data: {
        platform: 'douyin', handle: 'https://www.douyin.com/video/7412345678901234567',
        kind: COMMENT_KIND, contact: 'a@b.com', commentText: '这条是我写的，请删掉',
      },
    });
    expect(await countRemovedComment('douyin', '这条是我写的，请删掉')).toBe(1);

    const r = await resolveRemovalRequest(req.id, 'removed');
    expect(r.ok).toBe(true);
    expect(r.purged!.readerComments).toBe(1);
    // 只删他那一条，别人的还在
    const left = await prisma.readerComment.findMany();
    expect(left.length).toBe(1);
    expect(left[0].text).toBe('别人写的另一条');
  });

  it('🔒 dry-run 的数与真删的数对得上（说删了什么与删了什么必须一致）', async () => {
    const t = await prisma.tenant.create({ data: { name: 't' } });
    const w = await prisma.workspace.create({ data: { tenantId: t.id, name: 'w' } });
    const rec = await prisma.scrapeRecipe.create({
      data: { tenantId: t.id, workspaceId: w.id, name: 'x', origin: 'https://sub.foo.cn', createdBy: 'm' },
    });
    for (const n of [1, 2, 3]) {
      await prisma.scrapeRecord.create({
        data: { tenantId: t.id, workspaceId: w.id, recipeId: rec.id, url: `https://sub.foo.cn/${n}`,
          values: '{"f1":"v"}', got: 1, want: 1, channel: 'server' },
      });
    }
    const counted = await countRemovedSiteData('foo.cn'); // 主域申请，子域也算
    const purged = await (await import('@/lib/legal/removal')).purgeRemovedSiteData('foo.cn');
    expect(counted.records).toBe(purged.records);
    expect(counted.recipes).toBe(purged.recipes);
    expect(purged.records).toBe(3);
  });
});

describe('运营处理台不许再各写一份', () => {
  const src = read('scripts/removal-requests.ts');

  it('🔒 apply 走 resolveRemovalRequest（唯一同时认得三种 kind 的实现）', () => {
    expect(src).toContain('await resolveRemovalRequest(id, status');
    // 不许再自己 update 状态 + 自己调 purgeRemovedAccountData 了
    expect(src).not.toContain('prisma.dataRemovalRequest.update');
  });

  it('🔒 dry-run 按 kind 分叉', () => {
    expect(src).toContain('async function countFor');
    expect(src).toContain("req.kind === SITE_KIND");
    expect(src).toContain("req.kind === COMMENT_KIND");
  });

  it('🔒 展示也按 kind 分（混成一句会让运营看到一堆恒为 0 的字段）', () => {
    expect(src).toContain("if (p.kind === 'site')");
    expect(src).toContain("if (p.kind === 'comment')");
  });

  it('🔒 回执里带上新增的三项（说删了什么就得说全）', () => {
    for (const f of ['scrapeRecords', 'scrapeRecipes', 'aiCitations']) {
      expect(src, `回执里缺 ${f}`).toContain(f);
    }
  });
});

describe('每日重扫也要认三种 kind', () => {
  const src = read('lib/legal/retention.ts');

  it('🔒 site 与 comment 都有分支（不认就掉进按账号删的那条路，空转且不报错）', () => {
    expect(src).toContain('req.kind === SITE_KIND');
    expect(src).toContain('req.kind === COMMENT_KIND');
  });

  it('🔒 取了 commentText（不取的话 comment 类在重扫里同样是空转）', () => {
    expect(src).toContain('commentText: true');
  });
});
