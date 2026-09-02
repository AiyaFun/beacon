import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// 「写了没接」常驻守卫（2026-08-29）。
//
// ── 这个项目反复栽在同一件事上 ──
// 写了一个函数，却没有任何调用点。它**不报错**，测试也可能是绿的（测试自己在调），
// 只是**那个能力在产品里根本不存在**。历史上至少三次：
//   · `sweepRetention` 写完没进 SCHEDULES → 保留期清理从来没跑过
//   · `shouldHintWechatAiSource` 零调用点
//   · `TopicIdea.angleShape` 三处写、零处读
// 而这些每次都是**接手的人靠手动 grep 调用点**才发现的。手动查治不了复发，所以钉成守卫。
//
// ── 判据 ──
// 一个导出的函数，在生产代码里出现的次数必须 ≥ 2：一次是它自己的定义，
// 至少还要有一次是别人（或它自己文件里别的地方）在调。
// 只出现一次 = 定义了、谁也没用 = 写了没接。
//
// **测试里的引用不算数**——那正是这类缺陷最典型的伪装：测试调得好好的，产品里没人用。
//
// ── 范围 ──
// 只盯本轮新增的这几个模块。全库扫会扫出一堆历史遗留，
// 而一条永远红着的守卫等于没有守卫（这个项目对「告警恒亮」有过明确判断）。

const ROOT = process.cwd();

/** 盯着的模块。新增 lib/geo/** 或采集相关模块时往这里加。 */
const WATCHED = [
  'lib/geo/ai-crawler.ts',
  'lib/geo/crawler-log.ts',
  'lib/geo/citation.ts',
  'lib/geo/llms-txt.ts',
  'lib/geo/public-surface.ts',
  'lib/scrape/record.ts',
  'lib/scrape/json-capture.ts',
  // 【2026-08-29 扩进来的】上一轮这道守卫只盯 geo/scrape，**没盯 legal**——
  // 于是 `resolveRemovalRequest`「生产零调用点、只有测试在调」这件事它一条都没报，
  // 而那正是「读者删自己评论」这个法律承诺兑现不了的直接原因。
  // 合规相关的实现尤其要盯：它们的「没人调」不表现为功能缺失，而表现为**承诺是假的**。
  'lib/legal/removal.ts',
  // 【2026-09-02 扩进来的】微信两条通道：客户端函数多、调用点各只有一处（route/diagnose/actions），
  // 正是「写了没接」最容易长出来的地方——比如 kfSendWelcome 写了却没在 route 里对 enter_session 调，
  // 或 gatewayProbe 写了体检没接。盯上它们。
  'lib/bot/wechat-kf.ts',
  'lib/bot/wechat-ilink.ts',
  'lib/bot/wechat-ilink-poller.ts',
  'lib/bot/wechat-text.ts',
];

/**
 * 刻意允许「只在自己文件里被用」的，每条都要写理由。
 * 【为什么要理由】没有理由的豁免清单会变成垃圾桶：谁遇到红就往里加一行，
 * 半年后这道守卫就什么都不守了。
 */
const EXEMPT: Record<string, string> = {
  'lib/geo/crawler-log.ts:recordCrawlerHit':
    '真正的入口是同文件的 recordCrawlerHitAsync（不等它，见那里的说明）；能力是通的。',
  'lib/geo/crawler-log.ts:normalizePath':
    '同文件内 recordCrawlerHit 在用；单独导出是为了能被测试直接验边界。',
  'lib/scrape/record.ts:sanitizeValues':
    '同文件内 saveScrapeRecord / sanitizeRows 在用；单独导出是为了能被测试直接验边界。',
  'lib/scrape/record.ts:sanitizeRows':
    '同文件内 saveScrapeRecord 在用；单独导出是为了能被测试直接验边界。',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const rel = `${dir}/${name}`;
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx|js)$/.test(name)) out.push(rel);
  }
  return out;
}

/**
 * 生产代码。
 *
 * 【为什么 scripts/ 也算】2026-08-29 这道守卫刚扩到 lib/legal 时，把
 * `resolveRemovalRequest` 等三个报成了「没人调」——而它们的调用点正是
 * `scripts/removal-requests.ts`，**移除申请唯一的真实运营入口**。
 * 一个只能从 CLI 触发的能力仍然是产品的一部分；把 scripts/ 排除在外，
 * 这道守卫就会对所有「运营台专属」的实现集体误报。
 *
 * 【代价，说清楚】这也意味着：一个只被某个一次性迁移脚本调过的函数会被算作「接上了」。
 * 那是这条边界换来的代价——宁可漏报几个一次性脚本里的孤儿，
 * 也不能对整条运营链路误报（误报多了，人就开始往 EXEMPT 里乱塞）。
 */
function productionFiles(): string[] {
  const dirs = ['lib', 'app', 'components', 'extension', 'scripts'];
  const out: string[] = [];
  for (const d of dirs) walk(d, out);
  for (const f of ['worker.ts', 'mcp-server.ts', 'middleware.ts', 'publisher.ts', 'connector.ts']) {
    try { statSync(join(ROOT, f)); out.push(f); } catch { /* 没有就跳过 */ }
  }
  return out;
}

/**
 * 剥掉注释**与 import 语句**。
 *
 * 【为什么 import 也要剥】2026-08-29 变异验证当场抓到：把唯一的调用点删掉之后，
 * 这道守卫**依然是绿的**——因为函数名还留在 `import { … }` 那一行里，被算成了「有人用」。
 * 一个没被使用的 import 恰恰是「写了没接」最典型的残留物，把它算成调用点，
 * 等于这道守卫在它最该报警的那一刻失效。
 * （这是本会话第 N 次踩「断言落在了不该落的地方」，形状与「守卫被自己的注释绊倒」同源。）
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    // 单行与多行 import 都要剥
    .replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*import\s*\{[\s\S]*?\}\s*from\s+['"][^'"]+['"];?/gm, '');
}

describe('写了没接：新增模块的每个导出函数都要真的有人用', () => {
  const files = productionFiles();
  const corpus = new Map<string, string>();
  for (const f of files) corpus.set(f, stripComments(readFileSync(join(ROOT, f), 'utf8')));

  const cases: { key: string; sym: string; file: string }[] = [];
  for (const f of WATCHED) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/^export (?:async )?function ([A-Za-z0-9_]+)/gm)) {
      cases.push({ key: `${f}:${m[1]}`, sym: m[1], file: f });
    }
  }

  it('盯着的模块里确实扫到了导出函数（守卫自己不能空转）', () => {
    expect(cases.length).toBeGreaterThan(15);
  });

  it.each(cases)('$key 有调用点', ({ key, sym }) => {
    if (EXEMPT[key]) {
      expect(EXEMPT[key].length, `${key} 的豁免理由不能是空的`).toBeGreaterThan(10);
      return;
    }
    let hits = 0;
    const re = new RegExp(`\\b${sym}\\b`, 'g');
    for (const [, src] of corpus) hits += (src.match(re) ?? []).length;
    expect(
      hits,
      `${key} 在生产代码里只出现 ${hits} 次（只有定义、没有调用）。`
      + '这就是这个项目反复栽的「写了没接」：不报错、测试可能还是绿的，'
      + '但那个能力在产品里根本不存在。要么接上它，要么删掉它，'
      + `要么在本文件的 EXEMPT 里按 \`${key}\` 写明理由。`,
    ).toBeGreaterThanOrEqual(2);
  });

  it('🔒 豁免清单里不许有已经失效的条目（否则它会慢慢变成垃圾桶）', () => {
    const known = new Set(cases.map((c) => c.key));
    for (const key of Object.keys(EXEMPT)) {
      expect(known.has(key), `EXEMPT 里的 ${key} 已经不存在了，请删掉这条豁免`).toBe(true);
    }
  });

  it('盯着的文件都还在（改名后守卫会静默失效）', () => {
    for (const f of WATCHED) {
      expect(() => statSync(join(ROOT, f)), `${f} 不在了，WATCHED 要跟着改`).not.toThrow();
    }
    expect(relative(ROOT, ROOT)).toBe('');
  });
});

// ── 公开文件路由必须进 middleware 白名单（2026-08-29 生产真踩）────────────
//
// `/llms.txt` 上线后被 307 到登录页：新增了一个对外公开的文件路由，却没同步加进
// middleware 的 PUBLIC_PATHS。**本地单测全绿**——它们根本不过 middleware。
// 这与「加 ingest 路由必须同步改 middleware」是同一条教训，只是换了个入口。
describe('公开文件路由 vs middleware 白名单', () => {
  const mw = readFileSync(join(ROOT, 'middleware.ts'), 'utf8');

  /** app/ 下这些是给机器读的公开文件路由，都必须被放行。 */
  const PUBLIC_FILE_ROUTES = ['/robots.txt', '/sitemap.xml', '/llms.txt'];

  it.each(PUBLIC_FILE_ROUTES)('%s 在 PUBLIC_PATHS 里', (route) => {
    expect(
      mw,
      `${route} 是对外公开的文件路由，但不在 middleware 的 PUBLIC_PATHS 里——`
      + '它会被 307 到登录页，而本地单测发现不了（单测不过 middleware）。',
    ).toContain(`'${route}'`);
  });

  // 【公开文件路由要自己放行自己】middleware 放行解决的是「HTTP 上取不取得到」，
  // 与「robots 许不许爬」是两回事。少了后者，同一份 robots.txt 底部的
  // `Sitemap:` 会指向一个它自己 Disallow 掉的 URL——Search Console 报
  // 「已提交的站点地图无法读取（被 robots.txt 屏蔽）」。
  // /robots.txt 不在此列：按协议它从不受自己约束。
  it.each(['/sitemap.xml', '/llms.txt'])('%s 也被 robots 自己放行', async (route) => {
    const { PUBLIC_ALLOW } = await import('@/lib/geo/public-surface');
    expect(
      PUBLIC_ALLOW,
      `${route} 不在 PUBLIC_ALLOW 里 —— robots.txt 的 Disallow: / 会把它自己封掉。`
      + '（这与 middleware 白名单是两件事：那个管「取不取得到」，这个管「许不许爬」。）',
    ).toContain(route);
  });

  it('🔒 robots.txt 底部指向的 sitemap 必须在放行清单里（否则自相矛盾）', async () => {
    const robots = readFileSync(join(ROOT, 'app/robots.ts'), 'utf8');
    const { PUBLIC_ALLOW } = await import('@/lib/geo/public-surface');
    const m = /sitemap: `\$\{SITE\}(\/[^`]*)`/.exec(robots);
    expect(m, 'robots.ts 里的 sitemap 那行形状变了，这条守卫要跟着改').toBeTruthy();
    expect(
      PUBLIC_ALLOW,
      `robots.txt 递交了 ${m![1]}，却又用 Disallow: / 把它封了`,
    ).toContain(m![1]);
  });

  it('🔒 app/ 里每个 .txt/.xml 文件路由都被覆盖到（新加一个就会红）', () => {
    // 扫 app/ 下形如 app/<name>.txt/route.ts 的目录，以及 robots.ts / sitemap.ts
    const found = new Set<string>();
    for (const name of readdirSync(join(ROOT, 'app'))) {
      if (/\.(txt|xml)$/.test(name)) found.add(`/${name}`);
      if (name === 'robots.ts') found.add('/robots.txt');
      if (name === 'sitemap.ts') found.add('/sitemap.xml');
    }
    expect(found.size).toBeGreaterThanOrEqual(3);
    for (const r of found) {
      expect(
        PUBLIC_FILE_ROUTES,
        `app/ 下发现了公开文件路由 ${r}，但这条守卫的清单里没有它——`
        + '请把它加进 PUBLIC_FILE_ROUTES，并确认 middleware 也放行了。',
      ).toContain(r);
    }
  });
});
