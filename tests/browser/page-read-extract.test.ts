import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// 页面直读（2026-09-16）：模型从页面可见文字里读出作品与数字。
//
// 这条路最容易出的事是「模型把没有的数字编出来」「把隔壁作品的数字挂错」。所以守的是三道机器闸：
//   ① 作品 ID 只从链接里抠，模型只能引用页面上真实存在的链接编号；
//   ② 每个数字必须在页面文字里原样出现，不在就丢掉这个指标；
//   ③ 一个数都没核上的作品不入库。
// 模型的回答在这里是伪造的——测的正是「模型说什么不算，闸说了算」。

const llm = vi.fn();
vi.mock('@/lib/llm/gateway', () => ({ llmComplete: (...args: unknown[]) => llm(...args) }));

const { extractPostsFromPage, appearsInText, candidateLinks, itemIdFromLink, buildExtractPrompt } = await import('@/lib/browser/page-read-extract');

const read = (text: string, links: { href: string; text: string }[]) => ({ title: 't', finalUrl: 'https://x/', text, links });

beforeEach(() => { llm.mockReset(); });

describe('闸 ①：作品 ID 只从链接里抠', () => {
  it('六个手写平台走 parsePublishUrl，五个配方平台走 platformItemIdFrom，平台对不上就不算', () => {
    expect(itemIdFromLink('douyin', 'https://www.douyin.com/video/7412345678901234567')).toBe('7412345678901234567');
    expect(itemIdFromLink('xiaohongshu', 'https://www.douyin.com/video/7412345678901234567'), '抖音链接不能当小红书作品').toBeNull();
    expect(itemIdFromLink('zhihu', 'https://www.zhihu.com/answer/1001')).toBe('1001');
    expect(itemIdFromLink('zhihu', 'https://www.zhihu.com/people/someone'), '主页链接没有作品 ID').toBeNull();
  });

  it('候选链接按 ID 去重、封顶', () => {
    const links = [
      { href: 'https://www.zhihu.com/answer/1001', text: 'A' },
      { href: 'https://www.zhihu.com/answer/1001?from=x', text: 'A again' },
      { href: 'https://www.zhihu.com/answer/1002', text: 'B' },
      { href: 'https://www.zhihu.com/people/me', text: 'me' },
    ];
    const c = candidateLinks('zhihu', read('', links));
    expect(c.map((l) => l.id)).toEqual(['1001', '1002']);
  });
});

describe('闸 ②：数字必须在页面文字里原样出现', () => {
  it('空白与逗号不算差异；不在页面上的就不算', () => {
    const text = '播放 1.2万 · 点赞 3,456 · 评论 12';
    expect(appearsInText('1.2万', text)).toBe(true);
    expect(appearsInText('3456', text)).toBe(true);
    expect(appearsInText('9999', text)).toBe(false);
    expect(appearsInText('', text)).toBe(false);
  });
});

describe('extractPostsFromPage：模型说什么不算，闸说了算', () => {
  const links = [
    { href: 'https://www.zhihu.com/answer/1001', text: '第一篇' },
    { href: 'https://www.zhihu.com/answer/1002', text: '第二篇' },
  ];
  const text = '张三 粉丝 2.3万\n第一篇 赞同 1.2万 评论 300\n第二篇 赞同 800';

  it('引用真实链接、数字核得上的作品入库；编出来的数字被丢、没链接的作品被丢、一个数都没核上的被丢', async () => {
    llm.mockResolvedValue({ text: JSON.stringify({
      profile: { name: '张三', followers: '2.3万' },
      posts: [
        { link: 0, title: '第一篇', likes: '1.2万', comments: '300', views: '99999' }, // views 是编的
        { link: 1, title: '第二篇', likes: '800' },
        { link: 5, title: '不存在的链接', likes: '800' },
        { link: 1, title: '重复', likes: '800' },
        { title: '没链接', likes: '800' },
      ],
    }) });
    const r = await extractPostsFromPage({ tenantId: null, platform: 'zhihu', read: read(text, links) });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (!r.ok) return;
    expect(r.data.profile).toEqual({ name: '张三', followers: 23000 });
    expect(r.data.posts.map((p) => p.platformItemId)).toEqual(['1001', '1002']);
    expect(r.data.posts[0].metrics).toEqual({ likes: 12000, comments: 300 });
    expect(r.data.posts[0].metrics, '页面上没有 99999，这个数不许入库').not.toHaveProperty('views');
    expect(r.data.posts[1].metrics).toEqual({ likes: 800 });
    expect(r.data.dropped).toBe(3);
    expect(r.data.candidates).toBe(2);
  });

  it('模型只给了核不上的数字：一条都不入库，dropped 如实计数', async () => {
    llm.mockResolvedValue({ text: JSON.stringify({ posts: [{ link: 0, likes: '77777' }] }) });
    const r = await extractPostsFromPage({ tenantId: null, platform: 'zhihu', read: read(text, links) });
    expect(r.ok && r.data.posts.length).toBe(0);
    expect(r.ok && r.data.dropped).toBe(1);
  });

  it('示例模型（mocked）不能直读页面：如实拒绝，不给假数据', async () => {
    llm.mockResolvedValue({ text: '{"posts":[{"link":0,"likes":"800"}]}', mocked: true });
    const r = await extractPostsFromPage({ tenantId: null, platform: 'zhihu', read: read(text, links) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('示例模型');
  });

  it('模型回的不是 JSON：如实拒绝', async () => {
    llm.mockResolvedValue({ text: '我不确定' });
    const r = await extractPostsFromPage({ tenantId: null, platform: 'zhihu', read: read(text, links) });
    expect(r.ok).toBe(false);
  });

  it('提示词里把规则写死：只能引用编号、数字原样抄、没写的省略', () => {
    const p = buildExtractPrompt('zhihu', read(text, links), candidateLinks('zhihu', read(text, links)));
    expect(p).toContain('[0] 第一篇 → https://www.zhihu.com/answer/1001');
    expect(p).toContain('原样抄');
    expect(p).toContain('不要猜');
    expect(p).toMatch(/temperature|/); // 温度在调用点：下面钉源码
    const src = fs.readFileSync(path.join(process.cwd(), 'lib/browser/page-read-extract.ts'), 'utf8');
    expect(src).toContain("{ json: true, temperature: 0 }");
  });
});

describe('🔒 三条执行路都接了页面直读', () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const read = (p: string) => strip(fs.readFileSync(path.join(process.cwd(), p), 'utf8'));

  it('本机浏览器：解析器认不出时带回 read，落库前先走 ingestPageRead；回执标「模型直读」', () => {
    const lc = read('lib/browser/local-collect.ts');
    expect(lc).toContain('export const PAGE_READ_FN');
    expect(lc).toMatch(/const read = \('error' in r \|\| !r\.payload\.posts\?\.length\)/);
    const run = read('lib/browser-task/local-run.ts');
    expect(run).toContain('if (r.read) {');
    expect(run).toContain('ingestPageRead({');
    expect(run).toContain('模型直读');
    expect(run, '页面直读的产出必须标出来，不能混进解析器的数据').toContain('modelRead: true');
  });

  it('桌面客户端：解析器认不出 / 一条没读到时带回 read（页面文字太少的不带——那是没渲染完，该重试）', () => {
    const rs = read('desktop/src-tauri/src/executor.rs');
    expect(rs).toContain('async fn page_read_fallback(');
    expect(rs).toMatch(/const PAGE_READ_MIN_CHARS: usize = \d+/);
    expect(rs).toMatch(/if chars < PAGE_READ_MIN_CHARS \{\s*return Err\(why\);/);
    expect(rs).toContain('return page_read_fallback(page, scripts, why).await;');
  });

  it('服务端交活入口：主页类没作品但带 read → 模型直读；配方学习中也用 read 兜底', () => {
    const run = read('lib/browser-task/local-run.ts');
    const dispatch = run.slice(run.indexOf('export async function ingestExecutorResult'));
    expect(dispatch).toContain('if (page.read) {');
    const recipe = run.slice(run.indexOf('export async function ingestRecipeOutcome'), run.indexOf('async function recipePlatform'));
    expect(recipe).toContain("outcome.mode === 'learn' || outcome.mode === 'stale'");
    expect(recipe).toContain('if (input.read) {');
  });
});
