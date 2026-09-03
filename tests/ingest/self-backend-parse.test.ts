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
    const d = runScript(html, 'https://creator.douyin.com/creator-micro/content/manage').diagnose();
    const idish = d.evidence?.idish ?? [];
    expect(idish.some((s) => /data:|chrome-extension:/.test(s))).toBe(false);
    expect(idish.some((s) => s.includes('realkey123'))).toBe(true);
  });
});


