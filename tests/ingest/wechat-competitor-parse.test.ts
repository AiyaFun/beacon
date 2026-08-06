import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { ingestPayloadSchema } from '@/lib/ingest/competitor';
import { parseWechatExport } from '@/lib/ingest/wechat-export';

// 公众号竞对采集脚本（extension/content/wechat-competitor.js）。
//
// 这个脚本要真登录态才能跑，所以能自动化验的是**解析与节流逻辑**：给它一份与真实接口相同形状的
// 响应（下面的样本字段取自 2026-07-29 对「央视新闻」的实测返回），看它
//   1. 抠出的 platformItemId 与文件导入通道（lib/ingest/wechat-export.ts）**逐条一致**——
//      两条通道对不上就会给同一篇文章建出两条记录；
//   2. 时间截断真的生效（早于 N 天就停，否则央视新闻这种 44174 篇的号会一路翻到底）；
//   3. 频控/登录态过期被分开识别（前者要停手冷却，后者要让用户重新登录，重试无意义）；
//   4. 一条互动指标都不带回来（阅读量要抓包才有，是既定红线外的灰色通道）。
//
// ⚠️ 验的是「结构对得上时逻辑是对的」，不是「微信的结构永远是这样」——后者只能真机校准。

const SRC = readFileSync(resolve(process.cwd(), 'extension/content/wechat-competitor.js'), 'utf8');

type Wc = {
  RULES: { maxPages: number; pageSize: number; recentDays: number; minGapMs: number; maxGapMs: number };
  mapArticle: (m: Record<string, unknown>) => Record<string, unknown> | null;
  collect: (name: string) => Promise<Record<string, unknown>>;
  readToken: () => string;
};

// 在受控 DOM + 全局环境里跑内容脚本，取回它挂到 globalThis 的 __beaconWechatCompetitor。
// fetchImpl 由用例提供：脚本里所有网络访问都走它，测试因此完全离线。
// 要 DOM 是因为 token 有三个来源（地址栏 / 页面链接 / 内联脚本），后两个只有真 DOM 才验得了。
const HOME = 'https://mp.weixin.qq.com/cgi-bin/home?t=home/index&token=1234567890&lang=zh_CN';

function runScript(fetchImpl: (url: string) => unknown, opts: { href?: string; html?: string } = {}) {
  const dom = new JSDOM(opts.html ?? '<body></body>', { url: opts.href ?? HOME });
  const ctx: Record<string, unknown> = {
    location: dom.window.location,
    document: dom.window.document,
    URL,
    URLSearchParams,
    fetch: async (url: string) => ({ json: async () => fetchImpl(url) }),
    setTimeout: (fn: () => void) => { fn(); return 0 as unknown as NodeJS.Timeout; }, // 间隔在测试里立即返回
    Math,
    Date,
    JSON,
    Number,
    String,
    Array,
    console,
    chrome: undefined,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return ctx.__beaconWechatCompetitor as Wc;
}

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);

// 实测样本：字段名与值的形态取自真实返回（短链形态 /s/<token>、digest 为空、aid=<appmsgid>_<idx>）
function article(over: Record<string, unknown> = {}) {
  return {
    aid: '2657951340_1',
    appmsgid: 2657951340,
    itemidx: 1,
    title: '日本熊本县地震已致13人死亡',
    link: 'https://mp.weixin.qq.com/s/JQP3IB7YvzIMym8uZyuLXg',
    digest: '',
    create_time: now() - 3600,
    update_time: now() - 3600,
    author_name: '',
    ...over,
  };
}

function publishPage(items: Record<string, unknown>[][]) {
  return JSON.stringify({
    total_count: 44174,
    publish_list: items.map((appmsgex) => ({ publish_info: JSON.stringify({ appmsgex }) })),
  });
}

function mkFetch(opts: {
  search?: unknown;
  pages?: Record<string, unknown>[][][];
  articlesResp?: unknown;
}) {
  const calls: string[] = [];
  const pages = opts.pages ?? [];
  let pageIdx = 0;
  const impl = (url: string) => {
    calls.push(url);
    if (url.includes('/cgi-bin/searchbiz')) {
      return opts.search ?? { base_resp: { ret: 0 }, total: 1, list: [{ nickname: '央视新闻', fakeid: 'MTI0MDU3NDYwMQ==' }] };
    }
    if (opts.articlesResp) return opts.articlesResp;
    const page = pages[pageIdx++] ?? [];
    return { base_resp: { ret: 0 }, publish_page: publishPage(page) };
  };
  return { impl, calls };
}

describe('wechat-competitor · 文章映射与两条通道的口径一致', () => {
  it('platformItemId / url / publishedAt 与文件导入通道逐条一致', () => {
    const wc = runScript(() => ({}));
    const raw = article();
    const viaPlugin = wc.mapArticle(raw)!;
    const viaFile = parseWechatExport([raw]).posts[0];
    expect(viaPlugin.platformItemId).toBe(viaFile.platformItemId);
    expect(viaPlugin.url).toBe(viaFile.url);
    expect(viaPlugin.publishedAt).toBe(viaFile.publishedAt);
    expect(viaPlugin.title).toBe(viaFile.title);
  });

  it('无 aid 时用 appmsgid_itemidx；两者都没有就丢弃（不拿标题凑 ID）', () => {
    const wc = runScript(() => ({}));
    expect(wc.mapArticle(article({ aid: undefined }))!.platformItemId).toBe('2657951340_1');
    expect(wc.mapArticle(article({ aid: undefined, appmsgid: undefined }))).toBeNull();
    expect(wc.mapArticle(article({ title: '   ' }))).toBeNull();
  });

  it('一条互动指标都不带回来', () => {
    const wc = runScript(() => ({}));
    const out = wc.mapArticle(article({ readNum: 99999, oldLikeNum: 88, commentNum: 7 }))!;
    expect(Object.keys(out)).not.toContain('metrics');
    expect(JSON.stringify(out)).not.toContain('99999');
  });
});

// 真机 2026-07-29 的回归：用户登着后台却被报「没登录」——因为当时只读地址栏，
// 而插件自己开的 /cgi-bin/home 不保证把 token 补进地址。「地址栏没 token」≠「没登录」。
describe('wechat-competitor · token 的三个来源（登录态判断不能只看地址栏）', () => {
  it('地址栏有就直接用', () => {
    expect(runScript(() => ({})).readToken()).toBe('1234567890');
  });

  it('地址栏没有时，从页面菜单链接里取', () => {
    const wc = runScript(() => ({}), {
      href: 'https://mp.weixin.qq.com/cgi-bin/home',
      html: '<body><a href="/cgi-bin/appmsg?t=media/appmsg_edit&token=987654321&lang=zh_CN">素材管理</a></body>',
    });
    expect(wc.readToken()).toBe('987654321');
  });

  it('再没有就从内联脚本里取（隔离世界读不到 JS 变量，但读得到 script 文本）', () => {
    const wc = runScript(() => ({}), {
      href: 'https://mp.weixin.qq.com/cgi-bin/home',
      html: '<body><script>window.wx = { cgiData: { token: 555666777, nickname: "x" } };</script></body>',
    });
    expect(wc.readToken()).toBe('555666777');
  });

  it('停在登录页 → 说「未登录、去扫码」', async () => {
    const r = await runScript(() => ({}), {
      href: 'https://mp.weixin.qq.com/cgi-bin/loginpage?t=wxm2-login&lang=zh_CN',
      html: '<body><div id="headimg_qrcode"></div></body>',
    }).collect('央视新闻');
    expect(String(r.error)).toContain('未登录');
    expect(String(r.error)).toContain('扫码');
  });

  it('不是登录页但取不到 → 说「换个后台页面再点」，不误报未登录', async () => {
    const r = await runScript(() => ({}), { href: 'https://mp.weixin.qq.com/cgi-bin/home' }).collect('央视新闻');
    expect(String(r.error)).toContain('取不到后台 token');
    expect(String(r.error)).not.toContain('未登录');
  });
});

describe('wechat-competitor · 采集流程与刹车', () => {
  it('正常采集：搜到同名号 → 拉列表 → 出合法 ingest payload（且不建档）', async () => {
    const { impl } = mkFetch({ pages: [[[article()], [article({ aid: '2657951332_1', appmsgid: 2657951332 })]], []] });
    const r = await runScript(impl).collect('央视新闻');
    expect(r.ok).toBe(true);
    const parsed = ingestPayloadSchema.safeParse(r.payload);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.platform).toBe('wechat');
    expect(parsed.success && parsed.data.autoSubscribe).toBe(false); // 竞对必须已订阅，这条通道不建档
    expect((r.payload as { posts: unknown[] }).posts).toHaveLength(2);
  });

  it('翻到早于 recentDays 的文章就停，不会一路翻到底', async () => {
    const wc0 = runScript(() => ({}));
    const old = article({ aid: '1_1', appmsgid: 1, create_time: now() - (wc0.RULES.recentDays + 3) * DAY });
    const { impl, calls } = mkFetch({ pages: [[[article()], [old]], [[article({ aid: '2_1', appmsgid: 2 })]]] });
    const r = await runScript(impl).collect('央视新闻');
    expect((r.payload as { posts: unknown[] }).posts).toHaveLength(1); // 只留 7 天内那条
    expect(calls.filter((u) => u.includes('appmsgpublish'))).toHaveLength(1); // 第二页没去翻
  });

  it('页数上限兜住「全是新文章」的号（央视新闻这种一天几十篇的）', async () => {
    const wc0 = runScript(() => ({}));
    const fresh = Array.from({ length: 10 }, (_, i) => [article({ aid: `${i}_1`, appmsgid: i })]);
    const { impl, calls } = mkFetch({ pages: [fresh, fresh, fresh, fresh] });
    await runScript(impl).collect('央视新闻');
    expect(calls.filter((u) => u.includes('appmsgpublish'))).toHaveLength(wc0.RULES.maxPages);
  });

  it('只认完全同名：搜到近似号也不猜，把候选报回去', async () => {
    const { impl } = mkFetch({
      search: { base_resp: { ret: 0 }, total: 2, list: [{ nickname: '央视新闻客户端', fakeid: 'a' }, { nickname: '央视网', fakeid: 'b' }] },
    });
    const r = await runScript(impl).collect('央视新闻');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('not_found');
    expect(String(r.error)).toContain('央视新闻客户端'); // 告诉用户后台里的准确名字
  });

  it('登录态过期与频控分开识别（一个要重新登录，一个要停手冷却）', async () => {
    const expired = mkFetch({ search: { base_resp: { ret: 200003, err_msg: 'invalid session' } } });
    expect((await runScript(expired.impl).collect('央视新闻')).code).toBe('session_expired');

    const freq = mkFetch({ search: { base_resp: { ret: 200013, err_msg: 'freq control' } } });
    const r = await runScript(freq.impl).collect('央视新闻');
    expect(r.code).toBe('rate_limited');
    expect(String(r.error)).toContain('频繁');
  });

  it('哪儿都没有 token 才算失败，且不发任何请求', async () => {
    const { impl, calls } = mkFetch({});
    const r = await runScript(impl, { href: 'https://mp.weixin.qq.com/cgi-bin/home' }).collect('央视新闻');
    expect(r.code).toBe('no_token');
    expect(calls).toHaveLength(0);
  });

  it('第二页撞频控：已拿到的照常入库，但把原因带上去', async () => {
    let n = 0;
    const impl = (url: string) => {
      if (url.includes('searchbiz')) return { base_resp: { ret: 0 }, list: [{ nickname: '央视新闻', fakeid: 'x' }] };
      n++;
      return n === 1
        ? { base_resp: { ret: 0 }, publish_page: publishPage([[article()], [article({ aid: '9_1', appmsgid: 9 })]]) }
        : { base_resp: { ret: 200013, err_msg: 'freq control' } };
    };
    const r = await runScript(impl).collect('央视新闻');
    expect(r.ok).toBe(true);
    expect((r.payload as { posts: unknown[] }).posts).toHaveLength(2);
    expect(String(r.partial)).toContain('频繁');
    expect(r.code).toBe('rate_limited'); // sw.js 据此进入冷却
  });
});
