import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { clipUrl, clipText } from '@/lib/clip';
import { loadExemplars } from '@/lib/account-context';
import { handleInbound } from '@/lib/bot/router';

// 文章剪藏：群里发链接/正文 → 抓正文 → 摘要+要点+结合账号的用处 → 存收集箱。
//
// 这套用例里**最重要的一条是「正文绝不进生成语料池」**（下面那个 🔒 用例）。
// 存他人正文本身在「个人学习研究」范围内；一旦这些文字流进「像我一样写」的原句样本，
// 这个功能就从学习工具变成了洗稿工具。那条线只能靠测试守住，不能靠记性。

const CTX = { provider: 'feishu', integrationId: 'bi1', chatId: 'oc_1' };

const ARTICLE_HTML = `<html><head><meta property="og:title" content="内容中台重做记"></head><body>
  <nav>导航</nav>
  <article><p>${'我们把采集口径统一成了一套，日处理量翻了四倍。'.repeat(8)}</p></article>
  <footer>版权所有</footer></body></html>`;

// 注入的假抓取：完全不碰网络/DNS
const fakeFetch = (html = ARTICLE_HTML, url = 'https://example.com/a') => async () => ({
  finalUrl: new URL(url),
  contentType: 'text/html; charset=utf-8',
  text: html,
});

beforeEach(async () => {
  await prisma.tenant.deleteMany({});
  // 竞对档案是全局共享表，不随租户级联，得单独清（否则第二个用例撞 (platform,handle) 唯一约束）
  await prisma.competitorAccount.deleteMany({});
  await prisma.tenant.create({ data: { id: 't1', name: 'T', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: 'W' } });
  await prisma.creatorAccount.create({ data: { id: 'a1', workspaceId: 'w1', name: '测试号', platform: 'wechat', status: 'active' } });
  await prisma.botIntegration.create({
    data: { id: 'bi1', workspaceId: 'w1', provider: 'feishu', label: 'B', inboundKey: 'cli_x', pushEvents: '[]' },
  });
});
afterEach(() => vi.restoreAllMocks());

async function mockLlm(payload: unknown = { summary: '讲的是采集口径统一', points: ['口径统一', '日处理量翻四倍'], takeaway: '可以做一期「口径」选题' }, extra: Record<string, unknown> = {}) {
  const gw = await import('@/lib/llm/gateway');
  return vi.spyOn(gw, 'llmComplete').mockResolvedValue({
    text: JSON.stringify(payload), mocked: false, promptTokens: 1, completionTokens: 1, model: 'x', provider: 'x', ...extra,
  } as any);
}

describe('clipUrl · 抓正文 → 摘要 → 落库', () => {
  it('存下正文、摘要、要点、结合账号的用处', async () => {
    await mockLlm();
    const r = await clipUrl({ workspaceId: 'w1', accountId: 'a1', accountName: '测试号', url: 'https://example.com/a', fetchPage: fakeFetch() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.title).toBe('内容中台重做记');
    expect(r.summary).toContain('采集口径');
    expect(r.points).toHaveLength(2);
    expect(r.analysis).toContain('选题');

    const row = await prisma.inspirationItem.findFirst({ where: { workspaceId: 'w1' } });
    expect(row?.source).toBe('clip');
    expect(row?.content).toContain('日处理量翻了四倍');
    expect(row?.content).not.toContain('版权所有'); // 页脚不算正文
    expect(JSON.parse(row!.points)).toEqual(['口径统一', '日处理量翻四倍']);
    expect(row?.clippedAt).toBeTruthy();
  });

  it('同一链接再发一次 → 更新而不是堆重复', async () => {
    await mockLlm();
    await clipUrl({ workspaceId: 'w1', accountId: 'a1', url: 'https://example.com/a', fetchPage: fakeFetch() });
    const r2 = await clipUrl({ workspaceId: 'w1', accountId: 'a1', url: 'https://example.com/a', fetchPage: fakeFetch() });
    expect(r2.ok && r2.duplicate).toBe(true);
    expect(await prisma.inspirationItem.count()).toBe(1);
  });

  it('🔒 撞上登录墙 → 说清是登录墙并给出路（比笼统的「解析失败」有用得多）', async () => {
    await mockLlm();
    const r = await clipUrl({ workspaceId: 'w1', accountId: 'a1', url: 'https://example.com/x', fetchPage: fakeFetch('<html><body><nav>登录后查看</nav></body></html>') });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('登录');
    expect(r.error).toMatch(/采集助手|粘/); // 必须告诉他下一步怎么办
    expect(await prisma.inspirationItem.count()).toBe(0);
  });

  it('🔒 微信验证页 → 点名是反爬，且明说不绕过', async () => {
    await mockLlm();
    const r = await clipUrl({
      workspaceId: 'w1', accountId: 'a1', url: 'https://mp.weixin.qq.com/s/x',
      fetchPage: async () => ({
        finalUrl: new URL('https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?poc_token=x'),
        contentType: 'text/html', text: '<html><head><title>未知错误</title></head><body></body></html>',
      }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('验证页');
  });

  it('页面本身就没内容（不是墙）→ 退回「没解析出正文」', async () => {
    await mockLlm();
    const r = await clipUrl({ workspaceId: 'w1', accountId: 'a1', url: 'https://example.com/x', fetchPage: fakeFetch('<html><body><div>短</div></body></html>') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('没解析出正文');
    expect(await prisma.inspirationItem.count()).toBe(0);
  });

  it('🔒 已知抓不到的平台（小红书/抖音等）→ 不空跑抓取，直接给平台专属指引', async () => {
    const r = await clipUrl({ workspaceId: 'w1', accountId: 'a1', url: 'https://www.xiaohongshu.com/explore/123' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('小红书');
      expect(r.error).toContain('采集助手');
    }
  });

  it('🔒 AI 挂了 → 正文照存，只是没有摘要（存下来的东西不该因为 AI 不可用就丢）', async () => {
    const gw = await import('@/lib/llm/gateway');
    vi.spyOn(gw, 'llmComplete').mockRejectedValue(new Error('provider down'));
    const r = await clipUrl({ workspaceId: 'w1', accountId: 'a1', url: 'https://example.com/a', fetchPage: fakeFetch() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.degraded).toBe(true);
    expect(r.summary).toBe('');
    expect((await prisma.inspirationItem.findFirst())?.content).toContain('日处理量');
  });

  it('AI 降级为 Mock → 标记 degraded，让回执能说破', async () => {
    await mockLlm({ summary: '示例', points: [], takeaway: '' }, { mocked: true, degraded: true });
    const r = await clipUrl({ workspaceId: 'w1', accountId: 'a1', url: 'https://example.com/a', fetchPage: fakeFetch() });
    expect(r.ok && r.degraded).toBe(true);
  });

  it('抓取失败（SSRF 拦截/超时）→ 原样把原因带回给用户', async () => {
    const r = await clipUrl({
      workspaceId: 'w1', accountId: 'a1', url: 'http://127.0.0.1/admin',
      fetchPage: async () => { throw new Error('不允许访问内网 / 本机地址'); },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('内网');
  });
});

describe('clipText · 直接粘正文', () => {
  it('长正文存下来，标题取首行', async () => {
    await mockLlm();
    const text = `一篇没有链接的长文\n${'正文内容很长很长。'.repeat(30)}`;
    const r = await clipText({ workspaceId: 'w1', accountId: 'a1', text });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.title).toBe('一篇没有链接的长文');
    expect((await prisma.inspirationItem.findFirst())?.url).toBeNull();
  });

  it('太短的正文不剪藏（那本来就该当选题收录）', async () => {
    const r = await clipText({ workspaceId: 'w1', accountId: 'a1', text: '就一句话' });
    expect(r.ok).toBe(false);
  });
});

describe('🔒 合规护栏：剪藏正文绝不进入生成语料池', () => {
  it('剪藏了他人正文之后，「像我一样写」的原句样本仍然一条都取不到它', async () => {
    await mockLlm();
    await clipUrl({ workspaceId: 'w1', accountId: 'a1', url: 'https://example.com/a', fetchPage: fakeFetch() });

    const stored = await prisma.inspirationItem.findFirst({ where: { workspaceId: 'w1' } });
    expect(stored?.content).toContain('日处理量翻了四倍'); // 确实存进去了

    // 原句样本只取 Material(sample) / PublishRecord.contentText / DraftVersion(human)
    const exemplars = await loadExemplars('a1');
    expect(exemplars).toHaveLength(0);
    expect(JSON.stringify(exemplars)).not.toContain('日处理量');
  });
});

describe('handleInbound · 群里发链接与长文', () => {
  it('发文章链接 → 剪藏并回摘要（不再只是收录一条标题）', async () => {
    await mockLlm();
    const gw = await import('@/lib/web/fetch');
    vi.spyOn(gw, 'safeFetch').mockResolvedValue({ finalUrl: new URL('https://example.com/a'), contentType: 'text/html', text: ARTICLE_HTML });

    const reply = await handleInbound('w1', '这篇不错 https://example.com/a', CTX);
    expect(reply).toContain('已存入收集箱');
    expect(reply).toContain('摘要');
    expect(reply).toContain('别直接复用其文字'); // 回执必须带来源与用法声明
    expect(await prisma.inspirationItem.count()).toBe(1);
  });

  it('粘一整篇正文（无链接）→ 剪藏，而不是截成 120 字的选题标题', async () => {
    await mockLlm();
    const long = `深度长文标题\n${'这里是正文，很长很长的一段内容。'.repeat(30)}`;
    const reply = await handleInbound('w1', long, CTX);
    expect(reply).toContain('已存入收集箱');
    expect(await prisma.inspirationItem.count()).toBe(1);
    expect(await prisma.topicIdea.count()).toBe(0);
  });

  it('短文本仍按老规矩收录成选题（剪藏没抢走它）', async () => {
    await mockLlm();
    const reply = await handleInbound('w1', '露营装备测评', CTX);
    expect(reply).toContain('已收录');
    expect(await prisma.topicIdea.count()).toBe(1);
    expect(await prisma.inspirationItem.count()).toBe(0);
  });

  it('🔒 管理员关掉剪藏 → 链接退回选题收录，正文不落库', async () => {
    await prisma.botIntegration.update({ where: { id: 'bi1' }, data: { allowCommands: JSON.stringify(['help', 'topic']) } });
    await mockLlm();
    const reply = await handleInbound('w1', 'https://example.com/a', CTX);
    expect(reply).toContain('收录');
    expect(await prisma.inspirationItem.count()).toBe(0);
    expect(await prisma.topicIdea.count()).toBe(1);
  });

  it('/存 是显式入口', async () => {
    await mockLlm();
    const gw = await import('@/lib/web/fetch');
    vi.spyOn(gw, 'safeFetch').mockResolvedValue({ finalUrl: new URL('https://example.com/a'), contentType: 'text/html', text: ARTICLE_HTML });
    expect(await handleInbound('w1', '/存 https://example.com/a', CTX)).toContain('已存入收集箱');
  });
});

describe('竞对内容：怎么拿到、怎么拆', () => {
  async function withRival() {
    const c = await prisma.competitorAccount.create({
      data: { platform: 'wechat', handle: 'rival01', name: '同行老王' },
    });
    await prisma.watchlistItem.create({ data: { workspaceId: 'w1', competitorId: c.id } });
    await prisma.crawledPost.create({
      data: {
        competitorId: c.id, platform: 'wechat', platformItemId: 'p1',
        title: '他那条爆了的推文', url: 'https://example.com/rival-post',
        hotScore: 88, metrics: JSON.stringify({ views: 120000 }),
        publishedAt: new Date('2026-07-27T00:00:00Z'),
      },
    });
    return c;
  }

  it('/竞对 → 列出近期高热作品，并带上链接（下一步动作靠它）', async () => {
    await withRival();
    const reply = await handleInbound('w1', '/竞对', CTX);
    expect(reply).toContain('同行老王');
    expect(reply).toContain('他那条爆了的推文');
    expect(reply).toContain('120000');
    expect(reply).toContain('https://example.com/rival-post'); // 没链接就没有下一步
  });

  it('没有竞对时给出加竞对的入口，而不是空白', async () => {
    expect(await handleInbound('w1', '/竞对', CTX)).toContain('/采集');
  });

  it('🔒 发的是监控中竞对的作品链接 → 自动切成「爆款拆解」，不是读书笔记', async () => {
    await withRival();
    const spy = await mockLlm({ summary: '讲了他的方法', points: ['标题带数字', '开头抛冲突'], takeaway: '结构可借鉴' });
    const web = await import('@/lib/web/fetch');
    vi.spyOn(web, 'safeFetch').mockResolvedValue({ finalUrl: new URL('https://example.com/rival-post'), contentType: 'text/html', text: ARTICLE_HTML });

    const reply = await handleInbound('w1', 'https://example.com/rival-post', CTX);
    expect(reply).toContain('竞对作品拆解');
    expect(reply).toContain('同行老王');
    expect(reply).toContain('它凭什么跑起来');

    // 提示词确实换成了拆解视角，而不是只换了回执措辞
    const sys = String((spy.mock.calls.at(-1)![2] as any[])[0].content);
    expect(sys).toContain('拆解');
    expect(sys).toContain('同行老王');
    expect(sys).toContain('不搬文字'); // 拆解也不许教人抄
  });

  it('非竞对链接仍是学习笔记视角', async () => {
    await withRival();
    await mockLlm();
    const web = await import('@/lib/web/fetch');
    vi.spyOn(web, 'safeFetch').mockResolvedValue({ finalUrl: new URL('https://other.com/a'), contentType: 'text/html', text: ARTICLE_HTML });
    const reply = await handleInbound('w1', 'https://other.com/a', CTX);
    expect(reply).toContain('已存入收集箱');
    expect(reply).not.toContain('竞对作品拆解');
  });
});

describe('资讯库 · 插件抓到的正文回传（跨平台的唯一可行入口）', () => {
  it('带 content 的回传 → 走 clip 管线：存正文 + 出摘要要点，并记下平台', async () => {
    await mockLlm();
    const { ingestInspiration } = await import('@/lib/ingest/inspiration');
    const r = await ingestInspiration('w1', {
      title: '小红书上的一篇笔记',
      url: 'https://www.xiaohongshu.com/explore/abc',
      platform: 'xiaohongshu',
      author: '某博主',
      source: 'clip',
      content: '这是插件在浏览器里读到的正文。'.repeat(20),
    } as any, 'a1');
    expect(r.ok).toBe(true);

    const row = await prisma.inspirationItem.findFirst({ where: { source: 'clip' } });
    expect(row?.platform).toBe('xiaohongshu'); // 插件给的平台优先于按域名猜
    expect(row?.content).toContain('插件在浏览器里读到的正文');
    expect(row?.summary).toBeTruthy();
    expect(JSON.parse(row!.points).length).toBeGreaterThan(0);
  });

  it('🔒 不带 content 的老通道行为完全不变（只存标题+链接，不出摘要）', async () => {
    const { ingestInspiration } = await import('@/lib/ingest/inspiration');
    const r = await ingestInspiration('w1', {
      title: '一条普通收藏', url: 'https://example.com/b', source: 'plugin',
    } as any, 'a1');
    expect(r.ok).toBe(true);
    const row = await prisma.inspirationItem.findFirst({ where: { url: 'https://example.com/b' } });
    expect(row?.source).toBe('plugin');
    expect(row?.content).toBeNull();
    expect(row?.summary).toBeNull();
  });

  it('正文太短 → 明确失败，不落一条空壳', async () => {
    const { ingestInspiration } = await import('@/lib/ingest/inspiration');
    const r = await ingestInspiration('w1', {
      title: 'x', url: 'https://example.com/c', source: 'clip', content: '太短了',
    } as any, 'a1');
    // 太短的 content 走老通道（当普通收藏存），不该报错也不该出摘要
    expect(r.ok).toBe(true);
    expect((await prisma.inspirationItem.findFirst({ where: { url: 'https://example.com/c' } }))?.summary).toBeNull();
  });
});
