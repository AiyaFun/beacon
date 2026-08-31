import { describe, it, expect } from 'vitest';
import { prisma } from '@/lib/db';
import { saveScrapeRecord } from '@/lib/scrape/record';
import { saveCitations } from '@/lib/geo/citation';
import { recordCrawlerHit, crawlerSummary } from '@/lib/geo/crawler-log';

// 三条落库路径的**真跑**（2026-08-29 彻查时补）。
//
// 【为什么必须有】此前这三条只有纯函数测试与源码断言，**写库那一步一次都没跑过**。
// 而这一轮已经吃过两次同类亏：`/llms.txt` 漏进 middleware（单测不过 middleware）、
// 三个 catch 静默吞掉写失败（分不清「没东西存」和「每条都存失败」）。
// 源码断言证明不了「它真的写得进去」——尤其 createMany 在 SQLite 上的支持历来是个坑，
// 而整机版跑的正是 SQLite。
async function ws() {
  const t = await prisma.tenant.create({ data: { name: 't' } });
  const w = await prisma.workspace.create({ data: { tenantId: t.id, name: 'w' } });
  const r = await prisma.scrapeRecipe.create({
    data: { tenantId: t.id, workspaceId: w.id, name: 'x', origin: 'https://e.com', createdBy: 'm' },
  });
  return { tenantId: t.id, workspaceId: w.id, recipeId: r.id };
}

describe('运行时写库', () => {
  it('saveScrapeRecord 真的写进去了', async () => {
    const c = await ws();
    const r = await saveScrapeRecord({
      ...c, url: 'https://e.com/a', values: { f1: 'v' }, rows: [{ f1: 'a' }], want: 1, channel: 'server',
    });
    console.log('SCRAPE =>', JSON.stringify(r));
    expect(r.saved).toBe(true);
    expect(await prisma.scrapeRecord.count()).toBe(1);
  });

  it('saveCitations 真的写进去了（createMany 在 SQLite 上支持吗）', async () => {
    const c = await ws();
    const r = await saveCitations({
      tenantId: c.tenantId, workspaceId: c.workspaceId, engine: '豆包',
      answerUrl: 'https://www.doubao.com/chat/1', question: 'q',
      citations: [
        { url: 'https://www.douyin.com/video/7412345678901234567', title: 'T',
          platform: 'douyin', platformItemId: '7412345678901234567',
          matchedRecordId: null, matchedAccountId: null },
      ],
    });
    console.log('CITATION =>', JSON.stringify(r));
    expect(r.saved).toBe(1);
    expect(await prisma.aiCitation.count()).toBe(1);
  });

  it('recordCrawlerHit 真的写进去了，且重复来访是加计数不是新行', async () => {
    const ua = 'compatible; GPTBot/1.2';
    const a = await recordCrawlerHit(ua, '/robots.txt');
    const b = await recordCrawlerHit(ua, '/robots.txt?x=1');
    console.log('CRAWLER =>', JSON.stringify(a), JSON.stringify(b));
    expect(a.recorded).toBe(true);
    expect(b.recorded).toBe(true);
    expect(await prisma.aiCrawlerHit.count()).toBe(1);
    const row = await prisma.aiCrawlerHit.findFirst();
    expect(row?.count).toBe(2);
    const sum = await crawlerSummary(30);
    console.log('SUMMARY =>', JSON.stringify(sum));
    expect(sum[0].hits).toBe(2);
    expect(sum[0].days).toBe(1);
  });
});
