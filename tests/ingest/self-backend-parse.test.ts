import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { ownPostIngestSchema } from '@/lib/ingest/own-post';
import { parsePublishUrl } from '@/lib/publish/parse-url';

// 创作者后台采集脚本（extension/content/self-backend.js）的解析层。
//
// 这些后台需要真实登录态，开发环境打不开，所以**唯一**能自动化验证的就是：
// 给它一段与真实后台结构相仿的 DOM，看它抠不抠得对。锁三件事：
//   1. 抠出的 platformItemId 与 lib/publish/parse-url.ts **逐平台同口径**
//      （对不上就会给同一条作品建出第二条记录）；
//   2. 完播率被当成率解析（0.42 不许被取整成 0），且中文列名对得上；
//   3. 认不出 ID 的行直接跳过——绝不猜（猜错会把数据挂到别人的作品上）。
//
// ⚠️ 这里验的是**解析逻辑**，不是真实后台的 DOM 结构（那个只能真机校准，见 README）。
// 真实后台改版时本测试仍会绿——它保证的是「结构对得上时逻辑是对的」，不是「结构永远对得上」。

const SRC = readFileSync(resolve(process.cwd(), 'extension/content/self-backend.js'), 'utf8');

// common.js 提供的中文数字解析（万/亿/k），内容脚本依赖它。这里给等价实现。
function parseCount(text: unknown): number | undefined {
  if (text == null) return undefined;
  const t = String(text).replace(/[,\s]/g, '');
  const m = t.match(/([\d.]+)\s*(万|亿|w|W|k|K)?/);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const u = m[2];
  if (u === '亿') return Math.round(n * 1e8);
  if (u === '万' || u === 'w' || u === 'W') return Math.round(n * 1e4);
  if (u === 'k' || u === 'K') return Math.round(n * 1e3);
  return Math.round(n);
}

// 在受控的 DOM + 全局环境里跑内容脚本，取回它挂到 globalThis 的 __beaconParse。
// 用 node:vm 而不是 new Function：vm 上下文里的 globalThis 天然指向上下文对象本身，
// 与内容脚本在页面里的实际运行方式一致（它就是靠 globalThis.xxx = 挂导出的）。
function runScript(html: string, url: string, prepare?: (doc: Document) => void) {
  const dom = new JSDOM(html, { url });
  // prepare 在跑脚本前动 DOM：给元素挂 __reactFiber$/__vue__ 这类框架内部字段——
  // 它们不是属性、只能用代码挂，而「行内一个链接都没有、数据全在组件实例里」的后台就是这么长的。
  prepare?.(dom.window.document as unknown as Document);
  const context = vm.createContext({
    location: dom.window.location,
    document: dom.window.document,
    URL: dom.window.URL,
    console, // 内容脚本在浏览器里恒有 console；vm 上下文默认没有，不给会在告警分支里抛 ReferenceError
    __beaconParseCount: parseCount,
  });
  vm.runInContext(SRC, context);
  return {
    dom,
    parse: context.__beaconParse as () => { platform: string; handle: string; posts: unknown[] } | null,
    diagnose: context.__beaconSelfDiagnose as () => {
      ok: boolean; reason?: string; hint?: string; collected?: number;
      headers?: string[]; rows?: number;
      evidence?: { idish: string[] };
    },
    autoRoutes: context.__beaconAutoRoutes as (href?: string) => string[] | null,
    noRoutesInfo: context.__beaconAutoNoRoutesInfo as () => { needLogin: boolean; reason: string } | null,
    selfOnly: context.__beaconSelfOnly as boolean,
    backend: context.__beaconSelfBackend as string | null,
  };
}

const table = (headers: string[], rows: string[]) => `
  <table>
    <thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table>`;

describe('合规开关 · 自有后台一律不参与「访问即采」', () => {
  it('脚本一加载就置 __beaconSelfOnly', () => {
    const { selfOnly } = runScript('<html><body></body></html>', 'https://creator.douyin.com/creator-micro/data');
    expect(selfOnly).toBe(true);
  });
});

describe('抖音创作者后台', () => {
  const url = 'https://creator.douyin.com/creator-micro/content/manage';
  const html = table(
    ['作品', '播放量', '点赞量', '评论量', '分享量', '完播率'],
    [
      `<tr>
        <td class="title"><a href="https://www.douyin.com/video/7065264218437717285">我的第一条视频</a></td>
        <td>7.3万</td><td>4100</td><td>260</td><td>880</td><td>47.0%</td>
      </tr>`,
    ],
  );

  it('抠出 aweme_id，与 parse-url 同口径', () => {
    const { parse } = runScript(html, url);
    const r = parse()!;
    expect(r.platform).toBe('douyin');
    const post = r.posts[0] as { platformItemId: string };
    expect(post.platformItemId).toBe('7065264218437717285');
    // 与手动登记链接解析出的 ID 必须一致，否则同一条作品会变成两条记录
    const viaUrl = parsePublishUrl('https://www.douyin.com/video/7065264218437717285');
    expect(viaUrl.ok && viaUrl.platformItemId).toBe(post.platformItemId);
  });

  it('中文列名对齐 + 万单位换算 + 完播率按率解析', () => {
    const { parse } = runScript(html, url);
    const post = parse()!.posts[0] as { metrics: Record<string, number> };
    expect(post.metrics).toMatchObject({ views: 73000, likes: 4100, comments: 260, shares: 880 });
    expect(post.metrics.completion).toBe(0.47); // 🔒 不是 0，也不是 47
  });

  it('产物能直接通过后端 zod（口径闭环）', () => {
    const { parse } = runScript(html, url);
    const r = ownPostIngestSchema.safeParse(parse());
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.posts[0].metrics?.completion).toBe(0.47);
  });
});

describe('微信公众号后台 · URL 即 ID（与 parseWechat 同口径）', () => {
  const url = 'https://mp.weixin.qq.com/cgi-bin/appmsganalysis?action=all';

  it('/s/<token> 形态', () => {
    const html = table(
      ['标题', '阅读量', '分享量', '阅读完成率'],
      [
        `<tr><td class="title"><a href="https://mp.weixin.qq.com/s/AbCdEf123456_xyz">深度长文</a></td>
         <td>1.84万</td><td>210</td><td>38.5%</td></tr>`,
      ],
    );
    const post = runScript(html, url).parse()!.posts[0] as { platformItemId: string; metrics: Record<string, number> };
    expect(post.platformItemId).toBe('https://mp.weixin.qq.com/s/AbCdEf123456_xyz');
    expect(post.metrics).toMatchObject({ views: 18400, shares: 210, completion: 0.385 });
    const viaUrl = parsePublishUrl('https://mp.weixin.qq.com/s/AbCdEf123456_xyz');
    expect(viaUrl.ok && viaUrl.platformItemId).toBe(post.platformItemId);
  });

  it('__biz 四件套形态：追踪参数被丢弃，规范化结果与 parse-url 逐字符相同', () => {
    const raw = 'https://mp.weixin.qq.com/s?__biz=MzA5MTUzOTQ5MQ==&mid=2650123456&idx=1&sn=abc123def456&chksm=xyz&scene=27';
    const html = table(['标题', '阅读量'], [`<tr><td><a href="${raw}">四件套</a></td><td>800</td></tr>`]);
    const post = runScript(html, url).parse()!.posts[0] as { platformItemId: string };
    const viaUrl = parsePublishUrl(raw);
    expect(viaUrl.ok && viaUrl.platformItemId).toBe(post.platformItemId);
  });

  it('相对路径链接 /s/<token> 与 /s?__biz=... 形态', () => {
    const html1 = table(
      ['标题', '阅读量'],
      [`<tr><td class="title"><a href="/s/AbCdEf123456_xyz">相对路径文章</a></td><td>1.2万</td></tr>`],
    );
    const post1 = runScript(html1, url).parse()!.posts[0] as { platformItemId: string };
    expect(post1.platformItemId).toBe('https://mp.weixin.qq.com/s/AbCdEf123456_xyz');

    const rawRel = '/s?__biz=MzA5MTUzOTQ5MQ==&mid=2650123456&idx=1&sn=abc123def456';
    const html2 = table(['标题', '阅读量'], [`<tr><td><a href="${rawRel}">相对路径四件套</a></td><td>800</td></tr>`]);
    const post2 = runScript(html2, url).parse()!.posts[0] as { platformItemId: string };
    expect(post2.platformItemId).toBe('https://mp.weixin.qq.com/s?__biz=MzA5MTUzOTQ5MQ==&mid=2650123456&idx=1&sn=abc123def456');
  });

  it('无 <a> 标签时，从 data-appmsgid / data-sn / data-biz 等 dataset 属性中提取 ID', () => {
    const html = table(
      ['标题', '阅读量'],
      [
        `<tr data-appmsgid="2650123456" data-sn="abc123def456" data-biz="MzA5MTUzOTQ5MQ==" data-idx="1">
           <td class="title"><span>无a标签的标题</span></td><td>1500</td>
         </tr>`,
      ],
    );
    const post = runScript(html, url).parse()!.posts[0] as { platformItemId: string };
    expect(post.platformItemId).toBe('https://mp.weixin.qq.com/s?__biz=MzA5MTUzOTQ5MQ==&mid=2650123456&idx=1&sn=abc123def456');
  });

  it('缺 sn 的四件套定位不到唯一文章 → 跳过该行而不是硬凑', () => {
    const html = table(
      ['标题', '阅读量'],
      [`<tr><td><a href="https://mp.weixin.qq.com/s?__biz=MzA5&mid=265&idx=1">缺sn</a></td><td>800</td></tr>`],
    );
    expect(runScript(html, url).parse()).toBeNull();
  });

  it('只在 /cgi-bin 后台跑，不在 /s 文章正文页跑（读者视角，与自有数据无关）', () => {
    const html = table(['标题', '阅读量'], [`<tr><td><a href="https://mp.weixin.qq.com/s/AbCdEf123456_xyz">x</a></td><td>1</td></tr>`]);
    expect(runScript(html, 'https://mp.weixin.qq.com/s/AbCdEf123456_xyz').parse()).toBeNull();
  });

  // 真实后台复现：公众号「近期发表」同一行同时有 点赞率 / 在看率 / 留言率。
  // 表头匹配第二轮是**子串**匹配，「点赞率」.includes(「点赞」) 为真 ——
  // 修复前 4.76% 会被当成点赞数存成 4、「留言率」同理污染评论数。
  // 率型与计数必须互斥匹配：率型列一律不得充当计数来源。
  it('🔒 率型列不得被当成计数：点赞率/留言率/在看率 不许污染 likes/comments', () => {
    const html = table(
      ['标题', '点赞率', '留言率', '在看率'],
      [
        `<tr><td><a href="https://mp.weixin.qq.com/s/AbCdEf123456_xyz">只有率没有计数</a></td>
         <td>4.76%</td><td>0.82%</td><td>2.38%</td></tr>`,
      ],
    );
    // 这一行本来就没有任何计数列 → 一个指标都不该采到 → 整行被跳过（第 450 行「不建空记录污染基线」），
    // 于是没有任何 post。这正是期望结果：宁可什么都不采，也不能把 4.76% 当成 4 个赞存进去。
    expect(runScript(html, url).parse()).toBeNull();
  });

  it('🔒 计数与率型并存时各归各位：点赞量取计数列，不被点赞率串台', () => {
    const html = table(
      ['标题', '阅读量', '点赞量', '点赞率', '阅读完成率'],
      [
        `<tr><td><a href="https://mp.weixin.qq.com/s/AbCdEf123456_xyz">正常行</a></td>
         <td>1.2万</td><td>571</td><td>4.76%</td><td>38.5%</td></tr>`,
      ],
    );
    const post = runScript(html, url).parse()!.posts[0] as { metrics: Record<string, number> };
    expect(post.metrics).toMatchObject({ views: 12000, likes: 571, completion: 0.385 });
  });

  it('🔒 行文本兜底同样不许把「播放完成率42.3%」读成播放量 42', () => {
    // 无表头 → 走整行文本邻接匹配，这是另一条独立的污染路径
    const html = `<table><tbody>
      <tr><td><a href="https://mp.weixin.qq.com/s/AbCdEf123456_xyz">无表头行</a></td>
      <td>播放完成率42.3%</td></tr>
    </tbody></table>`;
    const post = runScript(html, url).parse()!.posts[0] as { metrics: Record<string, number> };
    expect(post.metrics.views).toBeUndefined();
  });
});

// 插件 idOf 的覆盖面必须与 parse-url.ts 一致：少认一种形态 = 该类作品在后台永远回填不了，
// 而用户只看到「回填 0 条」，没有任何线索说明为什么。
describe('🔒 idOf 覆盖面与 parse-url 对齐（此前会静默漏采）', () => {
  it('抖音图文 /note/：与 parse-url 同口径，不再被跳过', () => {
    const html = table(
      ['标题', '播放量'],
      [`<tr><td><a href="https://www.douyin.com/note/7065264218437717285">图文</a></td><td>1200</td></tr>`],
    );
    const post = runScript(html, 'https://creator.douyin.com/creator-micro/content/manage')
      .parse()!.posts[0] as { platformItemId: string };
    expect(post.platformItemId).toBe('7065264218437717285');
    const viaUrl = parsePublishUrl('https://www.douyin.com/note/7065264218437717285');
    expect(viaUrl.ok && viaUrl.platformItemId).toBe(post.platformItemId);
  });

  it('抖音图集 /slides/ 同样能认出', () => {
    const html = table(
      ['标题', '播放量'],
      [`<tr><td><a href="https://www.douyin.com/slides/7065264218437717285">图集</a></td><td>900</td></tr>`],
    );
    const post = runScript(html, 'https://creator.douyin.com/creator-micro/content/manage')
      .parse()!.posts[0] as { platformItemId: string };
    expect(post.platformItemId).toBe('7065264218437717285');
  });

  it('小红书 /user/profile/<uid>/<noteId>：取第 4 段的 noteId，不能误取 uid', () => {
    const uid = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const noteId = '65a1b2c3000000001e03a1b2';
    const html = table(
      ['标题', '阅读量'],
      [`<tr><td><a href="https://www.xiaohongshu.com/user/profile/${uid}/${noteId}">笔记</a></td><td>500</td></tr>`],
    );
    const post = runScript(html, 'https://creator.xiaohongshu.com/publish/publish')
      .parse()!.posts[0] as { platformItemId: string };
    expect(post.platformItemId).toBe(noteId); // 不是 uid
    const viaUrl = parsePublishUrl(`https://www.xiaohongshu.com/user/profile/${uid}/${noteId}`);
    expect(viaUrl.ok && viaUrl.platformItemId).toBe(post.platformItemId);
  });

  it('一行里先出现噪音链接时，取第一个真能抠出 ID 的链接（不因首个匹配失败而丢整行）', () => {
    const noteId = '65a1b2c3000000001e03a1b2';
    const html = table(
      ['标题', '阅读量'],
      [
        `<tr><td>
           <a href="https://www.xiaohongshu.com/user/profile/aaaaaaaaaaaaaaaaaaaaaaaa">作者主页</a>
           <a href="https://www.xiaohongshu.com/explore/${noteId}">笔记</a>
         </td><td>500</td></tr>`,
      ],
    );
    const post = runScript(html, 'https://creator.xiaohongshu.com/publish/publish')
      .parse()!.posts[0] as { platformItemId: string };
    expect(post.platformItemId).toBe(noteId);
  });
});

describe('小红书 / B站 / 视频号 后台', () => {
  it('小红书：24 位 note_id', () => {
    const html = table(
      ['笔记', '观看量', '点赞量', '收藏量'],
      [`<tr><td><a href="/explore/65a1b2c3000000001e03a1b2">春季穿搭</a></td><td>8500</td><td>620</td><td>230</td></tr>`],
    );
    const r = runScript(html, 'https://creator.xiaohongshu.com/creator/notemanage').parse()!;
    expect(r.platform).toBe('xiaohongshu');
    expect((r.posts[0] as { platformItemId: string }).platformItemId).toBe('65a1b2c3000000001e03a1b2');
  });

  it('B站：bvid + 弹幕/投币这类平台特有指标', () => {
    const html = table(
      ['稿件', '播放量', '弹幕量', '投币量', '完播率'],
      [`<tr><td><a href="https://www.bilibili.com/video/BV1xx411c7mD">测试稿件</a></td><td>5.2万</td><td>310</td><td>900</td><td>0.62</td></tr>`],
    );
    const post = runScript(html, 'https://member.bilibili.com/platform/upload-manager/article').parse()!.posts[0] as {
      platformItemId: string;
      metrics: Record<string, number>;
    };
    expect(post.platformItemId).toBe('BV1xx411c7mD');
    expect(post.metrics).toMatchObject({ views: 52000, danmaku: 310, coins: 900, completion: 0.62 });
  });

  it('视频号：eid（与 parseShipinhao 同口径）', () => {
    const html = table(
      ['作品', '播放量', '转发量'],
      [`<tr><td><a href="/platform/post/detail?objectId=Ab1_Cd2-Ef3gH4iJ5kL6">测试作品</a></td><td>5.2万</td><td>900</td></tr>`],
    );
    const post = runScript(html, 'https://channels.weixin.qq.com/platform/post/list').parse()!.posts[0] as {
      platformItemId: string;
    };
    expect(post.platformItemId).toBe('Ab1_Cd2-Ef3gH4iJ5kL6');
    const viaUrl = parsePublishUrl('https://channels.weixin.qq.com/web/pages/feed?eid=Ab1_Cd2-Ef3gH4iJ5kL6');
    expect(viaUrl.ok && viaUrl.platformItemId).toBe(post.platformItemId);
  });
});

describe('认不出就跳过 · 绝不猜', () => {
  const url = 'https://creator.douyin.com/creator-micro/content/manage';

  it('行里没有可识别的作品链接 → 跳过（不拿标题当 ID）', () => {
    const html = table(['作品', '播放量'], [`<tr><td>没有链接的一行</td><td>1000</td></tr>`]);
    expect(runScript(html, url).parse()).toBeNull();
  });

  it('一个指标都没抓到 → 跳过（不建空记录污染基线）', () => {
    const html = table(
      ['作品', '备注'],
      [`<tr><td><a href="https://www.douyin.com/video/7065264218437717285">标题</a></td><td>无数据</td></tr>`],
    );
    expect(runScript(html, url).parse()).toBeNull();
  });

  it('同一作品出现多行 → 去重只留一条', () => {
    const row = `<tr><td><a href="https://www.douyin.com/video/7065264218437717285">t</a></td><td>1000</td></tr>`;
    const html = table(['作品', '播放量'], [row, row]);
    expect(runScript(html, url).parse()!.posts).toHaveLength(1);
  });

  it('非受支持域名 → 直接不解析', () => {
    const html = table(['作品', '播放量'], [`<tr><td><a href="/video/7065264218437717285">t</a></td><td>1000</td></tr>`]);
    expect(runScript(html, 'https://example.com/whatever').parse()).toBeNull();
  });
});

// common.js 的兜底解析器是给**竞对公开页**写的：认不出域名时默认 platform='bilibili'，
// 并按 URL 路径瞎凑一个 platformItemId。它一旦在自有后台上生效，mp.weixin.qq.com 的公众号数据
// 会被报成 B站。所以自有后台必须**禁用兜底**——解析不出就如实报错让用户刷新重试。
describe('🔒 自有后台禁用竞对兜底解析', () => {
  const COMMON = readFileSync(resolve(process.cwd(), 'extension/content/common.js'), 'utf8');

  it('兜底解析器确实会把未知域名认成 bilibili（这就是不能用它的原因）', () => {
    // 锁住前提：这个断言一旦变红，说明兜底行为改了，下面那条守卫的必要性要重新评估
    expect(COMMON).toContain("let platform = 'bilibili';");
  });

  // 直接跑 beaconRunCollect —— 验**行为**而不是源码里的某个字面量。
  //
  // 老版本这条断言写的是「守卫分支里必须出现 `return undefined`」。那是实现细节：
  // 2026-07-29 给采集加翻页（异步）时，这个分支从 `sendResponse(...); return undefined`
  // 改成了 `return { ok, payload }`，行为一点没变，测试却红了——字面量断言挡不住真问题，
  // 却会在无关重构时误报。改成真的调一次，看它到底会不会掉进兜底解析。
  function runCollect(url: string, opts: { selfOnly: boolean; parse: () => unknown }) {
    const dom = new JSDOM('<html><body><div>后台页</div></body></html>', { url });
    const ctx = vm.createContext({
      document: dom.window.document,
      location: dom.window.location,
      window: dom.window,
      URL: dom.window.URL,
      URLSearchParams: dom.window.URLSearchParams,
      console,
      setTimeout,
      chrome: {
        runtime: { onMessage: { addListener: () => {} }, sendMessage: () => Promise.resolve({}) },
        storage: { sync: { get: () => Promise.resolve({}) } },
      },
    });
    vm.runInContext(COMMON, ctx);
    ctx.__beaconSelfOnly = opts.selfOnly;
    ctx.__beaconParse = opts.parse;
    return (ctx.beaconRunCollect as (deep: boolean) => Promise<{ ok: boolean; error?: string; payload?: { platform?: string } }>)(false);
  }

  it('__beaconSelfOnly 下解析失败 → 如实报错，绝不掉进兜底（那会把公众号数据报成 B站）', async () => {
    const r = await runCollect('https://mp.weixin.qq.com/cgi-bin/home', { selfOnly: true, parse: () => null });
    expect(r.ok).toBe(false);
    expect(r.payload).toBeUndefined();
    expect(r.error).toContain('没读到数据');
  });

  it('对照组：公开竞对页解析失败时**会**走兜底（说明上面那条守卫真的在起作用）', async () => {
    const r = await runCollect('https://www.douyin.com/user/MS4wLjABAAAAdemo', { selfOnly: false, parse: () => null });
    expect(r.ok).toBe(true);
    expect(r.payload?.platform).toBe('douyin');
  });

  it('守卫在源码里必须排在兜底调用之前（顺序反了就等于没守卫）', () => {
    const body = COMMON.slice(COMMON.indexOf('async function beaconRunCollect'));
    const guardAt = body.indexOf('__beaconSelfOnly');
    // 兜底的结果如今要与站点解析器的 profile 合并（否则粉丝数会连同解析结果一起被扔掉，
    // 见 tests/ingest/self-followers.test.ts）——这里只关心它在源码里的**位置**
    const fallbackAt = body.indexOf('beaconFallbackParse()');
    expect(guardAt).toBeGreaterThan(-1);
    expect(fallbackAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(fallbackAt);
  });
});

// 曝光量与流量来源分布只有后台给得到，是 CTR（YouTube 第一信号）与「搜索流量占比」
// （小红书，此前文案里明写「无法从播放数看出」）唯一的数据来源。
describe('曝光量 / 流量来源分布', () => {
  it('曝光量单独成键，绝不并进 views（并进去会拔高分母、压低所有互动率）', () => {
    const html = table(
      ['作品', '曝光量', '播放量'],
      [`<tr><td><a href="https://www.douyin.com/video/7065264218437717285">t</a></td><td>10万</td><td>2.5万</td></tr>`],
    );
    const m = (runScript(html, 'https://creator.douyin.com/x').parse()!.posts[0] as { metrics: Record<string, number> })
      .metrics;
    expect(m.impressions).toBe(100000);
    expect(m.views).toBe(25000); // 没被曝光量污染
  });

  it('曝光 + 播放 → 后端能算出 CTR', async () => {
    const { clickThroughRate } = await import('@/lib/json');
    expect(clickThroughRate({ impressions: 100000, views: 25000 })).toBe(0.25);
    // 缺任一项返回 null，绝不用估算值冒充
    expect(clickThroughRate({ views: 25000 })).toBeNull();
    expect(clickThroughRate({ impressions: 100000 })).toBeNull();
  });

  it('流量来源分布：认出「流量来源」块并读出各来源占比', () => {
    const html = `
      <div class="panel">流量来源分布 推荐 62.0% 搜索 21.5% 关注 10.0% 其他 6.5%</div>
      ${table(['笔记', '观看量'], [`<tr><td><a href="/explore/65a1b2c3000000001e03a1b2">t</a></td><td>8500</td></tr>`])}`;
    const m = (runScript(html, 'https://creator.xiaohongshu.com/x').parse()!.posts[0] as {
      metrics: { sources?: Record<string, number> };
    }).metrics;
    expect(m.sources).toMatchObject({ 推荐: 0.62, 搜索: 0.215, 关注: 0.1 });
  });

  it('没有「流量来源」块时不猜 —— 不把页面上随便一个百分数当来源占比', () => {
    const html = table(
      ['笔记', '观看量', '完播率'],
      [`<tr><td><a href="/explore/65a1b2c3000000001e03a1b2">t</a></td><td>8500</td><td>47.0%</td></tr>`],
    );
    const m = (runScript(html, 'https://creator.xiaohongshu.com/x').parse()!.posts[0] as {
      metrics: { sources?: unknown; completion?: number };
    }).metrics;
    expect(m.sources).toBeUndefined();
    expect(m.completion).toBe(0.47); // 完播率照常读到，没被误当成来源占比
  });

  it('产物通过后端 zod，来源占比原样保留', () => {
    const html = `
      <div>流量来源 推荐 62.0% 搜索 21.5%</div>
      ${table(['笔记', '观看量'], [`<tr><td><a href="/explore/65a1b2c3000000001e03a1b2">t</a></td><td>8500</td></tr>`])}`;
    const r = ownPostIngestSchema.safeParse(runScript(html, 'https://creator.xiaohongshu.com/x').parse());
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.posts[0].metrics?.sources).toMatchObject({ 搜索: 0.215 });
  });
});

// 这些后台的 DOM 无法在开发环境校准，失效表现是「采到的字段变少」而不是报错。
// 自检的意义是把「断在哪一步」讲清楚，让唯一能看到真实结构的人（用户）不必读代码就能反馈。
describe('自检 · 断点定位', () => {
  const diagnose = (html: string, url: string) => {
    const dom = new JSDOM(html, { url });
    const context = vm.createContext({
      location: dom.window.location,
      document: dom.window.document,
      URL: dom.window.URL,
      console, // 内容脚本在浏览器里恒有 console；vm 上下文默认没有，不给会在告警分支里抛 ReferenceError
      __beaconParseCount: parseCount,
    });
    vm.runInContext(SRC, context);
    return (context.__beaconSelfDiagnose as () => Record<string, unknown>)();
  };
  const url = 'https://creator.douyin.com/creator-micro/content/manage';

  it('非受支持域名 → 直说不支持', () => {
    expect(diagnose('<html></html>', 'https://example.com/')).toMatchObject({ ok: false });
  });

  it('一行都没有 → 提示表格没加载完/虚拟列表', () => {
    const d = diagnose('<html><body></body></html>', url);
    expect(d.rows).toBe(0);
    expect(String(d.hint)).toContain('一行都没认出来');
  });

  it('有行但抠不出 ID → 报出行内实际出现过的属性名（补选择器的唯一依据）', () => {
    const d = diagnose(
      table(['作品', '播放量'], ['<tr data-e2e="row" data-idx="3"><td>无链接</td><td>1000</td></tr>']),
      url,
    );
    expect(d.withLink).toBe(0);
    expect(d.withId).toBe(0);
    // 旧版只采 href/data-href 等 6 个固定属性名，「页面真没链接」与「ID 就在我没看的属性里」
    // 给出同一句话——用户照着发回来也补不出选择器。现在必须把真实属性名列出来。
    expect(String(d.hint)).toContain('data-e2e');
    expect(String(d.hint)).toContain('data-idx');
  });

  it('withLink 与 withId 分开计数：靠 data-* 抠到 ID 但没有 <a> 时不能报成「有链接」', () => {
    const d = diagnose(
      table(['作品', '播放量'], ['<tr data-row-key="7065264218437717285"><td>t</td><td>1000</td></tr>']),
      url,
    );
    expect(d.withLink).toBe(0); // 一个 <a> 都没有
    expect(d.withId).toBe(1); // 但 ID 抠到了
    expect(d.via).toMatchObject({ attr: 1 });
  });

  it('有 ID 但读不到指标 → 报出实际看到的表头，用户照着补别名即可', () => {
    const d = diagnose(
      table(['作品', '奇怪的列名'], ['<tr><td><a href="https://www.douyin.com/video/7065264218437717285">t</a></td><td>1000</td></tr>']),
      url,
    );
    expect(d.withId).toBe(1);
    expect(d.withMetrics).toBe(0);
    expect(String(d.hint)).toContain('奇怪的列名');
  });

  // 🔒 hint 里**不能**只说「正常/成功 N 条」。这些后台在开发环境打不开，
  // 「采到了」和「采对了」是两个问题，而条数对不上、标题抓成状态文案、数字串到别篇上
  // 这三种故障在一句「成功解析 9 条」里长得一模一样。唯一能对着真实页面核对的人是用户，
  // 所以自检必须把采出来的东西**原样列出来**（标题/链接/时间/每个指标）。
  it('一切正常 → 把采到的标题/链接/指标原样列出来供人工核对', () => {
    const d = diagnose(
      table(['作品', '播放量'], ['<tr><td><a href="https://www.douyin.com/video/7065264218437717285">我的第一条视频</a></td><td>1000</td></tr>']),
      url,
    );
    expect(d).toMatchObject({ ok: true, platform: 'douyin', withMetrics: 1, collected: 1 });
    expect(d.sample).toBeTruthy();
    const hint = String(d.hint);
    expect(hint).toContain('我的第一条视频'); // 标题
    expect(hint).toContain('https://www.douyin.com/video/7065264218437717285'); // 链接
    expect(hint).toContain('views=1000'); // 指标的具体值
  });

  // 行原文是判断「数字读对没读对」的唯一依据：光看 views=1 说不清 1 是从哪个标签旁边读来的。
  // 但它是页面文本，只该在本地展示，没有理由跟着回传跑一趟服务器。
  it('🔒 行原文只在自检时带上，采集路径一律不带（不把页面文本发上服务器）', () => {
    const html = table(['作品', '播放量'], ['<tr><td><a href="https://www.douyin.com/video/7065264218437717285">t</a></td><td>1000</td></tr>']);
    const r = runScript(html, url);
    const forIngest = r.parse()! as { posts: Record<string, unknown>[] };
    expect(forIngest.posts[0].__evidence).toBeUndefined();
    expect(String(r.diagnose().hint)).toContain('行原文');
  });

  it('🔒 没读到发表时间要明说 —— 后端会把它填成回填当天，那是条静默错数据', () => {
    const d = diagnose(
      table(['作品', '播放量'], ['<tr><td><a href="https://www.douyin.com/video/7065264218437717285">t</a></td><td>1000</td></tr>']),
      url,
    );
    expect(String(d.hint)).toContain('回填当天');
  });
});

// 现实里有一类后台整行连一个 <a> 都没有（点击靠 onclick/JS 路由），linkSelector 再怎么补都是空的。
// 这组锁的是「没有链接时还能不能对得上号」，以及更要紧的——**认不准时必须一条都不采**。
describe('无链接后台 · 从属性抠 ID', () => {
  const dyUrl = 'https://creator.douyin.com/creator-micro/content/manage';

  it('antd 表格的 data-row-key 就是作品 ID', () => {
    const html = table(['作品', '播放量', '完播率'], [
      '<tr data-row-key="7065264218437717285"><td>标题</td><td>1.2万</td><td>42.3%</td></tr>',
    ]);
    const posts = runScript(html, dyUrl).parse()!.posts as { platformItemId: string; metrics: Record<string, number> }[];
    expect(posts).toHaveLength(1);
    expect(posts[0].platformItemId).toBe('7065264218437717285');
    expect(posts[0].metrics.views).toBe(12000);
    expect(posts[0].metrics.completion).toBe(0.423);
  });

  it('纯数字但不是 ID 的属性（时间戳/计数）一律不认', () => {
    const html = table(['作品', '播放量'], [
      '<tr data-create-time="1721880000000" data-like-count="1234567890"><td>t</td><td>1000</td></tr>',
    ]);
    expect(runScript(html, dyUrl).parse()).toBeNull();
  });

  it('小红书：24 位十六进制既像笔记 ID 也像作者 uid，属性名带 author/user 的不认', () => {
    const xhs = 'https://creator.xiaohongshu.com/statistics';
    const bad = table(['笔记', '观看量'], [
      '<tr data-author-id="65a1b2c3000000001e03a1b2"><td>t</td><td>8500</td></tr>',
    ]);
    expect(runScript(bad, xhs).parse()).toBeNull();

    const good = table(['笔记', '观看量'], [
      '<tr data-note-id="65a1b2c3000000001e03a1b2"><td>t</td><td>8500</td></tr>',
    ]);
    const posts = runScript(good, xhs).parse()!.posts as { platformItemId: string }[];
    expect(posts[0].platformItemId).toBe('65a1b2c3000000001e03a1b2');
    // 与 parse-url.ts 同口径，否则会给同一条笔记建出第二条记录
    const viaUrl = parsePublishUrl(`https://www.xiaohongshu.com/explore/${posts[0].platformItemId}`);
    expect(viaUrl.ok && viaUrl.platformItemId).toBe(posts[0].platformItemId);
  });

  it('B站：BV 号形态独特，data-bvid 直接认', () => {
    const html = table(['稿件', '播放量'], ['<tr data-bvid="BV1GJ411x7h7"><td>t</td><td>3000</td></tr>']);
    const posts = runScript(html, 'https://member.bilibili.com/platform/data-center').parse()!.posts as {
      platformItemId: string;
    }[];
    expect(posts[0].platformItemId).toBe('BV1GJ411x7h7');
  });

  it('视频号：ID 形态太宽，只认明说自己是 eid/objectId 的属性且长度够', () => {
    const sph = 'https://channels.weixin.qq.com/platform/post/list';
    const loose = table(['作品', '播放量'], ['<tr data-key="abc"><td>t</td><td>500</td></tr>']);
    expect(runScript(loose, sph).parse()).toBeNull();

    const ok = table(['作品', '播放量'], [
      '<tr data-object-id="export_UzFfAgtgekIEAQAAAAAA"><td>t</td><td>500</td></tr>',
    ]);
    const posts = runScript(ok, sph).parse()!.posts as { platformItemId: string }[];
    expect(posts[0].platformItemId).toBe('export_UzFfAgtgekIEAQAAAAAA');
  });
});

// 公众号后台的部分数据模块渲染在 iframe 里。manifest 没开 all_frames（开了会让每个 frame
// 都抢答 sendResponse，回哪个 frame 的结果不确定），改为在主 frame 里横穿同源 iframe。
describe('同源 iframe · 表格不在主文档里也要采得到', () => {
  it('表格渲染在同源 iframe 中时照样解析', () => {
    const html = '<div>外层</div><iframe id="f"></iframe>';
    const inner = table(['作品', '播放量'], [
      '<tr><td><a href="https://www.douyin.com/video/7065264218437717285">t</a></td><td>1000</td></tr>',
    ]);
    const r = runScript(html, 'https://creator.douyin.com/creator-micro/content/manage', (doc) => {
      // jsdom 不解析 srcdoc，直接往 about:blank 的 contentDocument 里写（同源，与真实后台一致）
      const f = doc.querySelector('#f') as HTMLIFrameElement;
      f.contentDocument!.body.innerHTML = inner;
    });
    const posts = r.parse()!.posts as { platformItemId: string; metrics: Record<string, number> }[];
    expect(posts).toHaveLength(1);
    expect(posts[0].platformItemId).toBe('7065264218437717285');
    expect(posts[0].metrics.views).toBe(1000);
  });
});

// 曾经这里有一组「从 React fiber / Vue 组件实例抠 ID」的测试，连同被测代码一起删了：
// 内容脚本跑在 Chrome 隔离世界，读不到页面挂在 DOM 元素上的 __reactFiber$ / __vue__
// （已对官方文档核实）。jsdom 跑在同一个世界里，所以那组测试**永远是绿的，而真机永远是死的**——
// 绿灯本身就是误导。要验框架状态只能靠 tools/backend-probe.js 在真实控制台跑。
// 见 [[beacon-extension-isolated-world]]。

// 真机 2026-07-25 第五轮，自检终于吐出现场：公众号后台首页 178 行里挤着十来个**隐藏的**
// 「素材使用位置」弹窗，全页表头收上来是 [使用位置×10 / 相关文章 / 相关内容]，
// 证据采样（只取前 40 行）采到的全是 alt=二维码 / align=left 这类噪音。
// 隐藏节点既不该被当成数据行，它们的表头更不该拿去给真正的行做列对齐。
describe('🔒 隐藏弹窗不得污染行集合与列对齐', () => {
  const url = 'https://mp.weixin.qq.com/cgi-bin/appmsganalysis?action=all';
  // 前面一张隐藏的「使用位置」表（真实形态：display:none 的弹窗），后面才是真数据表
  const hiddenDialog = `
    <div style="display: none">
      <table><thead><tr><th>使用位置</th><th>相关文章</th></tr></thead>
      <tbody><tr><td><img alt="二维码" align="left"></td><td>某素材</td></tr></tbody></table>
    </div>`;
  const real = table(
    ['标题', '阅读次数', '点赞数'],
    [`<tr><td><a href="https://mp.weixin.qq.com/s/AbCdEf123456_xyz">文章</a></td><td>1200</td><td>34</td></tr>`],
  );

  it('隐藏弹窗的表头不参与列对齐：真数据表的列必须读对', () => {
    const m = (runScript(hiddenDialog + real, url).parse()!.posts[0] as {
      metrics: Record<string, number>;
    }).metrics;
    // 若把 [使用位置,相关文章,标题,阅读次数,点赞数] 当成一张表的表头，下标全错，读到的就是别的列
    expect(m.views).toBe(1200);
    expect(m.likes).toBe(34);
  });

  it('隐藏行不计入自检的行数与表头', () => {
    const d = runScript(hiddenDialog + real, url).diagnose();
    expect(d.headers).not.toContain('使用位置');
  });

  it('jsdom 无布局信息时不做可见性过滤（否则一切都会被当成隐藏，全线失明）', () => {
    // 这一条守的是 beaconLayoutAvailable 的探测逻辑本身：
    // 纯 CSS 隐藏（非 inline style）在 jsdom 里无从判断，此时必须放行而不是全部丢弃
    const d = runScript(real, url).diagnose();
    expect(d.collected).toBe(1);
  });
});

// 真机 2026-07-25 第六轮：隐藏弹窗被过滤掉后，剩下的 13 行里露出两个更尴尬的东西——
// 一个是插件**自己注入的侧栏**（DIV.beacon-chat-input-row），
// 一个是 weui 的 I.mass__status_text_arrow ——「arrow」里含 "row"，被 [class*="row"] 捞了进来。
// 证据名额本来就只有 8 个，全被这些占了，真信号一条都不剩。
describe('🔒 行集合不得混进自己的 UI 与 arrow 这类子串误配', () => {
  const url = 'https://mp.weixin.qq.com/cgi-bin/appmsganalysis?action=all';

  it('插件自己注入的侧栏不算数据行', () => {
    const html = `<html><body>
      <div id="beacon-ai-root"><div class="beacon-chat-input-row">
        <input id="beacon-chat-input" placeholder="针对当前页面提问">
      </div></div>
      ${table(['标题', '阅读次数'], [`<tr><td><a href="https://mp.weixin.qq.com/s/AbCdEf123456_xyz">文章</a></td><td>1200</td></tr>`])}
    </body></html>`;
    const d = runScript(html, url).diagnose();
    expect(d.reason ?? d.hint ?? '').not.toContain('beacon-chat-input');
    expect(d.collected).toBe(1);
  });

  it('🔒 class 含 arrow 的元素不算行（"arrow" 里就有 "row"，CSS 没有词边界）', () => {
    const html = `<html><body>
      <i class="weui-desktop-mass__status_text_arrow">›</i>
      <i class="weui-desktop-mass__status_text_arrow">›</i>
      ${table(['标题', '阅读次数'], [`<tr><td><a href="https://mp.weixin.qq.com/s/AbCdEf123456_xyz">文章</a></td><td>1200</td></tr>`])}
    </body></html>`;
    const d = runScript(html, url).diagnose();
    expect(String(d.hint ?? d.reason ?? '')).not.toContain('arrow');
  });

  it('真正的行类名照常认：table-row / listItem / content-item 都要留下', () => {
    const html = `<html><body>
      <div class="ant-table-row">a</div><div class="listItem">b</div><div class="content-item">c</div>
    </body></html>`;
    const d = runScript(html, url).diagnose();
    expect(d.rows).toBe(3);
  });

  it('行样本要带文本：表头和属性都空时，文本是仅剩的信号', () => {
    const html = '<html><body><li class="weui-desktop-list__item">春节营销复盘 阅读 1234</li></body></html>';
    const d = runScript(html, url).diagnose();
    expect(String(d.reason ?? d.hint ?? '')).toContain('春节营销复盘');
  });
});

// 真机 2026-07-25 第七轮，用户终于站在真数据页 /cgi-bin/appmsgpublish 上，结果更糟：
// 11 行里 10 行是插件自己的侧栏，剩下 1 行是靠「arrow 含 row」误配进来的箭头图标，
// 真正的文章列表**一条都没进来**——weui 的条目类名是 weui-desktop-mass-appmsg 这一族，
// 里面既没有 row 也没有 item，通用选择器天生认不出。整页还一个 <th> 都没有（表头=[]）。
describe('🔒 公众号发表记录页 · 条目类名不含 row/item', () => {
  const url = 'https://mp.weixin.qq.com/cgi-bin/appmsgpublish?sub=list&begin=0&count=10';
  // 照抄真实形态：无表格、无表头，条目是 weui-desktop-mass-appmsg，指标以「阅读 N」形式写在文本里
  const card = (token: string, reads: number, likes: number) => `
    <div class="weui-desktop-mass-appmsg">
      <a href="https://mp.weixin.qq.com/s/${token}" class="weui-desktop-mass-appmsg__title">某篇文章</a>
      <span class="weui-desktop-mass__status_text">阅读 ${reads}</span>
      <span class="weui-desktop-mass__status_text">在看 ${likes}</span>
      <i class="weui-desktop-mass__status_text_arrow">›</i>
    </div>`;
  const page = `<html><body>${card('AbCdEf123456_xyz', 1234, 12)}${card('GhIjKl789012_abc', 5678, 34)}</body></html>`;

  it('靠 rowHints 认出条目，并从文本里读出阅读/在看', () => {
    const posts = runScript(page, url).parse()!.posts as {
      platformItemId: string; metrics: Record<string, number>;
    }[];
    expect(posts).toHaveLength(2);
    expect(posts[0].platformItemId).toBe('https://mp.weixin.qq.com/s/AbCdEf123456_xyz');
    expect(posts[0].metrics.views).toBe(1234); // 裸别名「阅读」——这一页没有表头可对齐
    expect(posts[0].metrics.likes).toBe(12); // 「在看」
  });

  it('🔒 就算类名 hint 全不命中，也要靠结构兜底认出来（不赌类名）', () => {
    // 把类名换成完全陌生的一套：hint 一个都不中，只能靠「重复 ≥3 次且含 ≥2 个数字」
    const alien = (t: string, r: number) => `
      <div class="xyzcard"><a href="https://mp.weixin.qq.com/s/${t}">文章</a>
        <span>阅读 ${r}</span><span>在看 7</span></div>`;
    const html = `<html><body><section>
      ${alien('AbCdEf123456_xyz', 11)}${alien('GhIjKl789012_abc', 22)}${alien('MnOpQr345678_def', 33)}
    </section></body></html>`;
    const posts = runScript(html, url).parse()!.posts as { platformItemId: string }[];
    expect(posts).toHaveLength(3);
    expect(posts[0].platformItemId).toBe('https://mp.weixin.qq.com/s/AbCdEf123456_xyz');
  });

  it('🔒 裸别名「阅读」不许被「阅读原文人数」擦边命中', () => {
    const html = `<html><body>
      <div class="weui-desktop-mass-appmsg">
        <a href="https://mp.weixin.qq.com/s/AbCdEf123456_xyz">文章</a>
        <span>阅读原文人数 9</span><span>在看 3</span>
      </div></body></html>`;
    const r = runScript(html, url).parse();
    // ⚠️ 先锚「确实解析出了这一条」。没有这个锚的话，parse() 返回 null、posts 为空、
    //    或这条根本没有 metrics —— 三种「解析器整个坏了」的情况全都会让下面那句判绿。
    //    同文件其它同类用例（:765、:1119）都有这个锚，这条此前漏了。
    expect(r?.posts, '解析器没产出这一条，下面那句断言就失去意义了').toHaveLength(1);
    const m = (r!.posts[0] as { metrics?: Record<string, number> }).metrics;
    expect(m?.views).toBeUndefined(); // 9 是点原文的人数，不是阅读量
  });
});

// 真机 2026-07-27 抓到的最要命的一类错：**不是漏采，是采回来一整套自洽的假数字**。
//
// 公众号后台的统计卡片是「数字在上、标签在下」，拼成文本就是
//   2阅读人数1点赞人数0分享人数1推荐人数0留言条数
// 而解析器按「标签+紧随数字」读，每个指标读到的都是**下一个**指标的值 —— 整排错位一格：
//   阅读读成 1（其实是点赞人数）、点赞读成 0（其实是分享人数）、分享读成 1（其实是推荐人数）。
// 错位后的数字个个都过得了形态校验，看着完全正常。唯一能证伪它的是页面自己给的比率：
//   点赞率 = 点赞人数 ÷ 阅读人数。下面三条的比率都是从真机原文里原样抄来的。
describe('🔒 数字在前、标签在后 · 错位一格会采回一整套自洽的假数字', () => {
  const url = 'https://mp.weixin.qq.com/cgi-bin/home?t=home%2Findex&token=1#tab=sent-panel';
  // 照抄真机行原文的关键片段（前后噪音一并保留，那才是真实输入）
  const card = (token: string, title: string, stats: string, rates: string) => `
    <div class="appmsg-card">
      07月20日已发表已开启通知，内容已在公众号列表和公众号主页展示已通知13人失败0人通知范围全部用户
      <a href="https://mp.weixin.qq.com/s/${token}" class="appmsg__title">${title}</a>
      <span>原创</span>
      <span>${stats}</span>
      <span>${rates}</span>
      长文转图片发表数据恢复后用户将正常访问此页面
    </div>`;

  const parse = (stats: string, rates: string) => {
    const html = `<html><body>${card('AbCdEf123456_xyz', 'AI日报', stats, rates)}</body></html>`;
    return (runScript(html, url).parse()!.posts[0] as { metrics: Record<string, number> }).metrics;
  };

  // [真机行原文片段, 点赞率, 期望阅读, 期望点赞, 期望分享]
  const REAL: [string, string, number, number, number][] = [
    ['2阅读人数1点赞人数0分享人数1推荐人数0留言条数', '点赞率50.00%', 2, 1, 0],
    ['106阅读人数1点赞人数2分享人数1推荐人数0留言条数', '点赞率0.94%', 106, 1, 2],
    ['42阅读人数2点赞人数2分享人数1推荐人数0留言条数', '点赞率4.76%', 42, 2, 2],
  ];

  for (const [stats, rates, views, likes, shares] of REAL) {
    it(`「${stats.slice(0, 14)}…」→ 阅读${views} 点赞${likes} 分享${shares}（${rates} 自校验）`, () => {
      const m = parse(stats, rates);
      expect(m.views).toBe(views);
      expect(m.likes).toBe(likes);
      expect(m.shares).toBe(shares);
      // 🔒 用页面自己给的点赞率反算：对不上就说明又错位了
      const pct = Number(rates.replace(/[^\d.]/g, ''));
      expect(Math.abs((m.likes / m.views) * 100 - pct)).toBeLessThan(0.01);
    });
  }

  it('🔒 点赞率不得被当成点赞数（率型在这一页是标签在前，与计数方向相反）', () => {
    const m = parse('2阅读人数1点赞人数0分享人数', '点赞率50.00%在看率50.00%留言率-');
    expect(m.likes).toBe(1);
    expect(m.likes).not.toBe(50);
  });

  // 真机 2026-07-27 用户粘回来的**完整行原文**，一个字都没删。
  // 这三条是这套解析器唯一一份真实输入样本 —— 构造出来的 fixture 会漏掉真实页面的噪音
  // （通知状态、tooltip 图例、「9月11日零点关闭」这种干扰日期、末尾的率型字段…），
  // 而我第一版方向探测器正是被「…0留言条数0划线人数…」这个尾巴判反的。
  describe('真机完整行原文（未删改）', () => {
    const RAW: [string, string, number, number, number, number][] = [
      ['07月20日已发表已开启通知，内容已在公众号列表和公众号主页展示已通知13人失败0人通知范围全部用户查看历史版本替换详情使用位置暂无数据知道了AI日报7.20｜KimiK3引爆芯片熊市，Fireworks估值175亿，开放权重重塑格局原创2阅读人数1点赞人数0分享人数1推荐人数0留言条数0划线人数投票人数0被转载次数点赞率50.00%在看率50.00%留言率-长文转图片发表数据恢复后用户将正常访问此页面，确定恢复？该入口为恢复故障数据的临时入口，将在9月11日零点关闭。确定取消还可以修改3次置顶仅自己可见删除关闭推荐复制链接添加合集声明创作来源违规检测数据统计数据统计暂无法获取当天发文的数据2总阅读人数阅读后关注人数总分享次数分享产生的阅读数50.00%点赞率0%留言率分享率总分享次数/阅读人数，此处分享率偏高分享阅读率分享产生的阅读次数/总分享次数送达阅读率公众号消息的阅读次数/消息群发', '2026-07-20', 2, 1, 0, 0],
      ['07月19日已发表已开启通知，内容已在公众号列表和公众号主页展示已通知10人失败0人通知范围全部用户查看历史版本替换详情使用位置暂无数据知道了AI日报7.19｜KimiK3引爆芯片股跌，融资转向推理芯片，开放模型加速商品化106阅读人数1点赞人数2分享人数1推荐人数0留言条数0划线人数投票人数被转载次数点赞率0.94%在看率0.94%留言率-长文转图片发表数据恢复后用户将正常访问此页面，确定恢复？该入口为恢复故障数据的临时入口，将在9月11日零点关闭。确定取消还可以修改3次置顶仅自己可见删除关闭推荐复制链接添加合集声明创作来源违规检测数据统计数据统计暂无法获取当天发文的数据106总阅读人数阅读后关注人数总分享次数分享产生的阅读数0.94%点赞率0%留言率分享率总分享次数/阅读人数，此处分享率偏高分享阅读率分享产生的阅读次数/总分享次数送达阅读率公众号消息的阅读次数/消息群发送达的人数阅读完', '2026-07-19', 106, 1, 2, 0],
      ['07月18日已发表已开启通知，内容已在公众号列表和公众号主页展示已通知9人失败0人通知范围全部用户查看历史版本替换详情使用位置暂无数据知道了AI日报7.18｜KimiK3超越欧美，代理治理成焦点，开源多极竞赛原创42阅读人数2点赞人数2分享人数1推荐人数0留言条数0划线人数投票人数0被转载次数点赞率4.76%在看率2.38%留言率-长文转图片发表数据恢复后用户将正常访问此页面，确定恢复？该入口为恢复故障数据的临时入口，将在9月11日零点关闭。确定取消还可以修改3次置顶仅自己可见删除关闭推荐复制链接添加合集声明创作来源违规检测数据统计数据统计暂无法获取当天发文的数据42总阅读人数阅读后关注人数总分享次数分享产生的阅读数4.76%点赞率0%留言率分享率总分享次数/阅读人数，此处分享率偏高分享阅读率分享产生的阅读次数/总分享次数送达阅读率公众号消息的阅读次数/消息群发送达的人数阅读完成率阅读完成', '2026-07-18', 42, 2, 2, 0],
    ];

    for (const [raw, date, views, likes, shares, comments] of RAW) {
      it(`${date} → 阅读${views} 点赞${likes} 分享${shares} 留言${comments}`, () => {
        const html = `<html><body><div class="appmsg-card">
          <a href="https://mp.weixin.qq.com/s/AbCdEf123456_xyz" class="appmsg__title">AI日报</a>${raw}
        </div></body></html>`;
        const p = runScript(html, url).parse()!.posts[0] as {
          metrics: Record<string, number>; publishedAt?: string;
        };
        expect(p.metrics.views).toBe(views);
        expect(p.metrics.likes).toBe(likes);
        expect(p.metrics.shares).toBe(shares);
        expect(p.metrics.comments).toBe(comments);
        // 发表时间取行首的「07月20日」，不能被文案里的「9月11日零点关闭」带走
        expect(p.publishedAt?.slice(0, 10)).toBe(date);
      });
    }

    it('🔒 「点赞率50.00%」这类率型不得混进计数（同一行里两种排布方向并存）', () => {
      const html = `<html><body><div class="appmsg-card">
        <a href="https://mp.weixin.qq.com/s/AbCdEf123456_xyz">t</a>${RAW[0][0]}
      </div></body></html>`;
      const m = (runScript(html, url).parse()!.posts[0] as { metrics: Record<string, number> }).metrics;
      for (const v of Object.values(m)) expect(v).not.toBe(50);
    });
  });

  it('🔒 标签在前的页面不受影响（方向逐个标签投票，不是全局开关）', () => {
    const html = `<html><body><div class="appmsg-card">
      <a href="https://mp.weixin.qq.com/s/AbCdEf123456_xyz">文章</a>
      <span>阅读 1234</span><span>在看 56</span>
    </div></body></html>`;
    const m = (runScript(html, url).parse()!.posts[0] as { metrics: Record<string, number> }).metrics;
    expect(m.views).toBe(1234);
    expect(m.likes).toBe(56);
  });
});

// 「用户分析」页的四张指标卡是同一种排布，错位后 净增人数 会读成 累计人数 的值——
// 12800 这种数看着完全正常，比作品指标更难发现。
describe('🔒 粉丝数据 · 同一个错位坑', () => {
  const url = 'https://mp.weixin.qq.com/cgi-bin/useranalysis';
  const stats = (n: number, c: number, d: number, t: number) =>
    `<html><body><div>${n}新增人数${c}取消关注人数${d}净增人数${t}累计人数</div></body></html>`;

  it('数字在前：累计人数取 12800，净增人数取 275', () => {
    const r = runScript(stats(320, 45, 275, 12800), url).parse() as unknown as {
      dailyStats: { followers: number; followerDelta: number }[];
    };
    expect(r.dailyStats[0].followers).toBe(12800);
    expect(r.dailyStats[0].followerDelta).toBe(275);
  });

  it('🔒 标签在前的老形态照常工作（既有真机形态不能回归）', () => {
    const html = '<html><body><div>新增人数 320</div><div>取消关注人数 45</div><div>净增人数 275</div><div>累计人数 12800</div></body></html>';
    const r = runScript(html, url).parse() as unknown as {
      dailyStats: { followers: number; followerDelta: number }[];
    };
    expect(r.dailyStats[0].followers).toBe(12800);
    expect(r.dailyStats[0].followerDelta).toBe(275);
  });
});

// 真机 2026-07-27，公众号后台首页「已发表」面板：153 行里 45 行抠出了 ID，去重后只剩 9 篇——
// 平均每篇文章有 **5 个嵌套层级**都被认成了「行」。它们 ID 相同、文本范围却天差地别。
// 旧规则「同一 ID 取指标最全的那一层」在嵌套结构里恰恰选中**最外层**（层越大文本越多、
// 蹭到的标签越多），于是采到的是「这篇文章周围所有的数字」。
// 真机症状：views=1 likes=2 —— 在看比阅读还多，物理上不可能。
describe('🔒 同一篇文章的多层嵌套 · 逐个指标各取最小作用域', () => {
  const url = 'https://mp.weixin.qq.com/cgi-bin/appmsgpublish?sub=list';
  // 照抄真机形态：外层裹着与本文无关的数字，内层卡片才是这篇文章自己的数据
  const nested = `<html><body>
    <div class="appmsg-outer">
      <span>阅读 1</span><span>分享 1</span>
      <div class="appmsg-card">
        <a href="https://mp.weixin.qq.com/s/AbCdEf123456_xyz" class="appmsg__title">春节营销复盘</a>
        <span>阅读 1234</span><span>在看 56</span>
      </div>
    </div></body></html>`;

  it('🔒 阅读数取卡片层的 1234，不取外层蹭到的 1', () => {
    const posts = runScript(nested, url).parse()!.posts as { metrics: Record<string, number> }[];
    expect(posts).toHaveLength(1);
    // 修复前：外层有 views+shares+likes 三个键、卡片只有两个 → 外层胜出 → views=1
    expect(posts[0].metrics.views).toBe(1234);
    expect(posts[0].metrics.likes).toBe(56);
  });

  it('只有外层才写的字段照样收下（不是「一律取最内层」）', () => {
    const posts = runScript(nested, url).parse()!.posts as { metrics: Record<string, number> }[];
    expect(posts[0].metrics.shares).toBe(1);
  });

  it('🔒 在看不得多于阅读 —— 这是「数字串了层」最直接的体检', () => {
    const posts = runScript(nested, url).parse()!.posts as { metrics: Record<string, number> }[];
    expect(posts[0].metrics.likes).toBeLessThanOrEqual(posts[0].metrics.views);
  });

  it('标题仍取产出 ID 的那个链接，不因作用域更小就改用内层猜出来的', () => {
    const posts = runScript(nested, url).parse()!.posts as { title: string }[];
    expect(posts[0].title).toBe('春节营销复盘');
  });
});

// 真机 2026-07-27 采到的标题末尾粘着「原创」——那是公众号的原创声明角标，
// 在 DOM 里紧挨标题，textContent 一取就带出来。存进库会跟用户手动登记的标题对不上。
describe('🔒 标题不得粘着平台角标', () => {
  const url = 'https://mp.weixin.qq.com/cgi-bin/appmsgpublish?sub=list';
  const withBadge = (t: string) => `<html><body>
    <div class="appmsg-card">
      <a href="https://mp.weixin.qq.com/s/AbCdEf123456_xyz" class="appmsg__title">${t}</a>
      <span>阅读 1234</span>
    </div></body></html>`;
  const title = (t: string) => (runScript(withBadge(t), url).parse()!.posts[0] as { title: string }).title;

  it('末尾的「原创」被削掉', () => {
    expect(title('AI日报 7.20｜Kimi K3引爆芯片熊市 原创')).toBe('AI日报 7.20｜Kimi K3引爆芯片熊市');
  });

  // 只有「角标在标题之后」这一半有真机证据，另一半就不做——
  // 削开头会把「原创内容到底该怎么做」这种真标题咬掉两个字。
  it('🔒 只削末尾：以「原创」开头的真标题一个字都不能动', () => {
    expect(title('原创内容到底该怎么做')).toBe('原创内容到底该怎么做');
  });

  it('🔒 标题正文中间的「原创」也不动', () => {
    expect(title('聊聊原创和搬运的区别')).toBe('聊聊原创和搬运的区别');
  });

  it('没有角标的标题原样保留', () => {
    expect(title('春节营销复盘：三条我踩过的坑')).toBe('春节营销复盘：三条我踩过的坑');
  });
});

// 「赞赏」是打赏，不是点赞——而裸别名「赞」正是它的子串（间隔只有一个「赏」字）。
// 公众号文章普遍有赞赏区，串台后存进去的数值小、看着像真的，极难发现。
describe('🔒 赞赏 ≠ 点赞', () => {
  const url = 'https://mp.weixin.qq.com/cgi-bin/appmsgpublish?sub=list';
  const m = (extra: string) => (runScript(`<html><body>
    <div class="appmsg-card">
      <a href="https://mp.weixin.qq.com/s/AbCdEf123456_xyz">文章</a>
      <span>阅读 1234</span>${extra}
    </div></body></html>`, url).parse()!.posts[0] as { metrics: Record<string, number> }).metrics;

  it('只有赞赏时 likes 不该有值', () => {
    expect(m('<span>赞赏 2</span>').likes).toBeUndefined();
  });

  it('赞赏与在看并存时取在看', () => {
    expect(m('<span>赞赏 2</span><span>在看 56</span>').likes).toBe(56);
  });
});

// 一次「多图文群发」是一个外壳套着 N 篇文章。外壳同样满足行的判据（类名含 appmsg），
// 但它只抠得出第一篇的 ID，指标却是从整块文本里邻接匹配来的——后面几篇的数字会被算到第一篇头上。
// 更要命的是去重规则「同一 ID 取指标最全的那一层」：外壳文本里数字最多，它必然赢过真正的卡片。
describe('🔒 多图文群发 · 容器不是行（跨作品串数的直接来源）', () => {
  const url = 'https://mp.weixin.qq.com/cgi-bin/appmsgpublish?sub=list&begin=0&count=10';
  // 照抄真实层级：外层 .weui-desktop-mass-appmsg 里挂着两篇文章各自的 __item
  const massBlock = `
    <div class="weui-desktop-mass-appmsg">
      <div class="weui-desktop-mass-appmsg__item">
        <a href="https://mp.weixin.qq.com/s/AbCdEf123456_xyz" class="weui-desktop-mass-appmsg__title">头条：春节营销复盘</a>
        <span>阅读 1234</span><span>在看 2</span>
      </div>
      <div class="weui-desktop-mass-appmsg__item">
        <a href="https://mp.weixin.qq.com/s/GhIjKl789012_abc" class="weui-desktop-mass-appmsg__title">次条：三个踩过的坑</a>
        <span>阅读 88</span><span>在看 1</span><span>分享 9</span>
      </div>
    </div>`;

  it('两篇文章各自成条，指标不互相串台', () => {
    const posts = runScript(`<html><body>${massBlock}</body></html>`, url).parse()!.posts as {
      platformItemId: string; title: string; metrics: Record<string, number>;
    }[];
    expect(posts).toHaveLength(2);
    const head = posts.find((p) => p.platformItemId.endsWith('AbCdEf123456_xyz'))!;
    const second = posts.find((p) => p.platformItemId.endsWith('GhIjKl789012_abc'))!;
    expect(head.metrics.views).toBe(1234);
    expect(second.metrics.views).toBe(88);
    // 🔒 修复前：外壳（ID=头条，文本含两篇的数字）指标最全而胜出，
    // 头条会拿到次条的「分享 9」——一个它根本没有的数字。
    expect(head.metrics.shares).toBeUndefined();
    expect(second.metrics.shares).toBe(9);
    expect(head.title).toContain('春节营销复盘');
    expect(second.title).toContain('三个踩过的坑');
  });

  it('同一篇作品的多个层级（状态块/卡片）仍按「指标最全者胜」裁决，不受容器过滤影响', () => {
    const sameId = `
      <div class="weui-desktop-mass-appmsg">
        <div class="weui-desktop-mass__status_text">
          <a href="https://mp.weixin.qq.com/s/AbCdEf123456_xyz">已开启通知</a>已通知3人失败0人
        </div>
        <a href="https://mp.weixin.qq.com/s/AbCdEf123456_xyz" class="weui-desktop-mass-appmsg__title">真标题</a>
        <span>阅读 500</span><span>在看 3</span>
      </div>`;
    const posts = runScript(`<html><body>${sameId}</body></html>`, url).parse()!.posts as {
      title: string; metrics: Record<string, number>;
    }[];
    expect(posts).toHaveLength(1);
    expect(posts[0].metrics.views).toBe(500);
    expect(posts[0].title).toBe('真标题');
  });
});

// 插件此前从不回传 publishedAt，后端就填成「回填当天」（own-post.ts `?? new Date()`）——
// 于是每条自动建的记录发布时间都是今天，/data 的「发布时段分析」按小时分组全是回填那一刻。
describe('🔒 发表时间 · 不传就等于把发布时间写成「回填当天」', () => {
  const url = 'https://mp.weixin.qq.com/cgi-bin/appmsgpublish?sub=list&begin=0&count=10';
  const card = (extra: string) => `<html><body>
    <div class="weui-desktop-mass-appmsg">
      <a href="https://mp.weixin.qq.com/s/AbCdEf123456_xyz" class="weui-desktop-mass-appmsg__title">文章</a>
      ${extra}<span>阅读 1234</span>
    </div></body></html>`;
  const pub = (html: string) => (runScript(html, url).parse()!.posts[0] as { publishedAt?: string }).publishedAt;

  it('2026年7月20日 20:30 形态', () => {
    expect(pub(card('<span>2026年7月20日 20:30</span>'))).toBe('2026-07-20T20:30:00');
  });

  it('2026-07-20 形态（无时间）', () => {
    expect(pub(card('<span>2026-07-20</span>'))).toBe('2026-07-20T00:00:00');
  });

  it('🔒 「1.2万」不许被读成 1 月 2 日（裸 a.b / a/b 一律不认）', () => {
    expect(pub(card('<span>点赞 1.2万</span><span>转发 7/10</span>'))).toBeUndefined();
  });

  it('🔒 未来日期一定是误读 → 宁可不给', () => {
    expect(pub(card('<span>2099年1月1日</span>'))).toBeUndefined();
  });

  it('多图文群发：时间写在被摘掉的外壳上，子条目要能往上找到它', () => {
    const html = `<html><body>
      <div class="weui-desktop-mass-appmsg">
        <div class="weui-desktop-mass__time">2026年7月20日 20:30</div>
        <div class="weui-desktop-mass-appmsg__item">
          <a href="https://mp.weixin.qq.com/s/AbCdEf123456_xyz" class="weui-desktop-mass-appmsg__title">头条</a>
          <span>阅读 1234</span></div>
        <div class="weui-desktop-mass-appmsg__item">
          <a href="https://mp.weixin.qq.com/s/GhIjKl789012_abc" class="weui-desktop-mass-appmsg__title">次条</a>
          <span>阅读 88</span></div>
      </div></body></html>`;
    const posts = runScript(html, url).parse()!.posts as { publishedAt?: string }[];
    expect(posts).toHaveLength(2);
    for (const p of posts) expect(p.publishedAt).toBe('2026-07-20T20:30:00');
  });

  it('产物通过后端 zod，发表时间被转成 Date', () => {
    const r = ownPostIngestSchema.safeParse(runScript(card('<span>2026年7月20日 20:30</span>'), url).parse());
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.posts[0].publishedAt?.getFullYear()).toBe(2026);
  });
});

// 页级「流量来源」是账号近 N 天的总体来源。此前它会被原样按到列表页上的**每一篇**头上——
// 10 篇文章拿到一模一样的占比，那不是粗略，那是错的。
describe('🔒 流量来源 · 页级兜底只在单篇页生效', () => {
  const src = '<div class="panel">流量来源分布 推荐 62.0% 搜索 21.5% 关注 10.0%</div>';
  const note = (id: string, views: number) =>
    `<tr><td><a href="/explore/${id}">笔记</a></td><td>${views}</td></tr>`;

  it('单篇页：照常带上来源占比', () => {
    const html = src + table(['笔记', '观看量'], [note('65a1b2c3000000001e03a1b2', 8500)]);
    const m = (runScript(html, 'https://creator.xiaohongshu.com/x').parse()!.posts[0] as {
      metrics: { sources?: Record<string, number> };
    }).metrics;
    expect(m.sources).toMatchObject({ 推荐: 0.62 });
  });

  it('🔒 列表页：不把全站来源按到每一篇头上', () => {
    const html =
      src +
      table(['笔记', '观看量'], [note('65a1b2c3000000001e03a1b2', 8500), note('65a1b2c3000000001e03a1b3', 300)]);
    const posts = runScript(html, 'https://creator.xiaohongshu.com/x').parse()!.posts as {
      metrics: { sources?: unknown };
    }[];
    expect(posts).toHaveLength(2);
    for (const p of posts) expect(p.metrics.sources).toBeUndefined();
  });
});

describe('阅读量 vs 阅读人数 · 不能混为一谈', () => {
  it('优先精确匹配「阅读量」，不把「阅读人数」(UV) 当成阅读次数', () => {
    const html = table(
      ['标题', '阅读人数', '阅读量'],
      [
        `<tr><td><a href="https://mp.weixin.qq.com/s/AbCdEf123456_xyz">t</a></td>
         <td>500</td><td>1200</td></tr>`,
      ],
    );
    const post = runScript(html, 'https://mp.weixin.qq.com/cgi-bin/home').parse()!.posts[0] as {
      metrics: Record<string, number>;
    };
    expect(post.metrics.views).toBe(1200);
  });
});

// 真机 2026-07-25 抓到：用户停在公众号后台**首页** /cgi-bin/home，自检报「认出 178 行但
// 一行都抠不出作品 ID」，把人引去补选择器——而那 178 行全是首页挂件
// （LI.weui-desktop-list__item / SECTION.item），表头是「使用位置 ×10 / 相关文章」，
// 那一页压根就没有作品数据表。白跑一整轮校准。
// 「站错页面」与「选择器失效」必须分开回答：前者的解法是换页面，后者才是改代码。
describe('🔒 站错页面 ≠ 选择器失效（公众号 /cgi-bin 下多数页面没有数据表）', () => {
  const widgets = '<li class="weui-desktop-list__item"><section class="item">相关文章</section></li>'.repeat(178);
  const homeHtml = `<html><body>${widgets}
    <table><thead><tr><th>使用位置</th><th>相关文章</th></tr></thead></table></body></html>`;

  it('后台首页：直接答「换页面」，不得指向选择器', () => {
    const d = runScript(homeHtml, 'https://mp.weixin.qq.com/cgi-bin/home').diagnose();
    expect(d.ok).toBe(false);
    expect(d.reason).toContain('没有作品数据表');
    expect(d.reason).toContain('内容分析');
    // 🔒 关键：不能再出现「补选择器」这类把人引偏的话
    expect(d.reason).not.toContain('补选择器');
  });

  it('内容分析页有真数据表 → 正常解析，不得被误判成「站错页面」', () => {
    const html = table(
      ['标题', '阅读量'],
      [`<tr><td><a href="https://mp.weixin.qq.com/s/AbCdEf123456_xyz">文章</a></td><td>1200</td></tr>`],
    );
    const d = runScript(html, 'https://mp.weixin.qq.com/cgi-bin/appmsganalysis?action=all').diagnose();
    expect(d.ok).toBe(true);
    expect(d.collected).toBe(1);
  });

  it('用户分析页（粉丝/受众）同样放行——白名单不能只认作品页', () => {
    const html = '<html><body><div>粉丝总数 1234</div></body></html>';
    const d = runScript(html, 'https://mp.weixin.qq.com/cgi-bin/useranalysis').diagnose();
    expect(d.ok).toBe(true);
  });

  // 真机 2026-07-25 第二轮：用户连着两次拿到同一句「换页面」。
  // 「站错页面」判错的代价比不判更大——用户已经在数据页上，却被永远挡在门外，
  // 提示还叫他去换页，无论怎么点都出不来。两条出路都必须留：
  it('🔒 SPA 路由在 ?t= 里：pathname 仍是 /cgi-bin/home 也要放行', () => {
    const html = table(
      ['标题', '阅读次数'],
      [`<tr><td><a href="https://mp.weixin.qq.com/s/AbCdEf123456_xyz">文章</a></td><td>1200</td></tr>`],
    );
    const d = runScript(html, 'https://mp.weixin.qq.com/cgi-bin/home?t=statistics/appmsganalysis&token=1234567').diagnose();
    expect(d.ok).toBe(true);
  });

  it('🔒 URL 认不出但页面上真有指标表头 → 以 DOM 为准放行（URL 形态会随改版失效）', () => {
    const html = table(
      ['标题', '阅读次数', '完读率'],
      [`<tr><td><a href="https://mp.weixin.qq.com/s/AbCdEf123456_xyz">文章</a></td><td>1200</td><td>38.5%</td></tr>`],
    );
    const d = runScript(html, 'https://mp.weixin.qq.com/cgi-bin/somethingbrandnew').diagnose();
    expect(d.ok).toBe(true);
  });

  // 真机 2026-07-25 第四轮：用户连着四次拿到一模一样的「换页面」。
  // 根因是这个分支写成了函数开头的提前 return——自检一个字节的 DOM 证据都没采到就走了，
  // 于是「叫人换页」和「把现场交出来」被做成了二选一，循环再也出不去。
  // 换页建议照给，但证据必须一起给：用户不换页时，这就是我唯一的输入。
  it('🔒 判为「站错页面」时，reason 里必须带上现场证据（否则循环出不去）', () => {
    const html = `<html><body>
      <div class="row" data-e2e="card">已发表 阅读 1234</div>
    </body></html>`;
    const d = runScript(html, 'https://mp.weixin.qq.com/cgi-bin/home?t=home/index&token=1').diagnose();
    expect(d.ok).toBe(false);
    expect(d.reason).toContain('行样本'); // 行长什么样
    expect(d.reason).toContain('data-e2e'); // 行上有哪些属性
    expect(d.reason).toContain('页面关键词'); // 这一页到底是不是数据页
  });

  // 真机 2026-07-27：用户停在首页的「已发表」面板（home?t=home/index#tab=sent-panel），
  // 那儿确实列着文章、也确实能采到数——但那些计数是概览性质的，
  // 完整的阅读次数/送达人数/完读率只有「内容分析」页才有。
  // 解析成功时如果不提醒，用户就会以为这一页的数字已经是全部了。
  it('🔒 采到了但站在非标准数据页 → 成功提示里必须带上「换页」建议', () => {
    const html = `<html><body><div class="appmsg-card">
      <a href="https://mp.weixin.qq.com/s/AbCdEf123456_xyz">文章</a><span>阅读 1</span>
    </div></body></html>`;
    const d = runScript(html, 'https://mp.weixin.qq.com/cgi-bin/home?t=home%2Findex&token=1#tab=sent-panel').diagnose();
    expect(d.ok).toBe(true);
    expect(String(d.hint)).toContain('不是标准数据页');
    expect(String(d.hint)).toContain('内容分析');
  });

  it('🔒 站在内容分析页上就不要再劝人换页（那会变成噪音）', () => {
    const html = table(
      ['标题', '阅读次数'],
      [`<tr><td><a href="https://mp.weixin.qq.com/s/AbCdEf123456_xyz">文章</a></td><td>1200</td></tr>`],
    );
    const d = runScript(html, 'https://mp.weixin.qq.com/cgi-bin/appmsganalysis?action=all').diagnose();
    expect(d.ok).toBe(true);
    expect(String(d.hint)).not.toContain('不是标准数据页');
  });

  it('🔒 数据面板在同源 iframe 里时不算「站错页面」（顶层地址仍是 home）', () => {
    const inner = table(
      ['标题', '阅读次数'],
      [`<tr><td><a href="https://mp.weixin.qq.com/s/AbCdEf123456_xyz">文章</a></td><td>1200</td></tr>`],
    );
    const d = runScript('<iframe id="f"></iframe>', 'https://mp.weixin.qq.com/cgi-bin/home?t=home/index&token=1', (doc) => {
      const f = doc.querySelector('#f') as HTMLIFrameElement;
      // 真实形态：首页的「已发表」面板是一个 src=/cgi-bin/appmsgpublish 的子框架
      f.contentDocument!.body.innerHTML = inner;
      Object.defineProperty(f.contentDocument!, 'URL', {
        value: 'https://mp.weixin.qq.com/cgi-bin/appmsgpublish?action=list&token=987654',
        configurable: true,
      });
    }).diagnose();
    expect(d.ok).toBe(true);
    expect(d.collected).toBe(1);
  });

  it('🔒 iframe 地址要报出来，且同样抹掉 token', () => {
    const d = runScript('<iframe id="f"></iframe>', 'https://mp.weixin.qq.com/cgi-bin/home?t=home/index&token=1', (doc) => {
      const f = doc.querySelector('#f') as HTMLIFrameElement;
      f.contentDocument!.body.innerHTML = '<div class="row">空面板</div>';
      Object.defineProperty(f.contentDocument!, 'URL', {
        value: 'https://mp.weixin.qq.com/cgi-bin/somepanel?token=987654',
        configurable: true,
      });
    }).diagnose();
    // 只报「1 个 iframe」等于没报——地址才是线索
    expect(d.reason).toContain('/cgi-bin/somepanel');
    expect(d.reason).not.toContain('987654');
  });

  it('🔒 提示里的地址要带 ?t= 路由但抹掉 token（这串是要用户粘贴回来的）', () => {
    const d = runScript(homeHtml, 'https://mp.weixin.qq.com/cgi-bin/home?t=home/index&token=987654&lang=zh_CN').diagnose();
    expect(d.ok).toBe(false);
    expect(d.reason).toContain('t=home%2Findex'); // 路由参数必须留着，那是补白名单的唯一线索
    expect(d.reason).not.toContain('987654'); // 🔒 token 等同于登录态，绝不能出现在用户粘贴的文本里
    expect(d.reason).toContain('***');
  });
});

// 公众号「用户分析」页一个「粉丝」字都不写，四张指标卡是
// 新增人数 / 取消关注人数 / 净增人数 / 累计人数。只认「粉丝*」等于对公众号全盲——
// 用户按提示切过去，仍然会空手而归。
describe('🔒 公众号口径 · 用户分析页的指标名', () => {
  const url = 'https://mp.weixin.qq.com/cgi-bin/useranalysis';
  // 顺序照抄真实页面：取消关注人数排在净增/累计之前
  const html = `<html><body>
    <div>新增人数 320</div><div>取消关注人数 45</div>
    <div>净增人数 275</div><div>累计人数 12800</div>
  </body></html>`;

  it('累计人数 → followers，净增人数 → followerDelta', () => {
    const r = runScript(html, url).parse() as unknown as {
      dailyStats: { followers: number; followerDelta: number }[];
    };
    expect(r.dailyStats[0].followers).toBe(12800);
    expect(r.dailyStats[0].followerDelta).toBe(275);
  });

  it('🔒 不许把「取消关注人数」当成粉丝总数（「关注人数」是它的子串，这是个真陷阱）', () => {
    const r = runScript(html, url).parse() as unknown as { dailyStats: { followers: number }[] };
    expect(r.dailyStats[0].followers).not.toBe(45);
  });
});

describe('公众号内容分析 · 在看与送达人数', () => {
  const url = 'https://mp.weixin.qq.com/cgi-bin/appmsganalysis?action=all';
  const post = (headers: string[], cells: string[]) =>
    (runScript(
      table(headers, [
        `<tr><td><a href="https://mp.weixin.qq.com/s/AbCdEf123456_xyz">文章</a></td>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`,
      ]),
      url,
    ).parse()!.posts[0] as { metrics: Record<string, number> }).metrics;

  it('在看人数计入 likes；送达人数计入 impressions（阅读次数/送达人数 = 打开率）', () => {
    const m = post(['标题', '送达人数', '阅读次数', '在看人数'], ['5.2万', '8300', '260']);
    expect(m).toMatchObject({ impressions: 52000, views: 8300, likes: 260 });
  });

  it('点赞与在看同时存在时以点赞为准', () => {
    const m = post(['标题', '阅读次数', '点赞数', '在看人数'], ['8300', '410', '260']);
    expect(m.likes).toBe(410);
  });
});

// 真机同一轮抓到的第二个坑：自检的「可能是 ID 的属性值」只留 8 个名额，
// 结果三条全被 data:image base64 和**另一个插件**注入页面的 chrome-extension:// 图标占满，
// 真信号一条都没剩下——用户发回来的证据等于空的。
describe('🔒 自检证据不得被 base64 图片/其它扩展的注入资源挤占', () => {
  it('data: 与 chrome-extension: 一律不算 ID 候选，真实 data-row-key 必须留下', () => {
    const row = `<tr class="row"><td>
      <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg">
      <img src="chrome-extension://ibefaeehajgcpooopoegkifhgecigeeg/assets/icon.png">
      <span data-row-key="realkey123">x</span></td></tr>`;
    const html = table(['标题'], [row.repeat(5)]);
    const d = runScript(html, 'https://mp.weixin.qq.com/cgi-bin/appmsganalysis').diagnose();
    const idish = d.evidence?.idish ?? [];
    expect(idish.some((s) => /data:|chrome-extension:/.test(s))).toBe(false);
    expect(idish.some((s) => s.includes('realkey123'))).toBe(true);
  });
});

// 每日自动回填：service worker 在后台标签页开后台页 → 内容脚本按 autoRoutes 逐页走。
// 公众号后台每个地址都要 token，token 只用于同域内的一次跳转——
// 这条通道里最敏感的一环，单独锁住。
describe('🔒 每日自动回填 · 路线与 token 处理', () => {
  const home = 'https://mp.weixin.qq.com/cgi-bin/home?t=home/index&token=987654&lang=zh_CN';

  it('从当前地址取 token，依次走发表记录 → 内容分析', () => {
    const routes = runScript('<html><body></body></html>', home).autoRoutes()!;
    expect(routes).toHaveLength(2);
    expect(routes[0]).toContain('/cgi-bin/appmsgpublish');
    expect(routes[1]).toContain('/cgi-bin/appmsganalysis');
    // 顺序有讲究：先走已验证能采到数的发表记录页
    expect(routes[0].indexOf('appmsgpublish')).toBeGreaterThan(0);
    for (const r of routes) {
      expect(r.startsWith('https://mp.weixin.qq.com/cgi-bin/')).toBe(true); // 只在同域内跳
      expect(r).toContain('token=987654'); // 后台页没 token 会被踢回登录
    }
  });

  it('🔒 页面上哪儿都没有 token → 返回 null，绝不猜地址硬闯', () => {
    const routes = runScript('<html><body></body></html>', 'https://mp.weixin.qq.com/cgi-bin/home').autoRoutes();
    expect(routes).toBeNull();
  });

  // ⚠️ 下面四条是 2026-08-18「点采集→公众号标签页秒退→什么都没采到」那次的现场。
  // 插件自己开的 /cgi-bin/home **地址里没有 token**，而当时 autoRoutes 只读地址栏 →
  // 返回 null → 执行端 abort → sw.js 立刻关掉标签页，通知还说「登录态已过期」。
  // 同一个页面上，竞对通道（content/wechat-competitor.js）却能从 DOM 里把 token 读出来并采到数据
  //（真机 2026-07-29 已验证）——两条通道判据不一致，才是那次的根。
  const noTokenHome = 'https://mp.weixin.qq.com/cgi-bin/home';

  it('🔒 地址栏没有 token，但左侧菜单链接里有 → 照样算得出路线（秒退那次的现场）', () => {
    const html = `<html><body>
      <a href="/cgi-bin/home?t=home/index&token=987654&lang=zh_CN">首页</a>
      <a href="/cgi-bin/appmsg?t=media/appmsg_edit&token=987654">素材管理</a>
    </body></html>`;
    const routes = runScript(html, noTokenHome).autoRoutes()!;
    expect(routes).toHaveLength(2);
    for (const r of routes) expect(r).toContain('token=987654');
  });

  it('🔒 token 只在首页「已发表」那个 iframe 的 src 上 → 也认', () => {
    const html = '<html><body><iframe src="/cgi-bin/appmsgpublish?sub=list&token=987654&lang=zh_CN"></iframe></body></html>';
    const routes = runScript(html, noTokenHome).autoRoutes()!;
    expect(routes?.[0]).toContain('token=987654');
  });

  it('🔒 token 只写在内联 script 里（cgiData）→ 也认', () => {
    // 隔离世界读不到页面的 JS 变量，但读得到 <script> 的文本——同一份数据的可达形态
    const html = '<html><body><script>window.wx = {data: {token: "987654", nick_name: "x"}};</script></body></html>';
    const routes = runScript(html, noTokenHome).autoRoutes()!;
    expect(routes?.[1]).toContain('token=987654');
  });

  it('🔒 停手理由要分清「没登录」和「登着但这页取不到」——两句不同的话', () => {
    const onLogin = runScript(
      '<html><body></body></html>',
      'https://mp.weixin.qq.com/cgi-bin/loginpage?t=wxm2-login&lang=zh_CN',
    ).noRoutesInfo()!;
    expect(onLogin.reason).toContain('未登录');

    const loggedIn = runScript('<html><body></body></html>', noTokenHome).noRoutesInfo()!;
    expect(loggedIn.reason).not.toContain('未登录');
    expect(loggedIn.reason).not.toContain('过期'); // 登着的人被指去重新扫码，正是那次通知犯的错
    expect(loggedIn.reason).toContain('token');
  });

  // needLogin 决定 sw.js 会不会把这一页切到前台等用户扫码（2026-08-18 用户要求的行为）。
  // 判错一边就白弹一个页面给他，判错另一边就又变回「秒退」。
  it('🔒 needLogin 只在真的停在登录页时为 true', () => {
    const onLogin = runScript(
      '<html><body></body></html>',
      'https://mp.weixin.qq.com/cgi-bin/loginpage?t=wxm2-login&lang=zh_CN',
    ).noRoutesInfo()!;
    expect(onLogin.needLogin).toBe(true);

    // 登着、只是这一页没有 token —— 不是登录问题，不该把人支去重新登录
    expect(runScript('<html><body></body></html>', noTokenHome).noRoutesInfo()!.needLogin).toBe(false);
  });

  it('🔒 登录页判据也认页面上的登录组件（有些登录页路由看不出来）', () => {
    const html = '<html><body><div class="login__type__container"><img id="headimg_qrcode"></div></body></html>';
    expect(runScript(html, noTokenHome).noRoutesInfo()!.needLogin).toBe(true);
  });

  it('🔒 停手理由里不带 token（它等同于登录态，不许出现在任何对外文本里）', () => {
    const html = '<html><body><a href="/cgi-bin/home?token=987654">首页</a></body></html>';
    const r = runScript(html, 'https://mp.weixin.qq.com/cgi-bin/loginpage').noRoutesInfo()!;
    expect(r.reason).not.toContain('987654');
  });

  it('🔒 自检信息里的 token 仍然是脱敏的（自动回填不能把凭证带进可粘贴文本）', () => {
    const d = runScript('<html><body></body></html>', home).diagnose();
    const text = String(d.reason ?? d.hint ?? '');
    expect(text).not.toContain('987654');
    expect(text).toContain('***');
  });

  it('普通浏览（地址上没有 beaconauto 参数）时，自动回填执行端一行都不跑', () => {
    // 跑得起来就说明没碰 chrome.* / setTimeout —— vm 上下文里这两个都不存在，
    // 一旦执行端在普通浏览时也动作，这里会直接抛
    expect(() => runScript('<html><body></body></html>', home)).not.toThrow();
  });
});

// 真机 2026-07-25 入库的 9 条记录，标题全是同一句
// 「已开启通知，内容已在公众号列表和公众号主页展示已通知3人失败0人…」——
// 那是**通知状态块**，不是文章标题。两个原因叠加：
//   ① rowHints 里的 [class*="mass"] 把 weui-desktop-mass__status_text 也当成了行；
//   ② 同一条作品被多个层级匹配到时「先到先得」，状态块在 DOM 里排在前面就赢了。
describe('🔒 公众号发表记录 · 标题不得抓成通知状态块', () => {
  const url = 'https://mp.weixin.qq.com/cgi-bin/appmsgpublish?sub=list&begin=0&count=10';
  // 照抄真实层级：状态块在前，且它也含指向同一篇文章的链接与两个数字
  const item = (token: string, reads: number) => `
    <div class="weui-desktop-mass-appmsg">
      <div class="weui-desktop-mass__status_text">
        <a href="https://mp.weixin.qq.com/s/${token}">已开启通知</a>
        内容已在公众号列表和公众号主页展示已通知3人失败0人通知范围全部用户查看历史版本
      </div>
      <a href="https://mp.weixin.qq.com/s/${token}" class="weui-desktop-mass-appmsg__title">春节营销复盘：三条我踩过的坑</a>
      <span>阅读 ${reads}</span><span>在看 2</span><span>分享 1</span>
    </div>`;
  const page = `<html><body>${item('AbCdEf123456_xyz', 1234)}${item('GhIjKl789012_abc', 88)}</body></html>`;

  it('标题取文章链接的文字，不是「已通知N人」那句', () => {
    const posts = runScript(page, url).parse()!.posts as { title: string; metrics: Record<string, number> }[];
    expect(posts).toHaveLength(2);
    for (const p of posts) {
      expect(p.title).not.toContain('已通知');
      expect(p.title).not.toContain('通知范围');
    }
    expect(posts[0].title).toContain('春节营销复盘');
  });

  it('同一条作品被多层匹配到时，取指标最全的那一层', () => {
    const posts = runScript(page, url).parse()!.posts as { metrics: Record<string, number> }[];
    // 状态块里一个指标都读不到；作品卡片能读到阅读/在看/分享
    expect(posts[0].metrics.views).toBe(1234);
    expect(posts[0].metrics.likes).toBe(2);
    expect(posts[0].metrics.shares).toBe(1);
  });

  it('🔒 rowHints 不许再命中 weui-desktop-mass__status_text 这类状态块', () => {
    const onlyStatus = `<html><body>
      <div class="weui-desktop-mass__status_text">
        <a href="https://mp.weixin.qq.com/s/AbCdEf123456_xyz">已开启通知</a>已通知3人失败0人
      </div></body></html>`;
    // 只有状态块、没有作品卡片时，宁可什么都不采，也不要建一条标题是状态文案的记录
    const r = runScript(onlyStatus, url).parse();
    const titles = r ? (r.posts as { title: string }[]).map((p) => p.title) : [];
    expect(titles.some((t) => t.includes('已通知'))).toBe(false);
  });
});
