import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AI_AGENTS, AI_ENGINES_WITHOUT_PUBLIC_UA, AI_CRAWLER_VERSION, AI_CRAWLER_NEXT_REVIEW,
  identifyAiCrawler, realCrawlers, robotsTokens, findAgent,
} from '@/lib/geo/ai-crawler';
import { normalizePath, CRAWLER_HIT_RETENTION_DAYS } from '@/lib/geo/crawler-log';
import { PUBLIC_ALLOW, PUBLIC_PAGES, allowedByRobots } from '@/lib/geo/public-surface';
import { buildLlmsTxt } from '@/lib/geo/llms-txt';
import { extractCitations, answerSiteOf, AI_ANSWER_SITES } from '@/lib/geo/citation';

// AI 爬虫识别（2026-08-29）。
//
// 【这一层的风险不在「认不出」，在「认错」】
// 认不出的代价是少一条数据；认错的代价是**基于错的结论做拦截决定**——
// 而拦错 search 那一档 = 从此不可能被引用，是这条路上最贵的一次误操作。
//
// 三个最容易出错的地方，每个都有既有事故背书：
//   ① robots 令牌被当成 UA（Google-Extended 永远不会出现在任何请求里）；
//   ② 三种用途被合并成「AI 爬虫」一个词；
//   ③ 没有公开 UA 的国产引擎被印成「没来过」（缺席当成 0，本库在 hotScore 上栽过）。

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('robots 令牌 ≠ 爬虫（最容易搞错的一件事）', () => {
  it('🔒 robots 令牌一律没有 uaMatch（给了就是造一个永远不会命中的规则）', () => {
    for (const t of robotsTokens()) {
      expect(t.uaMatch, `${t.token} 是 robots 令牌，不该有 UA 匹配串`).toBeNull();
    }
    expect(robotsTokens().length).toBeGreaterThan(0);
  });

  it('🔒 Google-Extended 永远认不出来（它不是爬虫）', () => {
    expect(findAgent('Google-Extended')?.kind).toBe('robots_token');
    // 就算有人把这个字符串塞进 UA，也不该被当成 Google-Extended「来访」
    expect(identifyAiCrawler('Mozilla/5.0 Google-Extended')).toBeNull();
  });

  it('🔒 真爬虫必须都有 uaMatch（没有的话它永远不会被记到）', () => {
    for (const c of realCrawlers()) {
      expect(c.uaMatch, `${c.token} 是爬虫却没有 UA 匹配串`).toBeTruthy();
      expect(c.uaMatch).toBe(c.uaMatch!.toLowerCase());
    }
  });
});

describe('识别：真实 UA 的名字埋在中间', () => {
  it('认得出 GPTBot（真实 UA 前后都有别的东西）', () => {
    const ua = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot';
    expect(identifyAiCrawler(ua)?.token).toBe('GPTBot');
  });

  it('🔒 同一家的三个分得开——这正是拦错代价最大的地方', () => {
    expect(identifyAiCrawler('compatible; GPTBot/1.2')?.purpose).toBe('training');
    expect(identifyAiCrawler('compatible; OAI-SearchBot/1.0')?.purpose).toBe('search');
    expect(identifyAiCrawler('compatible; ChatGPT-User/1.0')?.purpose).toBe('user_fetch');
  });

  it('同一家的几个都各自认得出', () => {
    expect(identifyAiCrawler('compatible; Claude-SearchBot/1.0')?.token).toBe('Claude-SearchBot');
    expect(identifyAiCrawler('compatible; Claude-User/1.0')?.token).toBe('Claude-User');
    expect(identifyAiCrawler('compatible; Perplexity-User/1.0')?.token).toBe('Perplexity-User');
  });

  it('🔒 没有任何一个 uaMatch 是另一个的子串——**这条才是正确性的真正依据**', () => {
    // 【为什么改成这条】原来这里写的是「长的先匹配」，还举了 Claude-SearchBot vs ClaudeBot 当例子。
    // 但 'claude-searchbot' **并不包含** 'claudebot'（中间有连字符），两者根本不重叠——
    // 那条断言无论排不排序都是绿的，是一条假绿：它证明的事情和它声称的事情不是一回事
    //（把排序整个删掉，测试照样全绿，是变异验证抓出来的）。
    //
    // 真正保证「不会把子类认成父类」的，是**当前所有 uaMatch 两两不互为子串**这个不变量。
    // 它现在成立，而且这条守卫会在有人加进一个破坏它的条目时立刻变红——
    // 那才是需要有人停下来想一想的时刻（identifyAiCrawler 里的长度倒序就是为那一天准备的）。
    const matches = realCrawlers().map((c) => c.uaMatch!).filter(Boolean);
    expect(matches.length).toBeGreaterThan(5);
    for (const a of matches) {
      for (const b of matches) {
        if (a === b) continue;
        expect(b.includes(a), `「${a}」是「${b}」的子串：加它进来的人要先确认识别顺序`).toBe(false);
      }
    }
  });

  it('长度倒序那道防线还在（不变量哪天破了，靠的是它）', () => {
    expect(read('lib/geo/ai-crawler.ts')).toContain('b.uaMatch!.length - a.uaMatch!.length');
  });

  it('普通浏览器与空 UA 认不出（不许误伤真人）', () => {
    expect(identifyAiCrawler('Mozilla/5.0 (Macintosh) Chrome/140.0 Safari/537.36')).toBeNull();
    expect(identifyAiCrawler('')).toBeNull();
    expect(identifyAiCrawler(null)).toBeNull();
    expect(identifyAiCrawler(undefined)).toBeNull();
  });

  it('大小写不敏感', () => {
    expect(identifyAiCrawler('BYTESPIDER')?.token).toBe('Bytespider');
  });
});

describe('证据纪律：没有公开文档就不许写', () => {
  it('🔒 每一条都要有文档出处', () => {
    for (const a of AI_AGENTS) {
      expect(a.doc, `${a.token} 没有文档出处`).toMatch(/^https:\/\//);
    }
  });

  it('🔒 没有公开 UA 的引擎必须**显式**列出来，不能只是不出现', () => {
    // 不列的话这就是一份纯英文清单，用户会得出「国产引擎不抓我」这个结论——
    // 而真相是我们不知道它们用什么名字抓。缺席不许当成 0（hotScore 那次事故的形状）
    expect(AI_ENGINES_WITHOUT_PUBLIC_UA.length).toBeGreaterThan(0);
    const names = AI_ENGINES_WITHOUT_PUBLIC_UA.map((e) => e.name);
    expect(names).toContain('腾讯元宝');
    for (const e of AI_ENGINES_WITHOUT_PUBLIC_UA) {
      expect(e.why, `${e.name} 没写为什么`).toBeTruthy();
      // 这些名字**绝不能**同时出现在 AI_AGENTS 里——那等于我们编了一个 UA
      expect(AI_AGENTS.some((a) => a.operator.includes(e.name) || a.token.includes(e.name))).toBe(false);
    }
  });

  it('🔒 表有版本号与下次校准日期（过期不改 = 拿一份不成立的清单做拦截决定）', () => {
    expect(AI_CRAWLER_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(AI_CRAWLER_NEXT_REVIEW).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(AI_CRAWLER_NEXT_REVIEW > AI_CRAWLER_VERSION).toBe(true);
  });

  it('传统搜索引擎也在表里（国产/微软生态里，被引用的前置是被收录）', () => {
    // 漏掉它们，用户会以为「放行 AI 爬虫就行」，而那正好漏掉最要紧的一条
    for (const t of ['bingbot', 'Baiduspider', 'Googlebot']) {
      expect(findAgent(t), `${t} 不在表里`).toBeTruthy();
    }
  });
});

describe('单一真相源：robots 与识别不许各写一份', () => {
  const robotsSrc = read('app/robots.ts');

  it('🔒 robots.ts 从表里派生，不自己列名字', () => {
    expect(robotsSrc).toContain("from '@/lib/geo/ai-crawler'");
    // 2026-08-29 起改用现成的谓词（realCrawlers/robotsTokens），
    // 不再在这里内联 AI_AGENTS.filter —— 同一个判断散在两处就是「表又散了一处」
    expect(robotsSrc).toMatch(/realCrawlers\(\)|robotsTokens\(\)/);
    // 手写一个爬虫名字进 robots.ts = 表又散了一处（HeiGe-GEO 的病灶⑥）
    for (const t of ['GPTBot', 'ClaudeBot', 'PerplexityBot']) {
      expect(robotsSrc, `robots.ts 里手写了 ${t}，表就散了`).not.toContain(`'${t}'`);
    }
  });

  it('🔒 每一个具名组都自带 allow/disallow（RFC 9309：具名组不继承 * 组）', () => {
    // 只写名字不写规则 = 给了它一个空组，等于不受任何限制。
    // 这个坑在 HeiGe-GEO-SEO 的 gen_robots 里出现过。
    // 【断言落在代码上，不落在注释上】原来还断言了源码里有「RFC 9309」这几个字——
    // 那是在守注释，代码怎么改都绿，被项目自己的 fake-green-guard 抓了出来。
    const code = robotsSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const groups = [...code.matchAll(/userAgent: [^,]+,\s*allow: ALLOW,\s*disallow: '\/'/g)];
    // 一条 `*` 组 + 两个 map（爬虫组、令牌组）
    expect(groups.length, '有具名组没带自己的 allow/disallow').toBeGreaterThanOrEqual(3);
    // 反过来也要成立：不许出现只有 userAgent 没有规则的组
    const bare = [...code.matchAll(/userAgent: [^,]+,\s*\}/g)];
    expect(bare.length, '出现了空组（只有名字没有规则）').toBe(0);
  });

  it('🔒 /legal 放行，且三个组用的是同一份清单（商店审核机器遵守 robots.txt）', () => {
    const code = robotsSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // ALLOW 是**一份**常量，被三个组共用——这才是「不会只在 * 组里放行 /legal」的保证。
    // 各组各写一份的话，漏掉一处不会报错，后果是商店提交直接卡住（2026-07-27 真机撞到）
    expect(PUBLIC_ALLOW).toContain('/legal');
    expect(code).toContain('const ALLOW = [...PUBLIC_ALLOW]');
    expect((code.match(/allow: ALLOW/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('记录：只记该记的', () => {
  it('🔒 路径去掉查询串（不去的话按天聚合就退化成一条一行）', () => {
    expect(normalizePath('/hotlists?from=x&t=123')).toBe('/hotlists');
    expect(normalizePath('/a/b/#frag')).toBe('/a/b');
  });

  it('尾斜杠归一，根路径保留', () => {
    expect(normalizePath('/legal/')).toBe('/legal');
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('')).toBe('/');
  });

  it('超长路径截断（爬虫会试各种超长路径）', () => {
    expect(normalizePath(`/${'a'.repeat(500)}`).length).toBeLessThanOrEqual(200);
  });

  it('🔒 不记 IP、不记完整 UA、不记查询串', () => {
    const src = read('lib/geo/crawler-log.ts');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // 【查的是「存了什么」，不是「出现过什么词」】原来把 userAgent 也列进禁词，
    // 但它是这个函数的**入参名**——断言因此恒假，说的不是它想说的事。
    // 要证明的是**落库的那个对象里**没有身份字段。
    const i = code.indexOf('create: {');
    expect(i, '没找到落库的字段').toBeGreaterThan(0);
    const payload = code.slice(i, code.indexOf('}', i));
    for (const bad of ['ip', 'userAgent', 'ua', 'query', 'referer']) {
      expect(payload, `落库字段里不该有 ${bad}`).not.toContain(bad);
    }
    // 请求头里那些身份来源，整个文件都不该碰
    for (const bad of ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip']) {
      expect(code, `不该读 ${bad}`).not.toContain(bad);
    }
  });

  it('🔒 绝不抛（它挂在真实请求路径上）', () => {
    const src = read('lib/geo/crawler-log.ts');
    const i = src.indexOf('await prisma.aiCrawlerHit.upsert');
    expect(i).toBeGreaterThan(0);
    expect(src.slice(Math.max(0, i - 300), i)).toContain('try {');
  });

  it('🔒 用 upsert 而不是先查再写（爬虫并发来会撞唯一键）', () => {
    expect(read('lib/geo/crawler-log.ts')).toContain('aiCrawlerHit.upsert');
  });

  it('🔒 按北京时间分日（容器跑 UTC，按 UTC 分会把清晨算进前一天）', () => {
    expect(read('lib/geo/crawler-log.ts')).toContain('beijingDayKey');
  });

  it('有留存期且接进了每日清理（只增不减的表迟早最大）', () => {
    expect(CRAWLER_HIT_RETENTION_DAYS).toBeGreaterThan(0);
    const r = read('lib/legal/retention.ts');
    expect(r).toContain('purgeExpiredCrawlerHits');
    expect(read('lib/jobs/handlers.ts')).toContain('爬虫计数 ${r.crawlerHits}');
  });
});

describe('界面：看得见，且不会被误读', () => {
  const page = read('app/(ops)/ops/health/page.tsx');

  it('🔒 说清是「别人抓我们」而不是「我们抓别人」', () => {
    expect(page).toContain('别人来抓我们');
  });

  it('🔒 用途要显示（拦错哪一档代价完全不同）', () => {
    expect(page).toContain('PURPOSE_LABEL');
  });

  it('🔒 「没来过」与「认不出」分开显示', () => {
    expect(page).toContain('认得但没来过');
    expect(page).toContain('认不出的');
    expect(page).toContain('这是「我们不知道」，不是「它们没来」');
  });

  it('🔒 一条都没有时也要说明白（空态不是「还没统计」）', () => {
    expect(page).toContain('不是「还没统计」');
  });

  it('单列「来过几天」（一天一千次和三十天各一次是两回事）', () => {
    expect(page).toContain('来过几天');
  });
});

describe('加表清单：漏过的每一项', () => {
  it('两份 schema 都有', () => {
    expect(read('prisma/schema.prisma')).toContain('model AiCrawlerHit');
    expect(read('prisma/schema.postgres.prisma')).toContain('model AiCrawlerHit');
  });

  it('有建表 SQL，且唯一键在（没有它 upsert 就没有落点）', () => {
    const sql = read('prisma/postgres/41-ai-crawler-hit.sql');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS beacon."AiCrawlerHit"');
    expect(sql).toContain('AiCrawlerHit_agent_path_day_key');
  });

  it('🔒 全局表：不进 RLS 名单，也不进数据导出（它不是「用户配的东西」）', () => {
    expect(read('prisma/postgres/02-rls.sql')).not.toContain('AiCrawlerHit');
    expect(read('lib/account/export.ts')).not.toContain('aiCrawlerHit');
  });
});

describe('记录点：只挂在爬虫真会去的地方', () => {
  it('🔒 robots.txt / sitemap.xml / 公开内容页三处都记', () => {
    // robots 与 sitemap 是**只有爬虫会读**的端点，信号最干净；
    // 但它们回答的是「谁来看规则」，只有内容页才回答「谁真的来读内容」——
    // 而后者才是 GEO 上要紧的那个问题。三处都要，缺内容页就等于只知道谁路过。
    expect(read('app/robots.ts')).toContain("recordCrawlerHitAsync(h.get('user-agent'), '/robots.txt')");
    expect(read('app/sitemap.ts')).toContain("recordCrawlerHitAsync(h.get('user-agent'), '/sitemap.xml')");
    expect(read('app/(public)/hotlists/page.tsx')).toContain("recordCrawlerHitAsync(h.get('user-agent'), '/hotlists')");
  });

  it('🔒 三处都包了 try（构建期预渲染没有请求头，抛了就整页挂）', () => {
    for (const f of ['app/robots.ts', 'app/sitemap.ts', 'app/(public)/hotlists/page.tsx']) {
      const src = read(f);
      // 【锚在调用形态上，不是裸函数名】裸名 indexOf 找到的第一个是 import 那一行，
      // 它前面 200 字符里当然没有 try —— 本会话第三次栽在同一个形状上了。
      const i = src.indexOf("recordCrawlerHitAsync(h.get");
      expect(i, `${f} 里找不到调用点`).toBeGreaterThan(0);
      const before = src.slice(Math.max(0, i - 200), i);
      expect(before, `${f} 没有包 try`).toContain('try {');
    }
  });

  it('🔒 用的是不等待的那个（等它 = 让统计挡在用户和页面之间）', () => {
    for (const f of ['app/robots.ts', 'app/sitemap.ts', 'app/(public)/hotlists/page.tsx']) {
      expect(read(f), `${f} 不该 await 统计`).not.toContain('await recordCrawlerHit(');
    }
  });
});

// ── llms.txt（2026-08-29，学自 GEOFlow）────────────────────────────────
//
// robots.txt 说「可不可以读」，sitemap.xml 说「有哪些页」，
// llms.txt 说「这个站是干什么的、哪几页值得读」。前两个给爬虫，这个给模型。
describe('llms.txt', () => {
  const txt = buildLlmsTxt();

  it('🔒 每一页都写了「这一页有什么」（只给链接的话它和 sitemap 没区别）', () => {
    for (const p of PUBLIC_PAGES) {
      expect(p.desc.length, `${p.path} 没写说明`).toBeGreaterThan(4);
      expect(txt).toContain(p.desc);
    }
  });

  it('🔒 llms.txt 里的每一页都必须是 robots 放行的（三个文件同源的真正判据）', () => {
    // 这条才是「不漂移」的保证：新加一个公开页却忘了在 robots 里放行，
    // 三个文件各自都合法，只是互相矛盾——而那不会报错
    for (const p of PUBLIC_PAGES) {
      expect(allowedByRobots(p.path), `${p.path} 在 llms.txt 里，却没被 robots 放行`).toBe(true);
    }
  });

  it('🔒 前缀匹配要落在边界上（/legal 覆盖 /legal/privacy，但不覆盖 /legalese）', () => {
    expect(allowedByRobots('/legal/privacy')).toBe(true);
    expect(allowedByRobots('/legal')).toBe(true);
    expect(allowedByRobots('/legalese')).toBe(false);
    expect(allowedByRobots('/topics')).toBe(false);
  });

  it('🔒 绝不列需要登录的业务页（列了既没用，又等于公布内部路由结构）', () => {
    for (const secret of ['/topics', '/studio', '/data', '/settings', '/ops', '/runs', '/skills']) {
      expect(txt, `llms.txt 里出现了业务页 ${secret}`).not.toContain(`${secret})`);
    }
  });

  it('有一句说清这个站是什么（含糊的一句等于什么都没说）', () => {
    const summary = txt.split('\n').find((l) => l.startsWith('> '));
    expect(summary, '没有简介那一行').toBeTruthy();
    expect(summary!.length).toBeGreaterThan(40);
    // 「领先的一站式智能平台」这类话是 llms.txt 最常见的写法，也是最没用的
    for (const empty of ['领先的', '一站式', '赋能', '全方位']) {
      expect(summary, `简介里出现了空话「${empty}」`).not.toContain(empty);
    }
  });

  it('指回 robots.txt 与 sitemap.xml（三份各司其职，别互相取代）', () => {
    expect(txt).toContain('/robots.txt');
    expect(txt).toContain('/sitemap.xml');
  });

  it('🔒 /llms.txt 自己也进爬虫计数——「到底有没有引擎读它」要用自己的数据回答', () => {
    // llms.txt 是没有任何引擎公开承诺会读的社区提案。照着发一份是没有回报保证的投入；
    // 把它接进计数，几个月后这个问题就有答案了，而不是继续引用别人的猜测
    const route = read('app/llms.txt/route.ts');
    expect(route).toContain("recordCrawlerHitAsync(h.get('user-agent'), '/llms.txt')");
    expect(read('lib/geo/llms-txt.ts')).toContain('没有任何一家引擎公开承诺会读它');
  });
});

// ── AI 引用回执 ─────────────────────────────────────────────────────
describe('引用回执：归属只认精确匹配', () => {
  const src = read('lib/geo/citation.ts');

  it('🔒 认不出作品 ID 的一律不收（绝不按 host 猜）', () => {
    // mp.weixin.qq.com 是全国所有公众号共用的域名，按 host 判 = 把别人的文章算成你的
    const cands = extractCitations([
      { href: 'https://mp.weixin.qq.com/', text: '公众号首页' },
      { href: 'https://www.douyin.com/user/abc', text: '某个主页' },
      { href: 'https://example.com/news/1', text: '新闻站' },
    ]);
    expect(cands).toEqual([]);
  });

  it('认得出的作品链接才进候选，且按 (平台, 作品ID) 去重', () => {
    const cands = extractCitations([
      { href: 'https://www.douyin.com/video/7412345678901234567', text: 'A' },
      { href: 'https://www.douyin.com/video/7412345678901234567?from=x', text: 'A 重复' },
    ]);
    expect(cands.length).toBe(1);
    expect(cands[0].platform).toBe('douyin');
  });

  it('🔒 归属比对必须带上平台（抖音与 TikTok 的 id 形态一模一样）', () => {
    expect(src).toContain('`${c.platform}:${c.platformItemId}`');
    expect(src).toContain('parsePublishUrl');
  });

  it('🔒 没命中就是「不是」，不存在「可能是」', () => {
    expect(src).toContain('matchedRecordId: hit?.id ?? null');
    expect(src).not.toMatch(/maybe|probably|likely/i);
  });

  it('🔒 不出百分比（n=1 印成「引用率 33%」是这条路上最难发现的错）', () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const bad of ['%', 'rate', 'percent', 'ratio', 'share']) {
      expect(code, `引用回执里不该出现 ${bad}`).not.toContain(bad);
    }
    const tools = read('lib/agent/tools-local.ts');
    const i = tools.indexOf('const recordCitationTool');
    const body = tools.slice(i, tools.indexOf('const exportScriptTool'));
    expect(body).not.toContain('%');
  });

  it('🔒 明确不做「被引作者榜」（那会变成盯同行的东西，不是帮你写下一篇）', () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('author');
    expect(code).not.toContain('rank');
  });
});

describe('引用回执：元宝那条路是它自己关上的', () => {
  it('🔒 元宝标为禁止，且说清是它的 robots 不让', () => {
    const yb = AI_ANSWER_SITES.find((s) => s.engine.includes('元宝'));
    expect(yb).toBeTruthy();
    expect(yb!.expectBlocked).toBe(true);
    expect(yb!.robotsNote).toContain('Disallow: /chat/');
  });

  it('豆包不禁止', () => {
    const db = AI_ANSWER_SITES.find((s) => s.engine.includes('豆包'));
    expect(db?.expectBlocked).toBe(false);
  });

  it('🔒 提前拦下并说明白，而不是让用户等一个失败', () => {
    const tools = read('lib/agent/tools-local.ts');
    expect(tools).toContain('site?.expectBlocked');
    expect(tools).toContain('我们不绕 robots');
  });

  it('域名匹配认子域，但不认后缀冒充', () => {
    expect(answerSiteOf('https://www.doubao.com/chat/x')?.engine).toContain('豆包');
    expect(answerSiteOf('https://doubao.com.evil.net/x')).toBeNull();
  });

  it('🔒 「读到了但没有引用」与「读失败」必须分得开', () => {
    const tools = read('lib/agent/tools-local.ts');
    expect(tools).toContain('**这不是失败**');
  });

  it('🔒 工具描述里写明不替用户提问（既有红线）', () => {
    const tools = read('lib/agent/tools-local.ts');
    expect(tools).toContain('不会替用户提问');
  });
});

describe('引用回执：只在这个用途下取链接', () => {
  it('🔒 collectLinks 默认关（骨架刻意不含链接是它的隐私设计）', () => {
    const src = read('lib/browser/local.ts');
    expect(src).toContain('collectLinks?: boolean');
    expect(src).toContain('if (options.collectLinks) {');
    // 只有引用回执这一个调用点会打开它
    const tools = read('lib/agent/tools-local.ts');
    expect((tools.match(/collectLinks: true/g) ?? []).length).toBe(1);
  });

  it('🔒 只取站外链接（同源的是它自己的导航，不是「它引用了谁」）', () => {
    expect(read('lib/browser/local.ts')).toContain('if (u.origin === here) continue;');
  });

  it('加表清单：两份 schema + SQL + RLS 名单 + 数据导出', () => {
    expect(read('prisma/schema.prisma')).toContain('model AiCitation');
    expect(read('prisma/schema.postgres.prisma')).toContain('model AiCitation');
    expect(read('prisma/postgres/42-ai-citation.sql')).toContain('beacon."AiCitation"');
    // 这张**带 workspaceId**，是租户数据 → 要 RLS、要进导出（与 AiCrawlerHit 相反）
    expect(read('prisma/postgres/02-rls.sql')).toContain("'AiCitation'");
    expect(read('lib/account/export.ts')).toContain('prisma.aiCitation.findMany');
  });
});

describe('引用回执：界面', () => {
  const card = read('components/insight/CitationCard.tsx');

  it('🔒 卡上不出现任何百分比（永远是样本不是统计）', () => {
    // 【先剥注释】文件头的说明里正举着「引用率 33%」当反例——
    // 不剥的话这条断言被自己的注释绊倒。本会话第 N 次了，剥注释应该成为默认动作。
    const code = card.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('%');
    expect(code).not.toContain('引用率');
    // 【不再断言那段注释在不在】写过一条 toContain('永远是样本不是统计')，
    // 被项目自己的 fake-green-guard 判为假绿——它守的是注释，代码怎么改都绿。
    // 真正的保证是上面那两条：剥掉注释之后，代码与文案里一个百分号都没有。
  });

  it('🔒 一条自己的都没有时，明说这推不出「你从不被引用」', () => {
    expect(card).toContain('这不能推出');
  });

  it('🔒 读不了的引擎要说破是它自己禁的（否则表现成「点了没反应」）', () => {
    expect(card).toContain('自己禁止抓取对话页');
    expect(card).toContain('不是这里坏了');
  });

  it('🔒 界面上重申不替用户提问', () => {
    expect(card).toContain('不会替你向任何 AI 提问');
  });

  it('🔒 紧挨着第三方那张卡（校准要靠并排看）', () => {
    const page = read('app/(app)/data/page.tsx');
    const algo = page.indexOf('<AlgorithmPanel');
    const cite = page.indexOf('<CitationSection');
    expect(algo).toBeGreaterThan(0);
    expect(cite).toBeGreaterThan(algo);
  });

  it('🔒 按 workspaceId 圈定（别的工作区的引用不该出现在这里）', () => {
    const page = read('app/(app)/data/page.tsx');
    const i = page.indexOf('async function CitationSection');
    const body = page.slice(i, i + 1200);
    expect((body.match(/workspaceId: s\.workspaceId/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('引用回执：权限', () => {
  it('🔒 会写库的工具不能挂在只读权限上（本轮真踩了一次）', () => {
    const src = read('lib/agent/tools-local.ts');
    const i = src.indexOf("name: 'record_ai_citation'");
    const head = src.slice(i, i + 700);
    // 配成 content.view 的话，viewer（有 content.view）就拿到了一个会写库的工具
    expect(head).toContain("action: 'content.create'");
    expect(head).toContain('write: true');
    expect(head).not.toContain("action: 'content.view'");
  });
});

// ── 「写了没接」自查（2026-08-29）────────────────────────────────────────
//
// 这个项目反复栽在同一件事上：写了一个函数/常量，却没有任何调用点。
// 它不报错、测试也可能是绿的（测试自己在调），只是**那个能力在产品里不存在**。
// 本轮自查查出 5 条，下面逐条钉住修好后的状态。
describe('写了就得接上', () => {
  it('🔒 vetChannel 真的在落库路径上（原来只有测试在调）', () => {
    expect(read('lib/scrape/record.ts')).toContain('channel: vetChannel(input.channel)');
  });

  it('🔒 robots.ts 用现成的谓词，不再自己写一遍 kind 判断', () => {
    const src = read('app/robots.ts');
    expect(src).toContain('realCrawlers()');
    expect(src).toContain('robotsTokens()');
    // 【先剥注释】我在 robots.ts 里写的说明**正好**含有 `kind === 'crawler'` 这个字符串
    //（那句话是「别在这里再写一遍」）——不剥的话这条断言被自己的注释绊倒。
    // 这是本会话第 N 次同一形状了，剥注释必须是写源码断言时的第一个动作。
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain("kind === 'crawler'");
    expect(code).not.toContain("kind === 'robots_token'");
  });

  it('🔒 allowedByRobots 在运行时也过一遍，不只在测试里', () => {
    const src = read('lib/geo/llms-txt.ts');
    expect(src).toContain('if (!allowedByRobots(p.path)) continue;');
  });

  it('🔒 校准日期看得见，且过期会提醒', () => {
    // 一张带「下次校准日期」却从不提醒的表，到期后不会变红，
    // 只会安静地继续用一份已经不成立的清单做拦截决定
    const page = read('app/(ops)/ops/health/page.tsx');
    expect(page).toContain('AI_CRAWLER_NEXT_REVIEW');
    expect(page).toContain('这张表已经过了校准日期');
  });

  it('🔒 每条爬虫的官方文档出处点得开', () => {
    // 出处查不到的话，「这个名字哪来的、还准不准」半年后没人敢改
    const page = read('app/(ops)/ops/health/page.tsx');
    expect(page).toContain('findAgent(c.agent)');
    expect(page).toContain('href={a.doc}');
  });
});

describe('llms.txt 运行时也守住不变量', () => {
  it('未被 robots 放行的页面不会出现在产出里', () => {
    // 真跑一次：产出里的每一行链接，其路径都必须是 robots 放行的
    const txt = buildLlmsTxt();
    const paths = [...txt.matchAll(/\]\(https?:\/\/[^/]+([^)]*)\)/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(allowedByRobots(p), `${p} 出现在 llms.txt 里，却没被 robots 放行`).toBe(true);
    }
  });
});
