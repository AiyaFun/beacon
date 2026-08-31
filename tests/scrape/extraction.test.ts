import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  flattenJson, lookupJsonPath, lookupJsonColumn, jsonSkeleton, mergeCaptures, MAX_JSON_PATHS,
} from '@/lib/scrape/json-capture';
import { parseOptions, pathSeenInHints, selectorSeenInSkeleton } from '@/lib/scrape/recipe';
import { sanitizeRows, MAX_ROWS } from '@/lib/scrape/record';
import { vetRole, vetTestId, selectorTokens } from '@/lib/ingest/parser-learn';
import { MAX_SCROLL_SCREENS } from '@/lib/browser/local';
import { orderedBefore } from '../helpers/anchor';

// 抓得到（2026-08-29 批三）：等待策略 / role-aria 降级 / 列表行 / 有界滚动 / 被动 JSON 捕获。
//
// 这一批的每一条都直接对应「为什么之前采不到东西」：
//   · 固定等 1500ms → 抓到骨架屏，然后被当成改版拿去重学；
//   · 只有类名选择器 → 改版当天全碎（而类名混淆是现在前端的常态）；
//   · 没有行的概念 → 列表页一条都取不到；
//   · 不滚 → 首屏之外的东西根本不存在；
//   · 不看 JSON → 放着最稳的那份数据不用。

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('被动 JSON 捕获：只读它已经发出的，绝不自己发', () => {
  const src = read('lib/browser/local.ts');
  const cap = read('lib/scrape/json-capture.ts');

  it('🔒 捕获模块里没有任何发起请求的能力', () => {
    // 主动调接口是另一件事——那正是公众号后台那条通道，既有分级里评为最高危、
    // 且逐平台预先审过。任意站点不能走那条。
    for (const forbidden of ['fetch(', 'request(', '.goto(', 'XMLHttpRequest', 'axios']) {
      expect(cap, `JSON 捕获模块不该出现 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('🔒 只收同源响应（第三方广告/埋点既不是用户要的数据，又最可能带跨站标识）', () => {
    expect(src).toContain("new URL(res.url()).origin === origin");
  });

  it('🔒 只收 JSON', () => {
    expect(src).toContain("ct.includes('json')");
  });

  it('响应体超大就跳过（几 MB 的响应读它既慢又没必要）', () => {
    expect(src).toContain('body.length > MAX_JSON_BODY_CHARS');
  });

  it('🔒 收口在滚动之后（滚动会触发新 XHR，那正是「加载更多」的数据来源）', () => {
    const scroll = src.indexOf('── 有界滚动 ──');
    const close = src.indexOf('Promise.allSettled(capturing)');
    expect(scroll).toBeGreaterThan(0);
    expect(close).toBeGreaterThan(scroll);
  });

  it('🔒 交给模型的只有路径名与值的形状，不是原始内容', () => {
    const flat = { 'data.items.0.title': '张三的美食日记', 'data.items.0.likes': '12800' };
    const hints = jsonSkeleton(flat);
    expect(hints).toContain('data.items.0.title');
    expect(hints).not.toContain('张三的美食日记');
    expect(hints).toContain('NUM');
  });
});

describe('JSON 压平与取值', () => {
  it('压成路径→值，数组用真实下标', () => {
    const flat = flattenJson({ data: { items: [{ title: 'a' }, { title: 'b' }] } });
    expect(flat['data.items.0.title']).toBe('a');
    expect(flat['data.items.1.title']).toBe('b');
  });

  it('通配只用在取值这一步（记录时用真实下标，才能逐字验证）', () => {
    const flat = flattenJson({ data: { items: [{ title: 'a' }, { title: 'b' }] } });
    expect(lookupJsonPath(flat, 'data.items.*.title')).toBe('a');
    expect(lookupJsonColumn(flat, 'data.items.*.title')).toEqual(['a', 'b']);
  });

  it('通配不许跨层（`a.*.b` 不该匹配 `a.x.y.b`）', () => {
    const flat = flattenJson({ a: { x: { y: { b: 'deep' } }, z: { b: 'shallow' } } });
    expect(lookupJsonPath(flat, 'a.*.b')).toBe('shallow');
  });

  it('列按下标数值排，不按 Object.keys 的插入序（10 要排在 9 后面）', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ n: String(i) }));
    const col = lookupJsonColumn(flattenJson({ items }), 'items.*.n');
    expect(col).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']);
  });

  it('路径数有上限（没有上限的展开会把一个几万条的数组变成几十万个键）', () => {
    const big = { items: Array.from({ length: 50_000 }, (_, i) => ({ a: i, b: i, c: i })) };
    expect(Object.keys(flattenJson(big)).length).toBeLessThanOrEqual(MAX_JSON_PATHS);
  });

  it('合并时先到的赢（后面那些多半是翻页增量，覆盖首屏会让「第一条」变成「最后一条」）', () => {
    expect(mergeCaptures([{ a: '首屏' }, { a: '第二页' }])).toEqual({ a: '首屏' });
  });

  it('不炸：null / 环形以外的怪输入', () => {
    expect(flattenJson(null)).toEqual({});
    expect(flattenJson('x')).toEqual({});
    expect(flattenJson({ 'a.b': 1 })).toEqual({}); // 带点的 key 会让路径产生歧义
  });
});

describe('JSON 路径也要过机器验证（模型说了不算）', () => {
  const hints = 'data.items.0.title = CJK\ndata.items.0.likes = NUM';

  it('见过的路径通过', () => {
    expect(pathSeenInHints(hints, 'data.items.0.title')).toBe(true);
  });

  it('没见过的一律不通过（编一条谁也对不上的路径，看起来完全合法）', () => {
    expect(pathSeenInHints(hints, 'data.list.0.name')).toBe(false);
  });

  it('通配路径按「一段非点字符」比，仍然是在真实材料上比', () => {
    expect(pathSeenInHints(hints, 'data.items.*.title')).toBe(true);
    expect(pathSeenInHints(hints, 'data.*.title')).toBe(false); // 少了一层，不该放行
  });

  it('空路径、超长路径不通过', () => {
    expect(pathSeenInHints(hints, '')).toBe(false);
    expect(pathSeenInHints(hints, 'a'.repeat(300))).toBe(false);
  });
});

describe('role / data-testid：类名混淆时仅剩的锚点', () => {
  it('role 只认标准词表（站点自己编的 role 值会被挡掉）', () => {
    expect(vetRole('listitem')).toBe('listitem');
    expect(vetRole('LIST')).toBe('list');
    expect(vetRole('张三的卡片')).toBe('');
    expect(vetRole('user-8823')).toBe('');
  });

  it('testid 只认标识符形状（规则包是全局下发的，一个用户 ID 混进去会推给所有人）', () => {
    expect(vetTestId('feed-item')).toBe('feed-item');
    expect(vetTestId('userFollowers')).toBe('userFollowers');
    expect(vetTestId('user-8823')).toBe(''); // 实例 ID：既定位不到下一次，又可能是个人标识
    expect(vetTestId('张三')).toBe('');
    expect(vetTestId('12345')).toBe('');
    expect(vetTestId('ab')).toBe('');
  });

  it('🔒 属性选择器的**值**也要验（原来只验属性名，等于这一类规则完全没过闸）', () => {
    // `data-testid` 这个名字几乎每个站点都有——只验名字，模型随便编个值也照过
    const tokens = selectorTokens('[data-testid="user-followers"]');
    expect(tokens).toContain('data-testid');
    expect(tokens).toContain('user-followers');
  });

  it('属性名与值**都**要在骨架里见过', () => {
    // 真实骨架里属性**名**在 attrs（ALLOWED_ATTR 放行 data-*），**值**在 tid。
    // 两样都要对上——这比只验名字严格得多，而只验名字等于没验。
    const skeleton = '{"tag":"div","attrs":["data-testid"],"tid":"user-followers"}';
    expect(selectorSeenInSkeleton(skeleton, '[data-testid="user-followers"]')).toBe(true);
    expect(selectorSeenInSkeleton(skeleton, '[data-testid="编出来的"]')).toBe(false);
    // 名字对了值不对，照样不通过
    expect(selectorSeenInSkeleton('{"attrs":["data-testid"]}', '[data-testid="user-followers"]')).toBe(false);
  });
});

describe('列表行：行边界判错 = 跨条目串数', () => {
  it('🔒 每行只在自己那棵子树里找（退到全局会把第一行的值当成第二行的）', () => {
    const src = read('lib/browser/local.ts');
    // pick 必须接收 root，且行循环把行节点当 root 传进去
    expect(src).toContain('const pick = (rule, root) => {');
    expect(src).toContain('root.querySelector(sel)');
    expect(src).toContain('pick(r, node)');
    // 插件那端同一口径——两处不一致会让同一条配方在两条路上给出不同的数
    const ext = read('extension/tools/recipe-run.js');
    expect(ext).toContain('function pick(rule, root)');
    expect(ext).toContain('pick(rule, node)');
  });

  it('🔒 行容器必须显式指定，绝不由代码去猜', () => {
    const src = read('lib/browser/local.ts');
    expect(src).toContain("const rowSelector = args.rowSelector || '';");
    expect(src).toContain('if (rowSelector) {');
  });

  it('空行不收（一个字段都没取到说明指到了容器而不是行，收进来只会让条数变成假象）', () => {
    expect(sanitizeRows([{ f1: 'a' }, {}, { f2: 'b' }])).toEqual([{ f1: 'a' }, { f2: 'b' }]);
  });

  it('行数有上限（与既有翻页采集的服务端硬上限同一个数）', () => {
    expect(MAX_ROWS).toBe(50);
    const many = Array.from({ length: 500 }, (_, i) => ({ f1: `第${i}行` }));
    expect(sanitizeRows(many).length).toBeLessThanOrEqual(MAX_ROWS);
  });

  it('行里的值走同一套 key 白名单与长度闸', () => {
    const rows = sanitizeRows([{ f1: 'x'.repeat(500), 昵称: 'y' }]);
    expect(rows[0].f1.length).toBe(200);
    expect(rows[0].昵称).toBeUndefined();
  });

  it('🔒 有行就算抓到了（纯列表页往往没有任何页面级标量）', () => {
    expect(read('lib/scrape/record.ts')).toContain('if (got === 0 && rows.length === 0)');
    expect(read('lib/scrape/sweep.ts')).toContain('if (got === 0 && rowCount === 0)');
  });
});

describe('有界滚动：只滚，不点', () => {
  const src = read('lib/browser/local.ts');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('🔒 只读那条红线没有松动：仍然不点击、不输入、不提交', () => {
    for (const forbidden of ['.click(', '.fill(', '.type(', '.press(']) {
      expect(code, `本机浏览器不该出现 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('🔒 「加载更多」按钮明确不点（那是点击，是另一件事）', () => {
    expect(code).not.toMatch(/加载更多[^）]*click/);
    expect(src).toContain('「加载更多」按钮是点击');
  });

  it('屏数有硬上限，且在函数内部再夹一次（调用方传 999 也没用）', () => {
    expect(MAX_SCROLL_SCREENS).toBeLessThanOrEqual(20);
    expect(src).toContain('Math.min(Math.max(Number(options.scrollScreens ?? 0) || 0, 0), MAX_SCROLL_SCREENS)');
  });

  it('连续两轮高度不涨就停（不加载更多的页面不该白滚满 N 轮）', () => {
    expect(src).toContain('if (after <= before) { flat += 1; if (flat >= 2) break; } else flat = 0;');
  });

  it('默认不滚——滚动是配方显式声明的，不是默认行为', () => {
    expect(parseOptions('{}').scrollScreens).toBeUndefined();
    expect(parseOptions('{"scrollScreens":3}').scrollScreens).toBe(3);
    expect(parseOptions('{"scrollScreens":999}').scrollScreens).toBe(15);
    expect(parseOptions('{"scrollScreens":-5}').scrollScreens).toBe(0);
  });
});

describe('页面就绪：别把骨架屏当成改版', () => {
  const src = read('lib/browser/local.ts');

  it('🔒 不用 networkidle（长连接不断的站点会一路等到超时）', () => {
    // 【必须先剥注释】文件里正写着「不用 networkidle：很多站点长连接不断」——
    // 直接全文匹配会被自己的说明绊倒。这个项目在同一件事上栽过两次了。
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('networkidle');
    // 而说明本身要留着——它记着这条取舍的理由
    expect(src).toContain('不用 networkidle');
  });

  it('声明了就绪选择器就等它，且等待有上限', () => {
    expect(src).toContain('page.waitForSelector(ready, { timeout: READY_TIMEOUT_MS');
  });

  it('等不到不算失败（可能是站点改版了，该由取值与重学去判，不是在这儿卡死）', () => {
    const i = src.indexOf('page.waitForSelector(ready');
    expect(src.slice(i, i + 300)).toContain('.catch(');
  });

  it('骨架在滚动之后取（先取等于只让模型看见首屏，而行结构常常在第二屏）', () => {
    orderedBefore(src, '── 有界滚动 ──', 'const rawSkeleton = await page.evaluate(SKELETON_FN)');
  });
});

describe('选项也要过闸，且要传到该去的地方', () => {
  it('坏数据当空（一个写坏的选项不该让整个配方跑不了）', () => {
    expect(parseOptions('不是JSON')).toEqual({});
    expect(parseOptions(null)).toEqual({});
    expect(parseOptions('[1,2]')).toEqual({});
  });

  it('学出来的选择器同样要在骨架里见过（编一个不存在的只会让每次都等满超时）', () => {
    expect(read('lib/scrape/recipe.ts')).toContain('selectorSeenInSkeleton(skeleton, opts.readySelector)');
    expect(read('lib/scrape/recipe.ts')).toContain('selectorSeenInSkeleton(skeleton, opts.rowSelector)');
  });

  it('🔒 导出的独立脚本要带上选项（不带的话用户拿走的那份和站内跑出来不一样）', () => {
    const src = read('lib/browser/local.ts');
    expect(src).toContain('const OPTIONS = ');
    expect(src).toContain('OPTIONS.rowSelector');
    expect(src).toContain('OPTIONS.scrollScreens');
    expect(read('lib/agent/tools-local.ts')).toContain('options: parseOptions(r.options)');
  });

  it('🔒 插件也拿得到选项（不下发的话插件那条路取不到列表，两条路产出会不一样）', () => {
    expect(read('app/api/ingest/recipe/route.ts')).toContain('options: parseOptions(r.options)');
    expect(read('extension/tools/recipe-run.js')).toContain('const opts = recipe.options || {};');
  });
});

// ── 披露必须与行为一致（2026-08-29）─────────────────────────────────────
//
// 这个项目栽过一次空承诺（评论「两人以上才留存」写在政策里、代码里没有），
// 也做过一整轮「文案与实际行为相反」的审计。所以这一批里凡是改变了
// 「我们从页面上拿走什么」的，都要在政策里对得上——披露与行为不符是下架级问题。
describe('隐私政策与代码对得上', () => {
  const web = read('app/(public)/legal/privacy/page.tsx');
  const md = read('extension/store/privacy.md');
  const gen = read('scripts/privacy-page.ts');

  it('🔒 不能再说「不含属性值」——role 与 data-testid 的值现在真的会上传', () => {
    for (const [name, src] of [['网页政策', web], ['插件政策', md], ['境外页生成器', gen]] as const) {
      expect(src, `${name}还写着「不含属性值」，而代码已经在传了`).not.toContain('不含属性值');
    }
    // ⚠️ extension/store/privacy-policy.html 是**抓生产页**生成的产物，
    // 上线前它仍然是旧文案——部署后重跑 `npx tsx scripts/privacy-page.ts` 才会更新。
    // 所以这条守卫刻意不查它：查了会在「代码已改、还没部署」这个正常状态下恒红。
  });

  it('🔒 两道白名单闸都要写进政策（说了收值，就得说清收哪些）', () => {
    for (const src of [web, md, gen]) {
      expect(src).toContain('ARIA');
      expect(src).toContain('data-testid');
    }
    expect(web).toContain('user-8823'); // 排除实例 ID 这条要具体，不能只说「会过滤」
  });

  it('🔒 采集配方要有披露：数据真的会留下来', () => {
    expect(web).toContain('采集配方');
    expect(web).toContain('90 天');
    expect(web).toContain('robots.txt');
  });

  it('🔒 「被动」两个字必须落在政策里，且说清绝不自行发请求', () => {
    expect(web).toContain('被动读取');
    expect(web).toContain('绝不自行发起任何请求');
  });

  it('🔒 滚动要披露，且说清不点击不提交', () => {
    expect(web).toContain('向下滚动');
    expect(web).toContain('不点击任何按钮');
  });
});
