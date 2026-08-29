import { describe, it, expect, vi, afterEach } from 'vitest';
import { complianceCheck, robotsAllows, vetOrigin, recipeUrl, RECIPE_BROKEN_AT, MAX_RECIPES_PER_WORKSPACE } from '@/lib/scrape/recipe';
import { vetCdpUrl } from '@/lib/browser/local';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 任意站点采集配方（2026-08-29）。
//
// 这一层的风险不在「抓不到」，在「抓了不该抓的」——已有的采集合规是**按平台预先审过**的，
// 任意站点没法预审，所以判据必须是机器闸，不能只写在文档里。
// 这个项目在别处栽过一次：评论「两人以上才留存」写在隐私政策里、代码里没有。

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

afterEach(() => vi.unstubAllGlobals());

describe('合规闸：哪些站点一律不采', () => {
  it.each([
    'https://www.beijing.gov.cn',
    'https://x.mil.cn',
    'https://lib.tsinghua.edu.cn',
  ])('%s 拒绝', (u) => {
    expect(complianceCheck(u).ok).toBe(false);
  });

  it.each([
    'https://www.icbc-bank.com',
    'https://hospital.example.com',
    'https://kyfw.12306.cn',
  ])('%s 拒绝（医疗／金融／票务）', (u) => {
    expect(complianceCheck(u).ok).toBe(false);
  });

  it('按域名分段比，不是子串包含（notgov.cn.evil.com 不该被当成政务站误杀）', () => {
    expect(complianceCheck('https://notgov.cn.evil.com').ok).toBe(true);
    // 但真正的子域要拦住
    expect(complianceCheck('https://data.beijing.gov.cn').ok).toBe(false);
  });

  it('普通站点放行', () => {
    expect(complianceCheck('https://www.xiaohongshu.com').ok).toBe(true);
  });

  it('非 http(s) 一律拒绝（file:// 能读本机文件）', () => {
    expect(complianceCheck('file:///etc/passwd').ok).toBe(false);
    expect(complianceCheck('不是网址').ok).toBe(false);
  });
});

describe('robots.txt 是真去读的，不是写在说明里', () => {
  it('Disallow 命中就拒绝', async () => {
    vi.stubGlobal('fetch', async () => new Response('User-agent: *\nDisallow: /explore', { status: 200 }));
    const r = await robotsAllows('https://example.com', '/explore/123');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('robots.txt');
  });

  it('只认 User-agent:* 那一段，别家的规则不套到自己头上', async () => {
    vi.stubGlobal('fetch', async () => new Response('User-agent: BadBot\nDisallow: /\n\nUser-agent: *\nAllow: /', { status: 200 }));
    expect((await robotsAllows('https://example.com', '/any')).ok).toBe(true);
  });

  it('读不到（404 / 超时）按允许处理——网络故障不该把正常采集永久卡死', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
    expect((await robotsAllows('https://example.com', '/x')).ok).toBe(true);
    vi.stubGlobal('fetch', async () => { throw new Error('timeout'); });
    expect((await robotsAllows('https://example.com', '/x')).ok).toBe(true);
  });

  it('robots 放行也救不了黑名单域名（两道闸是与，不是或）', async () => {
    vi.stubGlobal('fetch', async () => new Response('User-agent: *\nAllow: /', { status: 200 }));
    expect((await vetOrigin('https://www.beijing.gov.cn', '/')).ok).toBe(false);
  });
});

describe('学到的规则必须过机器验证', () => {
  const src = read('lib/scrape/recipe.ts');

  it('复用 verifyAgainstSkeleton，不另造一套验证', () => {
    expect(src).toContain("import { verifyAgainstSkeleton");
    expect(src).toContain('const v = verifyAgainstSkeleton(');
  });

  it('一条都没过验证时不落库（宁可字段空着，也不要一条会抓到隔壁数字的规则）', () => {
    expect(src).toContain("if (verified.length === 0) {");
    expect(src).toContain('这一版不落库');
  });

  it('客户端上传的骨架服务端再脱敏一次', () => {
    expect(src).toContain('serializeSkeleton(sanitizeSkeleton(input.skeleton))');
  });

  it('示例模型不许产出规则', () => {
    expect(src).toContain('if (r.mocked)');
  });
});

describe('进化：连续失败才算坏', () => {
  it('阈值不是 1（网络抖动也会失败一次）', () => {
    expect(RECIPE_BROKEN_AT).toBeGreaterThan(1);
  });

  it('成功是清零而不是递减（递减会让时好时坏的配方永远卡在中间态）', () => {
    expect(read('lib/scrape/recipe.ts')).toContain('data: { failCount: 0, status: \'active\', lastOkAt: new Date() }');
  });
});

describe('落库与隔离', () => {
  it('两份 schema 都有 ScrapeRecipe', () => {
    for (const f of ['prisma/schema.prisma', 'prisma/schema.postgres.prisma']) {
      expect(read(f)).toContain('model ScrapeRecipe');
    }
  });
  it('RLS 名单里有它', () => {
    expect(read('prisma/postgres/02-rls.sql')).toContain("'ScrapeRecipe'");
  });
});

// ── 插件侧（0.9.11）────────────────────────────────────────────────────
// 这一层的判据只能是源码级：Chrome 扩展跑不进 vitest。
// 但每一条都对应一个**改了就会出事、而且不报错**的点。
describe('插件：任意站点的权限与执行', () => {
  const mf = JSON.parse(read('extension/manifest.json')) as {
    version: string; host_permissions: string[]; optional_host_permissions?: string[];
  };
  const sw = read('extension/sw.js');
  const runner = read('extension/tools/recipe-run.js');

  it('绝不把 <all_urls> 写进 host_permissions', () => {
    // 写进去，装机提示就变成「读取和更改你在所有网站上的数据」，且 Chrome 审核极严。
    // 任意站点必须走 optional_host_permissions：安装时不授予，用户当场按站点点允许。
    expect(mf.host_permissions.some((h) => h.includes('<all_urls>') || h === '*://*/*')).toBe(false);
    expect(mf.optional_host_permissions ?? []).toContain('https://*/*');
  });

  it('没授权就什么都不做，且授权只能由用户手势触发', () => {
    expect(sw).toContain('async function hasSiteGrant(origin)');
    // runRecipeOnTab 里只能「查」权限，不能「求」权限——偷偷申请会被 Chrome 直接拒绝，
    // 而且那等于绕过用户点击这一关
    const body = sw.slice(sw.indexOf('async function runRecipeOnTab'), sw.indexOf('// ── 一键发布'));
    expect(body).toContain('hasSiteGrant');
    expect(body).not.toContain('permissions.request');
  });

  it('只挂一个 onMessage（多挂一个会把主通道顶掉）', () => {
    expect(sw.split('onMessage.addListener').length - 1).toBe(1);
  });

  it('取不到就交骨架去学，不猜值', () => {
    expect(runner).toContain("return { ok: false, mode: 'stale', skeleton: skeleton(document.body) };");
    expect(runner).toContain("if (recipe.status !== 'active'");
  });

  it('锚点法只取紧邻文本（全局搜会把关注数当成粉丝数——这事故真发生过）', () => {
    // 断言落在**真代码**上：只看紧邻的三个节点，且限制长度。
    // （第一版这里断言的是注释里的「全局搜」三个字——守的是注释，代码怎么改都绿，
    //   被 tests/fake-green-guard.test.ts 当场抓住。）
    expect(runner).toContain('[host.nextElementSibling, host.previousElementSibling, host.parentElement]');
    expect(runner).toContain('.find((t) => t && t.length < 60)');
  });

  it('骨架不含真实内容（只有标签、类名、属性名、文本形状）', () => {
    expect(runner).toContain("if (/^[\\d.,%万千亿]+$/.test(t)) return 'NUM';");
    // 绝不能把 textContent 原样塞进骨架
    expect(runner).not.toMatch(/text:\s*\[?\s*el\.textContent/);
  });
});

// ── 本机浏览器驱动（2026-08-29）─────────────────────────────────────────
// 这条路直接连用户真实的 Chrome，能力比插件大得多（能读所有标签、能点能填）。
// 所以每一条边界都要能证明在，而不是「我们不会那么做」。
describe('本机浏览器：调试端点只能指向本机', () => {
  it('远程地址一律拒绝（填远程等于连到别人机器上的浏览器，那是另一件事）', () => {
    for (const u of ['http://10.0.0.5:9222', 'http://evil.com:9222', 'https://127.0.0.1:9222']) {
      expect(vetCdpUrl(u).ok, u).toBe(false);
    }
  });
  it('本机地址放行', () => {
    expect(vetCdpUrl('http://127.0.0.1:9222').ok).toBe(true);
    expect(vetCdpUrl('http://localhost:9222').ok).toBe(true);
  });
  it('没配就是关闭（不另设开关，少一个会和实际状态对不上的字段）', () => {
    expect(vetCdpUrl(null).ok).toBe(false);
    expect(vetCdpUrl('').ok).toBe(false);
  });
});

describe('本机浏览器：五条边界都在源码里立得住', () => {
  const src = read('lib/browser/local.ts');
  const ed = read('lib/edition.ts');

  it('SaaS 恒关', () => {
    const saas = ed.slice(ed.indexOf('saas: {'), ed.indexOf('appliance: {'));
    expect(saas).toContain('localBrowser: false');
  });

  it('用用户自己的上下文（才有登录态），但只新开 page、不遍历已有标签', () => {
    expect(src).toContain('const ctx = browser.contexts()[0] ?? (await browser.newContext());');
    expect(src).toContain('await ctx.newPage()');
    // 遍历已有页面 = 能读到用户的网银/邮箱，绝不允许出现
    expect(src).not.toMatch(/ctx\.pages\(\)|context\.pages\(\)/);
  });

  it('只读：不点击、不输入、不提交', () => {
    for (const forbidden of ['.click(', '.fill(', '.type(', '.press(']) {
      expect(src, `本机浏览器不该出现 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('导航前过合规闸（换了通道不等于放松判据）', () => {
    expect(src).toContain('const c = complianceCheck(origin);');
    expect(src).toContain('const r = await robotsAllows(origin, path);');
  });

  it('只断开连接，不关用户的浏览器', () => {
    expect(src).toContain('// 只断开连接，**不关用户的浏览器**');
    expect(src).toContain('await browser.close().catch');
  });
});

describe('登录墙：认出来、跳过、只通知一次', () => {
  const src = read('lib/browser/local.ts');
  const rec = read('lib/scrape/recipe.ts');

  it('三条独立信号都在（只看密码框会漏掉弹层与整页跳转）', () => {
    expect(src).toContain('login|signin|sign-in|auth|passport');
    expect(src).toContain("querySelector('input[type=password]')");
    expect(src).toContain('请先登录|登录后查看|需要登录');
  });

  it('认出登录墙就不往下学（否则会照着登录页学出一堆规则）', () => {
    // 锚点用 LOGIN_WALL_FN 的首次出现位置，不写死 const/let——
    // 2026-08-29 加「前台等登录」时把 const 改成了 let，写死声明关键字的锚点当场失效
    const i = src.indexOf('await page.evaluate(LOGIN_WALL_FN)');
    const j = src.indexOf('const rawSkeleton = await page.evaluate(SKELETON_FN)');
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i); // 判据必须在取骨架**之前**
    expect(src.slice(i, j)).toContain('return {');
  });

  it('needs_login 不计进 failCount（不是配方坏了，是浏览器没登录）', () => {
    const i = rec.indexOf('export async function markNeedsLogin');
    const body = rec.slice(i, rec.indexOf('export async function recordScrapeResult'));
    expect(body).toContain("status: 'needs_login'");
    expect(body).not.toContain('failCount:');
  });

  it('只在状态第一次变成 needs_login 时通知（每次都通知=每日刷屏）', () => {
    expect(rec).toContain("const first = cur.status !== 'needs_login';");
    expect(rec).toContain('if (first) {');
    expect(rec).toContain('refId: `recipe-login:${recipeId}`');
  });

  it('绝不替用户输入凭据', () => {
    // 整个本机浏览器模块里不该出现任何填表动作（上面 .fill/.type 已断言），
    // 文案上也要明说这件事不做，免得用户等着它替自己登录
    // 这句是**用户可见的报错文案**（不是注释），落在 local.ts 的登录墙分支里
    expect(src).toContain('我不会替你输入账号密码');
  });
});

describe('设置界面：配得上才用得上', () => {
  it('端点在保存时就过闸，而不是等真去连的时候', () => {
    const act = read('app/(app)/settings/shell-actions.ts');
    expect(act).toContain('const v = vetCdpUrl(cdpRaw);');
    expect(act).toContain("if (!can('localBrowser'))");
  });
  it('SaaS 上连这张卡都不渲染（看得见却永远开不了只会让人反复来问）', () => {
    expect(read('app/(app)/settings/page.tsx')).toContain("canBrowser={canEdition('localBrowser')}");
  });
  it('界面上明说不会替用户输密码', () => {
    expect(read('app/(app)/settings/LocalShellCard.tsx')).toContain('不会替你输入账号密码');
  });
});

describe('登录墙：带他到登录页，但那一步永远由他自己完成', () => {
  const src = read('lib/browser/local.ts');
  const tools = read('lib/agent/tools.ts');

  it('把页面推到前台（别让用户自己再找一遍网址）', () => {
    expect(src).toContain('await page.bringToFront()');
  });

  it('等待有硬上限，且上限在函数内部再夹一次（调用方传 99999 也没用）', () => {
    expect(src).toContain('Math.min(waitForLoginSec, 300) * 1000');
    expect(tools).toContain('Math.min(Math.max(Number(args.waitLoginSec ?? 90) || 0, 0), 300)');
  });

  it('登录墙那一页留着不关（关掉用户回来又得自己找网址）', () => {
    expect(src).toContain('leaveOpen = true;');
    expect(src).toContain('if (!leaveOpen) await page.close()');
  });

  it('等待期间反复重判，登完自动继续', () => {
    const i = src.indexOf('const deadline = Date.now()');
    const j = src.indexOf('if (wall.walled) {', i);
    const loop = src.slice(i, j);
    expect(loop).toContain('while (Date.now() < deadline)');
    expect(loop).toContain('LOGIN_WALL_FN');
    expect(loop).toContain('if (!wall.walled) break;');
  });

  it('上层用结构化字段判登录墙，不靠匹配报错文案', () => {
    // 靠 error.includes('要求登录') 的话，文案改一个字判据就悄悄失效
    expect(tools).toContain('if (recipe && page.needsLogin) {');
    expect(tools).not.toContain("page.error.includes('要求登录')");
  });

  it('即使推到前台等着，也仍然不碰凭据', () => {
    for (const forbidden of ['.click(', '.fill(', '.type(', '.press(']) {
      expect(src, `不该出现 ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// ── 定时批量跑（2026-08-29）─────────────────────────────────────────────
// 用户：「定时批量跑，每跑一次记住这个流程；除了卡住了要重新优化，其余不重新学习」。
// 关键在「什么时候才算卡住」——判错了要么白烧模型调用，要么半坏状态一直悄悄错下去。
describe('定时扫描：只有真卡住才重学', () => {
  const src = read('lib/scrape/sweep.ts');

  it('取到值了就不重学，哪怕它此刻标着 broken', () => {
    // 第一版写的是 `got === 0 || r.status === 'broken'`——一个已经恢复的配方
    // 每轮都被重学一遍，白烧调用还可能越学越差
    expect(src).not.toMatch(/got === 0 \|\| r\.status === 'broken'/);
    expect(src).toContain('if (got === 0) {');
  });

  it('部分字段缺失也不算跑好（页面照常出数、只是少了几列，是最难发现的坏）', () => {
    expect(src).toContain('await recordScrapeResult(r.id, ws.id, got === want);');
  });

  it('无人值守绝不抢焦点', () => {
    expect(src).toContain('await browseLocal(vet.url!, url, rules, 0);');
    // 【必须先剥注释】文件头的说明里就写着「交互式那条路会 bringToFront」——
    // 直接全文匹配会被自己的注释绊倒（这轮第二次栽在同一件事上）
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('bringToFront');
  });

  it('待登录的直接跳过、不计失败（否则会把好配方推去重学）', () => {
    expect(src).toContain('if (page.needsLogin) { out.skipped += 1; }');
  });

  it('learning 状态的不在无人值守时学（没人看着，学错了没人拦）', () => {
    expect(src).toContain("status: { in: ['active', 'broken'] }");
  });

  it('SaaS 上直接空转', () => {
    expect(src).toContain("if (!can('localBrowser')) return out;");
  });

  it('配方之间留间隔、单轮有上限（别把用户的浏览器占太久）', () => {
    expect(src).toContain('await sleep(GAP_MS)');
    expect(src).toContain('take: SWEEP_MAX_RECIPES');
  });

  it('定时表里频率不高于每 6 小时（它会在用户浏览器里开标签，藏不住）', () => {
    const cfg = read('lib/jobs/schedule-config.ts');
    const line = cfg.split('\n').find((l) => l.includes('sweep_local_recipes'));
    expect(line).toBeTruthy();
    const m = /cron: '(\S+) \*\/(\d+) \* \* \*'/.exec(line!);
    expect(m, '应为「每 N 小时」的 cron').toBeTruthy();
    expect(Number(m![2])).toBeGreaterThanOrEqual(6);
  });
});

describe('装完就能用：客户端替用户起采集浏览器', () => {
  const rs = read('desktop/src-tauri/src/main.rs');
  const card = read('app/(app)/settings/LocalShellCard.tsx');

  it('托盘里有「启动采集浏览器」', () => {
    expect(rs).toContain('"启动采集浏览器"');
    expect(rs).toContain('fn launch_collect_browser');
  });

  it('用默认 profile（不传 --user-data-dir），否则每个站点都要重登一次', () => {
    // 2026-08-29 用户拍板：独立 profile 的干净不值得「每个站点重登一次」的代价，
    // 而采集的价值恰恰在于读登录后才看得见的内容
    expect(rs).not.toContain('--user-data-dir=');
  });

  it('Chrome 正开着时不硬启动，也不替用户杀进程', () => {
    // 运行中的 Chrome 无法再打开调试端口（Chrome 的限制），硬启动只会静默失败，
    // 用户会以为是我们坏了。而替他杀浏览器更不行——他可能开着几十个标签在干活。
    //
    // 【断言必须落在真分支上】第一版只验了「函数存在」和「文案存在」，
    // 把 `if chrome_running()` 改成 `if false` 两者都还在——mutation 当场证明它是假绿。
    const i = rs.indexOf('fn launch_collect_browser');
    const body = rs.slice(i, rs.indexOf('fn main()', i));
    const guardAt = body.indexOf('if chrome_running() {');
    const spawnAt = body.indexOf('.spawn()');
    expect(guardAt, '启动前必须先判 Chrome 在不在跑').toBeGreaterThan(-1);
    expect(spawnAt).toBeGreaterThan(guardAt); // 判据必须在 spawn **之前**
    expect(body.slice(guardAt, spawnAt)).toContain('return Err(');
    expect(rs).not.toMatch(/pkill|taskkill|killall/);
  });

  it('只在固定安装位置找浏览器，不去 PATH 里碰运气', () => {
    expect(rs).toContain('fn find_chrome');
    expect(rs).not.toMatch(/Command::new\("chrome"\)|which\s+chrome/);
  });

  it('成功失败都要让用户看见（静默失败=他以为点了没反应）', () => {
    const i = rs.indexOf('"collect" => {');
    const body = rs.slice(i, rs.indexOf('"quit" => app.exit(0)', i));
    expect(body).toContain('Err(e) => e');
    expect(body).toContain('window.alert');
  });

  it('设置页把两件必踩的事都说破了', () => {
    expect(card).toContain('已经开着的 Chrome 没法再打开调试端口');
    // 调试端口开着 = 本机任何程序都能驱动这个浏览器。用了默认 profile 之后
    // 这一条的影响更大（他所有登录态都在里面），更不能不说
    expect(card).toContain('任何本地程序');
    expect(card).toContain('启动采集浏览器');
  });
});

// ── 界面（2026-08-29 补）─────────────────────────────────────────────────
// 前一批只做了 AI 工具和插件接口，**界面上一个入口都没有**：用户看不到有哪些配方、
// 哪个坏了、哪个在等他登录，也没法手动跑一次。这是本会话第三次「加了能力没做界面」。
describe('配方界面', () => {
  const list = read('app/(app)/skills/RecipeList.tsx');
  const page = read('app/(app)/skills/page.tsx');
  const act = read('app/(app)/skills/recipe-actions.ts');

  it('技能页真的渲染了配方列表', () => {
    expect(page).toContain('<RecipeList items={recipes}');
    expect(page).toContain('prisma.scrapeRecipe.findMany');
  });

  it('四种状态都说人话，且每种都告诉用户下一步做什么', () => {
    for (const k of ['active', 'learning', 'broken', 'needs_login']) {
      expect(list, `状态 ${k} 没有对应文案`).toContain(`${k}:`);
    }
    expect(list).toContain('等你登录');
    expect(list).toContain('站点可能改版了');
  });

  it('云端版不给「跑一次」按钮（本机浏览器驱动只在整机版有）', () => {
    expect(page).toContain("canRun={canEdition('localBrowser')}");
    expect(list).toContain('{canRun && (');
  });

  it('服务端 action 自己再判一次形态与角色（界面判过不算数）', () => {
    expect(act).toContain("if (!can('localBrowser'))");
    expect(act).toContain("requireRole(s, 'content.create')");
  });

  it('删除按 workspaceId 圈定（跨工作区删不掉）', () => {
    expect(act).toContain('where: { id: recipeId, workspaceId: s.workspaceId }');
  });

  it('当场点的「跑一次」会等登录（人就在键盘前），定时跑不等', () => {
    expect(act).toContain('await browseLocal(vet.url!, url, rules, 90)');
    expect(read('lib/scrape/sweep.ts')).toContain('await browseLocal(vet.url!, url, rules, 0)');
  });
});

describe('定时任务不该在用不上的形态里留噪音', () => {
  it('能力关着时连运行记录都不建', () => {
    const h = read('lib/jobs/handlers.ts');
    const i = h.indexOf('sweep_local_recipes: async () => {');
    const body = h.slice(i, h.indexOf('purge_retention:', i));
    // 判据必须在 withRun **之前**，否则运行中心里每天多 4 条「扫了 0 个配方」
    const guardAt = body.indexOf("if (!editionCan('localBrowser'))");
    const runAt = body.indexOf('withRun(');
    expect(guardAt).toBeGreaterThan(-1);
    expect(runAt).toBeGreaterThan(guardAt);
  });
});

describe('拼网址：一处实现，三处共用', () => {
  it('尾部通配符削掉', () => {
    expect(recipeUrl('https://a.com', '/explore/*')).toBe('https://a.com/explore/');
  });
  it('中间通配符也要截断（只削尾部会拼出带 * 的非法地址）', () => {
    expect(recipeUrl('https://a.com', '/x/*/y')).toBe('https://a.com/x/');
  });
  it('空与 null 都安全', () => {
    expect(recipeUrl('https://a.com', null)).toBe('https://a.com');
    expect(recipeUrl('https://a.com', '')).toBe('https://a.com');
  });
  it('拼出来的一定是合法 URL', () => {
    for (const p of ['/explore/*', '/x/*/y', '/', '', null]) {
      expect(() => new URL(recipeUrl('https://a.com', p))).not.toThrow();
    }
  });

  it('三处调用点都走 helper，没人再自己拼', () => {
    // 2026-08-29：同一表达式散在三处，**其中导出脚本那处连尾部通配符都没削**——
    // 那份脚本是用户拿走自己用的东西，错在那里我们既看不见也修不了
    for (const f of ['lib/agent/tools.ts', 'lib/scrape/sweep.ts', 'app/(app)/skills/recipe-actions.ts']) {
      expect(read(f), `${f} 还在自己拼网址`).not.toMatch(/`\$\{r\.origin\}\$\{r\.pathPattern/);
      expect(read(f), `${f} 没用 recipeUrl`).toContain('recipeUrl(');
    }
  });
});

describe('连不上浏览器 ≠ 配方坏了', () => {
  const local = read('lib/browser/local.ts');
  const sweep = read('lib/scrape/sweep.ts');
  const act = read('app/(app)/skills/recipe-actions.ts');

  it('连接失败带独立标记，不混进普通报错', () => {
    // 不标出来的话，定时扫描给每个配方各记一次失败，约 18 小时后全部变「抓不到了」——
    // 而它们一个都没坏。用户看到一屏红色会去查站点改版，方向完全错
    expect(local).toContain('connectFailed: true,');
  });

  it('定时扫描连不上就整个工作区停手（后面的也一样连不上，继续跑纯属浪费）', () => {
    expect(sweep).toContain('if (page.connectFailed) {');
    const i = sweep.indexOf('if (page.connectFailed) {');
    const j = sweep.indexOf('if (page.needsLogin)', i);
    // 连接失败要在登录墙判据**之前**处理，且必须 break 而不是 continue
    expect(j).toBeGreaterThan(i);
    expect(sweep.slice(i, j)).toContain('break;');
  });

  it('界面那条路连不上时也不记失败', () => {
    expect(act).toContain('if (page.connectFailed) return { ok: false, error: page.error };');
  });

  it('不使用任何会真的关掉用户浏览器的调用', () => {
    // 【为什么不断言那句「实测过」的注释】守注释等于什么都没守——代码怎么改都绿，
    // 假绿守卫当场点名过。实测结论写在注释里当文档，守卫要落在真代码上：
    // 断开用的是 browser.close()（对 connectOverCDP 是断开连接，2026-08-29 实测确认），
    // 而不是 process.kill / 关标签遍历这类真会动用户浏览器的东西。
    expect(local).toContain('await browser.close().catch');
    expect(local).not.toMatch(/process\.kill|\.contexts\(\)\.forEach|for \(const c of browser\.contexts\(\)\)/);
  });
});

describe('并发与上限', () => {
  const local = read('lib/browser/local.ts');
  const sweep = read('lib/scrape/sweep.ts');
  const tools = read('lib/agent/tools.ts');

  it('定时扫描在有人用浏览器时整轮让位', () => {
    // 用户当场点的动作不该跟定时任务抢他的浏览器；跳过一轮的代价远小于「标签一下子弹出好几个」
    expect(sweep).toContain('if (isBrowserBusy()) return out;');
  });

  it('交互动作不等待也不让位（人在跟前，让他等十分钟是荒谬的）', () => {
    // browseLocal 自己不检查 busy，只置位——让位的责任在定时扫描那边
    const i = local.indexOf('export async function browseLocal');
    const body = local.slice(i, local.indexOf('export function buildScrapeScript'));
    expect(body).toContain('browserBusy = true;');
    expect(body).not.toContain('if (isBrowserBusy())');
  });

  it('连接失败也要复位（否则一次失败把定时扫描永久挡在门外）', () => {
    const i = local.indexOf('browserBusy = true;');
    const seg = local.slice(i, local.indexOf('export function buildScrapeScript'));
    // 置位之后的每条出口都要复位：catch 里一处、finally 里一处
    expect((seg.match(/browserBusy = false;/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('配方数量有上限，且在建之前判', () => {
    expect(MAX_RECIPES_PER_WORKSPACE).toBeGreaterThan(0);
    const i = tools.indexOf('const existing = await prisma.scrapeRecipe.count');
    const j = tools.indexOf('prisma.scrapeRecipe.create');
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i); // 判据必须在 create 之前
  });
});
