import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { parseJson } from '@/lib/json';
import { parseWechatExport, normalizeArticleUrl } from '@/lib/ingest/wechat-export';

// 公众号文章导入通道（wechat-article-exporter 导出文件 → 竞对作品库）。
//
// 这条通道补的是「公众号插件采不到」的空白，两处必须锁死：
//   ① 解析层只出内容不出指标——阅读/在看要抓包截取微信客户端凭证，是既定红线外的灰色通道；
//   ② 入库层归属闸——导到非公众号账号名下＝数据页按 accountId 过滤后彻底看不见，还污染基线
//      （2026-07-25 真机事故同款）。
const session = { memberId: 'm1', tenantId: '', workspaceId: '', accountId: 'a1', memberName: '张三', role: 'owner', plan: 'pro' };
vi.mock('@/lib/session', () => ({ getSession: async () => session, getSessionOrNull: async () => session }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { actImportWechatArticles } = await import('@/app/(app)/competitors/actions');

// exporter 的一条典型导出记录（字段名取自 utils/exporter.ts 的 ExcelExportEntity）
function article(over: Record<string, unknown> = {}) {
  return {
    aid: '2247484123_1',
    appmsgid: 2247484123,
    itemidx: 1,
    title: '一篇公众号文章',
    digest: '这是摘要',
    link: 'http://mp.weixin.qq.com/s?__biz=MzI5NjA=&mid=2247484123&idx=1&sn=abc123&chksm=ec7&scene=27#wechat_redirect',
    create_time: 1750000000,
    author_name: '作者',
    _accountName: '测试公众号',
    ...over,
  };
}

describe('parseWechatExport · 形状兼容', () => {
  it('数组形态：取标题/摘要/链接/发布时间，ID 用 appmsgid_itemidx', () => {
    const r = parseWechatExport([article()]);
    expect(r.total).toBe(1);
    expect(r.skipped).toBe(0);
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0].platformItemId).toBe('2247484123_1');
    expect(r.posts[0].title).toBe('一篇公众号文章');
    expect(r.posts[0].summary).toBe('这是摘要');
    expect(r.posts[0].publishedAt).toBe(new Date(1750000000 * 1000).toISOString());
    expect(r.accountName).toBe('测试公众号');
  });

  it('{articles:[…]} / {data:{list:[…]}} 包裹形态都认', () => {
    expect(parseWechatExport({ articles: [article()] }).posts).toHaveLength(1);
    expect(parseWechatExport({ data: { list: [article()] } }).posts).toHaveLength(1);
  });

  it('JSON 文本与 NDJSON 文本都认', () => {
    expect(parseWechatExport(JSON.stringify([article()])).posts).toHaveLength(1);
    const ndjson = [article(), article({ aid: '2247484124_1', appmsgid: 2247484124 })]
      .map((a) => JSON.stringify(a))
      .join('\n');
    expect(parseWechatExport(ndjson).posts).toHaveLength(2);
  });

  it('垃圾输入不抛异常，返回空结果', () => {
    for (const junk of ['', 'not json', '<html></html>', null, 42, {}, [{ foo: 1 }]]) {
      const r = parseWechatExport(junk);
      expect(r.posts).toEqual([]);
    }
  });
});

describe('parseWechatExport · 文章身份（platformItemId）', () => {
  it('aid 形如 <appmsgid>_<idx> 时直接用——与官方 msgid+index 对齐，将来官方通道能 upsert 到同一条', () => {
    expect(parseWechatExport([article({ appmsgid: undefined })]).posts[0].platformItemId).toBe('2247484123_1');
  });

  it('无 aid/appmsgid 时从链接的 mid+idx 推', () => {
    const r = parseWechatExport([article({ aid: undefined, appmsgid: undefined, itemidx: undefined })]);
    expect(r.posts[0].platformItemId).toBe('2247484123_1');
  });

  it('只剩 sn 的分享链接用 sn_ 前缀', () => {
    const r = parseWechatExport([
      article({ aid: undefined, appmsgid: undefined, link: 'https://mp.weixin.qq.com/s?__biz=MzI5NjA=&sn=deadbeef' }),
    ]);
    expect(r.posts[0].platformItemId).toBe('sn_deadbeef');
  });

  it('定不出身份就丢弃，不拿标题凑 ID（否则造出永远对不上的记录）', () => {
    const r = parseWechatExport([{ title: '没有任何 ID 的文章', link: 'https://example.com/a' }]);
    expect(r.posts).toEqual([]);
    expect(r.skipped).toBe(1);
  });

  it('缺标题的条目丢弃', () => {
    const r = parseWechatExport([article({ title: '   ' })]);
    expect(r.posts).toEqual([]);
    expect(r.skipped).toBe(1);
  });

  it('同一篇重复出现（分页重叠）只留一条', () => {
    const r = parseWechatExport([article(), article(), article({ aid: '2247484124_1', appmsgid: 2247484124 })]);
    expect(r.posts).toHaveLength(2);
  });

  it('按发布时间倒序：中途失败也是少了旧文章而不是新文章', () => {
    const r = parseWechatExport([
      article({ aid: '1_1', appmsgid: 1, create_time: 1700000000 }),
      article({ aid: '2_1', appmsgid: 2, create_time: 1750000000 }),
    ]);
    expect(r.posts.map((p) => p.platformItemId)).toEqual(['2_1', '1_1']);
  });
});

describe('parseWechatExport · 指标一律不导（合规红线）', () => {
  it('readNum/oldLikeNum 等既不落到 posts 上，也被计数出来供 UI 明说', () => {
    const r = parseWechatExport([article({ readNum: 12345, oldLikeNum: 88, commentNum: 9 })]);
    expect(r.droppedMetrics).toBe(1);
    expect(Object.keys(r.posts[0])).not.toContain('metrics');
    expect(JSON.stringify(r.posts[0])).not.toContain('12345');
  });

  it('没有指标字段时 droppedMetrics 为 0', () => {
    expect(parseWechatExport([article()]).droppedMetrics).toBe(0);
  });
});

describe('normalizeArticleUrl · 只留寻址参数', () => {
  it('抓包得来的 key/pass_ticket/uin 不跟着 URL 落库', () => {
    const u = normalizeArticleUrl(
      'https://mp.weixin.qq.com/s?__biz=MzI5NjA=&mid=2247484123&idx=1&sn=abc&chksm=ec7&key=SECRET&pass_ticket=TICKET&uin=999',
    )!;
    expect(u).not.toContain('SECRET');
    expect(u).not.toContain('TICKET');
    expect(u).not.toContain('uin=');
    expect(u).toContain('mid=2247484123');
    expect(u).toContain('sn=abc');
    expect(u).toContain('chksm=ec7');
  });

  it('__biz 尾部的 == 原样保留（重建查询串会编码成 %3D，链接形态一改就是在赌服务端会解码）', () => {
    const u = normalizeArticleUrl('https://mp.weixin.qq.com/s?__biz=MzA5NDU5NTQwMA==&mid=224&idx=1&sn=abc&key=SECRET')!;
    expect(u).toBe('https://mp.weixin.qq.com/s?__biz=MzA5NDU5NTQwMA==&mid=224&idx=1&sn=abc');
  });

  it('http 升 https、去掉 #wechat_redirect 片段与埋点参数', () => {
    const u = normalizeArticleUrl(article().link)!;
    expect(u.startsWith('https://mp.weixin.qq.com/s?')).toBe(true);
    expect(u).not.toContain('#');
    expect(u).not.toContain('scene=');
  });

  it('非 mp 域名原样保留查询串；非法输入返回 undefined', () => {
    expect(normalizeArticleUrl('https://example.com/a?x=1')).toBe('https://example.com/a?x=1');
    expect(normalizeArticleUrl('')).toBeUndefined();
    expect(normalizeArticleUrl(null)).toBeUndefined();
  });
});

describe('actImportWechatArticles · 入库与归属闸', () => {
  let wechatId: string;
  let douyinId: string;

  beforeEach(async () => {
    await prisma.postMetricSnapshot.deleteMany();
    await prisma.crawledPost.deleteMany();
    await prisma.watchlistItem.deleteMany();
    await prisma.competitorAccount.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.tenant.deleteMany();

    const tenant = await prisma.tenant.create({ data: { name: 't1' } });
    const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w1' } });
    session.tenantId = tenant.id;
    session.workspaceId = ws.id;

    const wc = await prisma.competitorAccount.create({ data: { platform: 'wechat', handle: 'test_gzh', name: '测试公众号' } });
    const dy = await prisma.competitorAccount.create({ data: { platform: 'douyin', handle: 'sec_x', name: '某抖音号' } });
    wechatId = wc.id;
    douyinId = dy.id;
    await prisma.watchlistItem.create({ data: { workspaceId: ws.id, competitorId: wc.id } });
    await prisma.watchlistItem.create({ data: { workspaceId: ws.id, competitorId: dy.id } });
  });

  it('导入成功：作品入库、指标留空（无 metrics 的通道不写指标）', async () => {
    const posts = parseWechatExport([article()]).posts;
    const r = await actImportWechatArticles(wechatId, posts);
    expect(r.ok).toBe(true);
    expect(r.imported).toBe(1);

    const row = await prisma.crawledPost.findFirst({ where: { competitorId: wechatId } });
    expect(row?.platformItemId).toBe('2247484123_1');
    expect(row?.title).toBe('一篇公众号文章');
    expect(row?.publishedAt).toEqual(new Date(1750000000 * 1000));
    expect(parseJson<Record<string, number>>(row!.metrics, {})).toEqual({});
  });

  it('重复导入同一文件幂等：不产生第二条记录', async () => {
    const posts = parseWechatExport([article()]).posts;
    await actImportWechatArticles(wechatId, posts);
    await actImportWechatArticles(wechatId, posts);
    expect(await prisma.crawledPost.count({ where: { competitorId: wechatId } })).toBe(1);
  });

  it('归属闸：目标不是公众号账号一律拒绝（导错号＝数据页看不见还污染基线）', async () => {
    const r = await actImportWechatArticles(douyinId, parseWechatExport([article()]).posts);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('公众号');
    expect(await prisma.crawledPost.count()).toBe(0);
  });

  it('未订阅的竞对拒绝（跨租户写入闸）', async () => {
    const other = await prisma.competitorAccount.create({ data: { platform: 'wechat', handle: 'other', name: '别人的号' } });
    const r = await actImportWechatArticles(other.id, parseWechatExport([article()]).posts);
    expect(r.ok).toBe(false);
    expect(await prisma.crawledPost.count()).toBe(0);
  });

  it('空批与超批拒绝（单批上限与 HTTP 入口一致）', async () => {
    expect((await actImportWechatArticles(wechatId, [])).ok).toBe(false);
    const many = Array.from({ length: 51 }, (_, i) => ({ platformItemId: `${i}_1`, title: `t${i}` }));
    expect((await actImportWechatArticles(wechatId, many)).ok).toBe(false);
  });
});
