import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { between, orderedBefore, before } from '../helpers/anchor';
import {
  canonicalRemovalSite, isSiteRemovalRequested, purgeRemovedSiteData, SITE_KIND, SITE_PLATFORM,
} from '@/lib/legal/removal';

// 站点级停采（2026-08-29 补的欠账）。
//
// 【为什么是欠账】批二做「配方抓到的数落库」时，我在 PRD 里写了
// 「移除申请停采闸留给批四」——批四做完了却没做它。
// 于是有一段时间里：任意站点的内容被存进我们库里，而**站点权利人没有任何办法让我们停下来**。
// 这不是普通功能缺口，是对外承诺（隐私政策写着「遵守 robots、可申请移除」）兑现不了。
//
// 【与账号级的分界】账号级问「这个号的内容还采不采」，站点级问「这个域名还去不去」。
// 两者的主体、判据、执行动作全都不同，所以是第三个 kind 而不是复用 account。

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('域名归一：他写的和我们抓的必须落在同一个形状上', () => {
  it('去协议、去 www、转小写', () => {
    expect(canonicalRemovalSite('https://www.Example.com/a/b')).toBe('example.com');
    expect(canonicalRemovalSite('http://example.com')).toBe('example.com');
    expect(canonicalRemovalSite('example.com')).toBe('example.com');
    expect(canonicalRemovalSite('  EXAMPLE.COM  ')).toBe('example.com');
  });

  it('🔒 http 与 https、带不带 www 归到同一个（不归一这道闸就拦不住）', () => {
    const a = canonicalRemovalSite('https://www.example.com');
    const b = canonicalRemovalSite('http://example.com');
    expect(a).toBe(b);
  });

  it('空与垃圾输入不炸', () => {
    expect(canonicalRemovalSite('')).toBe('');
    expect(canonicalRemovalSite(null as unknown as string)).toBe('');
  });
});

describe('🔒 闸必须挂在**每一条**去到站点的路上', () => {
  it('建配方时判（vetOrigin）', () => {
    const src = read('lib/scrape/recipe.ts');
    const i = src.indexOf('export async function vetOrigin');
    const body = src.slice(i, i + 600);
    expect(body).toContain('isSiteRemovalRequested');
  });

  it('🔒 每次真去打开页面时也判（browseLocal）', () => {
    // 【这条才是关键】配方是一次性建的，停采申请是**后来**提的。
    // 只在建的时候判，等于「申请提交之后，已经建好的配方照抓不误」——闸形同虚设。
    const src = read('lib/browser/local.ts');
    expect(src).toContain('await isSiteRemovalRequested(origin)');
    // 且必须在真正导航之前
    const gate = src.indexOf('await isSiteRemovalRequested(origin)');
    const goto = src.indexOf('await page.goto(');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(goto);
  });

  it('两处说同一句话（三种不同的错会让用户以为是三个问题）', () => {
    expect(read('lib/scrape/recipe.ts')).toContain('SITE_STOPPED_REASON');
    expect(read('lib/browser/local.ts')).toContain('SITE_STOPPED_REASON');
  });

  it('🔒 pending 也停采（与账号级同一条纪律：宁可少采几天）', () => {
    const src = read('lib/legal/removal.ts');
    // isSiteRemovalRequested 用的是同一个 BLOCKING_STATUSES
    const i = src.indexOf('export async function isSiteRemovalRequested');
    expect(src.slice(i, i + 700)).toContain('status: { in: BLOCKING_STATUSES }');
    expect(src).toContain("const BLOCKING_STATUSES = ['pending', 'verified', 'removed']");
  });
});

describe('🔒 子域匹配要落在点分段边界上', () => {
  const src = read('lib/legal/removal.ts');

  it('绝不用裸 endsWith / includes 判域名', () => {
    const block = between(src, 'export async function isSiteRemovalRequested', 'export async function purgeRemovedSiteData')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // endsWith('example.com') 会把 notexample.com 也算进去 —— 那是拿一个人的权利停掉另一个人的站
    expect(block).not.toContain('endsWith(');
    expect(block).not.toContain('includes(');
    expect(block).toContain("parts.slice(-segs.length).join('.')");
  });

  it('purge 也按同一套判据（不能一边严一边松）', () => {
    const i = src.indexOf('function sameSiteOrSub');
    const body = src.slice(i, i + 400);
    expect(body).toContain("parts.slice(-segs.length).join('.')");
    expect(body).not.toContain('endsWith(');
  });

  it('🔒 purge 不用 SQL 的 contains 去筛 origin（那会让 notexample.com 一起中招）', () => {
    const i = src.indexOf('export async function purgeRemovedSiteData');
    const body = src.slice(i, i + 900);
    expect(body).not.toContain('contains:');
  });
});

describe('执行：删数据但不处置用户自己的资产', () => {
  const src = read('lib/legal/removal.ts');

  it('🔒 删采集记录，但配方只停不删', () => {
    const i = src.indexOf('export async function purgeRemovedSiteData');
    const body = src.slice(i, i + 1200);
    expect(body).toContain('scrapeRecord.deleteMany');
    expect(body).toContain("data: { status: 'stopped' }");
    // 配方是用户自己写的东西（他要抓哪几个字段），删掉等于处置第三方的资产
    expect(body).not.toContain('scrapeRecipe.deleteMany');
  });

  it('🔒 站点类不碰任何平台账号档案', () => {
    const i = src.indexOf('if (req.kind === SITE_KIND)');
    expect(i).toBeGreaterThan(0);
    const body = src.slice(i, src.indexOf('const purged = await purgeRemovedAccountData', i));
    expect(body).toContain('purgeRemovedSiteData');
    expect(body).toContain('accounts: 0');
    expect(body).not.toContain('purgeRemovedAccountData');
  });

  it('🔒 每日重扫要按 kind 分叉（不分的话站点申请是一条都删不掉的空转）', () => {
    const r = read('lib/legal/retention.ts');
    expect(r).toContain('kind: true');
    expect(r).toContain('if (req.kind === SITE_KIND)');
  });

  it('🔒 AI 引用回执要在删作品**之前**清（删完就查不出哪些指向它了）', () => {
    orderedBefore(src, 'const itemIds = ', 'await prisma.competitorAccount.delete(');
    expect(between(src, 'const itemIds = ', 'await prisma.competitorAccount.delete(')).toContain('aiCitation.deleteMany');
  });
});

describe('申请页：闸没人能触发就不叫权利', () => {
  const form = read('app/(public)/legal/data-request/DataRequestForm.tsx');
  const action = read('app/(public)/legal/data-request/actions.ts');

  it('表单上真的能选「我是网站权利人」', () => {
    expect(form).toContain('我是某个网站的权利人');
    expect(form).toContain("value=\"site\"");
  });

  it('🔒 站点类不选平台（硬选一个只会往库里灌噪音）', () => {
    expect(form).toContain('{!isSite && (');
    expect(action).toContain('kind !== SITE_KIND && !VALID_PLATFORMS.has(platform)');
  });

  it('🔒 kind 仍是白名单三选一，不是「不是别的就当 account」', () => {
    // 拼错的值静默变成权限更大的那一类，是典型 fail-open
    expect(action).toContain("input.kind === SITE_KIND ? SITE_KIND");
    expect(action).toContain('ACCOUNT_KIND;');
  });

  it('🔒 入库前归一到主机名，platform 固定为标记值', () => {
    expect(action).toContain('canonicalRemovalSite(handle)');
    expect(action).toContain('platform: SITE_PLATFORM');
  });

  it('认不出域名要明确报错，而不是存一条永远匹配不上的申请', () => {
    expect(action).toContain('没认出这是个域名');
  });

  it('去重文案分得开三类', () => {
    expect(action).toContain('你已提交过这个站点的停采申请');
  });

  it('常量本身是分开的两类', () => {
    expect(SITE_KIND).toBe('site');
    expect(SITE_PLATFORM).toBe('site');
  });
});

// ── 行为：真插一条申请，看闸是不是真的拦住、又没有误拦 ────────────────────
//
// 上面全是源码断言。这一轮反复吃过的亏就是「守卫全在『不许做什么』上，
// 没有一条在『做出来的东西有没有用』上」——所以这一段必须真跑。
describe('真跑：站点停采闸', () => {
  beforeEach(async () => {
    await prisma.dataRemovalRequest.deleteMany({});
  });

  async function askStop(host: string, status = 'pending') {
    await prisma.dataRemovalRequest.create({
      data: {
        platform: SITE_PLATFORM,
        handle: canonicalRemovalSite(host),
        kind: SITE_KIND,
        contact: 'a@b.com',
        status,
      },
    });
  }

  it('没人申请 → 不拦', async () => {
    expect(await isSiteRemovalRequested('https://example.com')).toBe(false);
  });

  it('申请了 → 拦，且 http/https/www 都拦得住', async () => {
    await askStop('https://www.example.com');
    expect(await isSiteRemovalRequested('https://example.com')).toBe(true);
    expect(await isSiteRemovalRequested('http://example.com')).toBe(true);
    expect(await isSiteRemovalRequested('https://www.example.com/some/page')).toBe(true);
  });

  it('🔒 子域一并拦（同一个人的站）', async () => {
    await askStop('example.com');
    expect(await isSiteRemovalRequested('https://blog.example.com')).toBe(true);
    expect(await isSiteRemovalRequested('https://a.b.example.com')).toBe(true);
  });

  it('🔒 后缀冒充绝不能拦（拿一个人的权利停掉另一个人的站，比漏拦更坏）', async () => {
    await askStop('example.com');
    expect(await isSiteRemovalRequested('https://notexample.com')).toBe(false);
    expect(await isSiteRemovalRequested('https://example.com.evil.net')).toBe(false);
    expect(await isSiteRemovalRequested('https://myexample.com')).toBe(false);
  });

  it('🔒 反向也不成立：申请子域不该停掉主域（他只拥有那一个子域）', async () => {
    await askStop('blog.example.com');
    expect(await isSiteRemovalRequested('https://blog.example.com')).toBe(true);
    expect(await isSiteRemovalRequested('https://example.com')).toBe(false);
  });

  it('🔒 pending 就停（宁可少采几天，也不在核验期间继续采）', async () => {
    await askStop('example.com', 'pending');
    expect(await isSiteRemovalRequested('https://example.com')).toBe(true);
  });

  it('🔒 rejected 恢复采集（核验为无效申请）', async () => {
    await askStop('example.com', 'rejected');
    expect(await isSiteRemovalRequested('https://example.com')).toBe(false);
  });

  it('🔒 账号类的申请不该停掉站点（两类的执行动作完全不同）', async () => {
    await prisma.dataRemovalRequest.create({
      data: { platform: 'douyin', handle: 'example.com', kind: 'account', contact: 'a@b.com', status: 'pending' },
    });
    expect(await isSiteRemovalRequested('https://example.com')).toBe(false);
  });
});

describe('真跑：站点停采会删掉已经采到的数据', () => {
  beforeEach(async () => {
    await prisma.dataRemovalRequest.deleteMany({});
    await prisma.scrapeRecord.deleteMany({});
    await prisma.scrapeRecipe.deleteMany({});
  });

  async function seedRecipe(origin: string) {
    const tenant = await prisma.tenant.create({ data: { name: 't' } });
    const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
    const r = await prisma.scrapeRecipe.create({
      data: {
        tenantId: tenant.id, workspaceId: ws.id, name: 'x',
        origin, status: 'active', createdBy: 'm1',
      },
    });
    await prisma.scrapeRecord.create({
      data: {
        tenantId: tenant.id, workspaceId: ws.id, recipeId: r.id,
        url: `${origin}/a`, values: '{"f1":"v"}', got: 1, want: 1, channel: 'server',
      },
    });
    return r.id;
  }

  it('删记录、停配方，且**不删**配方本身', async () => {
    const id = await seedRecipe('https://www.example.com');
    const r = await purgeRemovedSiteData('example.com');
    expect(r.records).toBe(1);
    expect(r.recipes).toBe(1);
    const still = await prisma.scrapeRecipe.findUnique({ where: { id } });
    expect(still, '配方是用户自己写的东西，只该停不该删').toBeTruthy();
    expect(still!.status).toBe('stopped');
    expect(await prisma.scrapeRecord.count()).toBe(0);
  });

  it('🔒 不误伤后缀相似的站点', async () => {
    const id = await seedRecipe('https://notexample.com');
    const r = await purgeRemovedSiteData('example.com');
    expect(r.records).toBe(0);
    expect(r.recipes).toBe(0);
    expect((await prisma.scrapeRecipe.findUnique({ where: { id } }))!.status).toBe('active');
    expect(await prisma.scrapeRecord.count()).toBe(1);
  });

  it('子域的配方也停', async () => {
    await seedRecipe('https://blog.example.com');
    const r = await purgeRemovedSiteData('example.com');
    expect(r.recipes).toBe(1);
  });
});

describe('说到就得做到：界面与政策', () => {
  it('🔒 stopped 状态在界面上说人话，且说清是谁停的', () => {
    const list = read('app/(app)/skills/RecipeList.tsx');
    expect(list).toContain('stopped');
    expect(list).toContain('已停采');
    // 用户看到英文 'stopped' 只会问「什么停了」；更要紧的是让他知道这不是他能修的
    expect(list).toContain('站点的权利人要求不要再抓取');
  });

  it('🔒 停采的配方不会被定时扫描跑到', () => {
    const sweep = read('lib/scrape/sweep.ts');
    expect(sweep).toContain("status: { in: ['active', 'broken'] }");
    expect(sweep).not.toContain("'stopped'");
  });

  it('🔒 隐私政策里写了这条权利（表单上能提、政策里不说，等于没人知道）', () => {
    const web = read('app/(public)/legal/privacy/page.tsx');
    expect(web).toContain('站点权利人可以要求我们停下来');
    expect(web).toContain('先停止抓取');
    expect(web).toContain('子域一并停止');
  });

  it('🔒 政策说的「先停」与代码里的 pending 也停是同一件事', () => {
    expect(read('app/(public)/legal/privacy/page.tsx')).toContain('不等核验完成');
    expect(read('lib/legal/removal.ts')).toContain("const BLOCKING_STATUSES = ['pending', 'verified', 'removed']");
  });
});

// ── 插件那条路（2026-08-29 彻查时找出来的真缺口）────────────────────────
//
// 站点停采闸原本只挂在 vetOrigin（建配方）与 browseLocal（CDP 打开页面）两处。
// **插件是第三条路，而它绕过了这两处**：配方缓存在 chrome.storage.local 里本地执行，
// 结果直接 POST 回服务端。于是站点权利人申请停采之后，CDP 停了、插件照抓，
// 服务端还照单全收——「停止抓取」这句承诺在那条路上没兑现。
describe('🔒 插件回传通道也要过停采闸', () => {
  const route = read('app/api/ingest/recipe/route.ts');

  it('POST 里有闸', () => {
    expect(route).toContain('await isSiteRemovalRequested(owned.origin)');
  });

  it('🔒 闸在**认出配方之后、分叉处理之前**（三种 kind 都要拦住）', () => {
    const gate = route.indexOf('await isSiteRemovalRequested(owned.origin)');
    const learn = route.indexOf("if (parsed.data.kind === 'learn')");
    const data = route.indexOf("if (parsed.data.kind === 'data')");
    const result = route.indexOf('await recordScrapeResult(owned.id');
    expect(gate).toBeGreaterThan(0);
    for (const [name, at] of [['learn', learn], ['data', data], ['result', result]] as const) {
      expect(at, `找不到 ${name} 分支`).toBeGreaterThan(0);
      expect(gate, `闸没挡在 ${name} 之前`).toBeLessThan(at);
    }
  });

  it('🔒 三种 kind 一个都不放过（result 会把状态刷回 active，把 stopped 抹掉）', () => {
    // 只拦 data 的话：learn 会给一个不许抓的站学规则；
    // result 会让 recordScrapeResult 把 status 从 stopped 改回 active
    const seg = between(route, 'await isSiteRemovalRequested(owned.origin)', "if (parsed.data.kind === 'learn')");
    expect(seg).toContain('403');
    // 闸和 kind 判断之间不许有任何分支放行
    expect(seg).not.toContain("kind ===");
  });

  it('🔒 GET 也不下发 stopped 的配方（插件下次刷新就丢掉它）', () => {
    expect(route).toContain("status: { in: ['learning', 'active', 'broken'] }");
    expect(route).not.toContain("'stopped'");
  });
});

// ── 停采闸的第四条路：服务端直抓正文（2026-08-30 补）─────────────────────────
//
// 配方（lib/scrape/recipe.ts）、本机浏览器（lib/browser/local.ts）、
// 插件回传（app/api/ingest/recipe/route.ts）三条都挂了闸，唯独 lib/clip 这条没挂——
// 而从站点权利人的角度看，「服务端直接去抓你的正文」恰恰是最像抓取的一条。
// 隐私政策承诺的是「收到申请即**先停止抓取**（不等核验完成）」，
// 少挂一条路，那句承诺就是假的。
//
// 更糟的是它存的是**他人作品的正文全文**（InspirationItem），
// 比配方那几个字段值敏感得多，而它原来既不停、也不在任何清理路径里。
describe('停采闸：四条路一条都不能漏', () => {
  const GATED = [
    ['lib/scrape/recipe.ts', '建采集配方'],
    ['lib/browser/local.ts', '本机浏览器驱动'],
    ['app/api/ingest/recipe/route.ts', '插件回传'],
    ['lib/clip/index.ts', '服务端直抓正文'],
  ] as const;

  it.each(GATED)('%s（%s）挂了 isSiteRemovalRequested', (f) => {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src, `${f} 这条路没挂停采闸`).toMatch(/await isSiteRemovalRequested\(/);
  });

  it('🔒 clip 的闸在**抓取之前**（抓完再判等于已经抓了）', () => {
    const src = read('lib/clip/index.ts');
    orderedBefore(src, 'await isSiteRemovalRequested(', 'params.fetchPage ?? ');
  });

  it('🔒 闸不能挂在可注入的 fetchPage 里（单测桩会绕过它）', () => {
    const seg = between(read('lib/clip/index.ts'), 'await isSiteRemovalRequested(', 'let page;');
    expect(seg, '闸和抓取之间混进了别的分支').not.toContain('fetchPage(');
  });
});

describe('从被停采站点剪藏来的正文要删掉', () => {
  const src = read('lib/legal/removal.ts');

  it('🔒 purgeRemovedSiteData 真的删 InspirationItem', () => {
    const body = between(src, 'export async function purgeRemovedSiteData', '\n}');
    expect(body, '剪藏正文没被删——承诺里写的是「删除已经从该站取到的数据」').toContain('inspirationItem.deleteMany');
  });

  it('🔒 剪藏是删不是停（配方才是停）', () => {
    const body = between(src, 'export async function purgeRemovedSiteData', '\n}');
    expect(body).toContain("data: { status: 'stopped' }");   // 配方：停
    expect(body).toContain('inspirationItem.deleteMany');    // 剪藏：删
  });

  it('🔒 dry-run 数的与真删的是同一批（否则运营看着 0 条按了执行）', () => {
    const cnt = between(src, 'export async function countRemovedSiteData', '\n}');
    expect(cnt).toContain('siteClippedIds(origin)');
  });

  it('🔒 「没有配方但有剪藏」的站点不许被早退掉', () => {
    // 用户从没为它建过配方，只是在群里发过几条它的链接——这种最常见。
    // 早退会让 dry-run 报 0，运营据此以为没东西可删。
    // 【判据是顺序，不是切片】第一版把函数体切到第一个 `return {` 之前再断言——
    // 而早退本身就是 `return {`，切片正好把它切掉了。改用顺序断言。
    orderedBefore(src, 'const clips = (await siteClippedIds(origin)).length;',
      'return { records: 0, recipes: 0, clips };');
  });

  it('🔒 域名按段比，不用裸 contains（否则 notexample.com 会被一起删）', () => {
    const body = between(src, 'async function siteClippedIds', '\n}');
    expect(body, '没走 sameSiteOrSub').toContain('sameSiteOrSub(');
    expect(body, '两处归一口径不一致，同一个申请会匹配到不同范围').toContain('canonicalRemovalSite(');
  });
});

// ── 账号停采闸的第三条路：评论回传（2026-08-30 补）───────────────────────────
//
// 竞对采集两条路（lib/ingest/competitor.ts 插件回传、lib/pipeline.ts 服务端采集）
// 都挂了 isRemovalRequested，唯独 app/api/ingest/questions 这条没挂——
// 而它存的是**评论正文**（ReaderComment）与读者提问，都挂在被申请移除的那个账号名下。
//
// 公开页承诺「收到申请即先停止对该账号的新增采集（不等核验完成）」。
// 少挂一条路，那句承诺对评论这条链路就是假的：申请人看着「已受理」，
// 我们仍在往他名下的作品上攒评论正文。
describe('账号停采闸：三条路一条都不能漏', () => {
  const ACCOUNT_GATED = [
    ['lib/ingest/competitor.ts', '插件竞对回传'],
    ['lib/pipeline.ts', '服务端竞对采集'],
    ['app/api/ingest/questions/route.ts', '评论/读者原声回传'],
  ] as const;

  it.each(ACCOUNT_GATED)('%s（%s）挂了 isRemovalRequested', (f) => {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src, `${f} 这条路没挂账号停采闸`).toMatch(/await isRemovalRequested\(/);
  });

  it('🔒 评论那条的闸在入库**之前**（入完再判等于已经存了）', () => {
    const src = read('app/api/ingest/questions/route.ts');
    orderedBefore(src, 'await isRemovalRequested(', 'await ingestCommentQuestions(');
    orderedBefore(src, 'await isRemovalRequested(', 'await ingestReaderComments(');
  });

  it('🔒 只拦 rival，不拦 own（own 是用户读自己作品下的评论，不属于「监控」）', () => {
    // 一起拦掉只会在同名撞车时把用户自己的功能弄坏——移除申请页的名字
    // 就是「被监控账号移除申请」，它管的是别人的账号。
    const src = read('app/api/ingest/questions/route.ts');
    expect(before(src, 'await isRemovalRequested(', 300)).toContain("p.scope !== 'own'");
  });

  it('拦下时如实回 403 并说明原因（静默丢弃会让插件以为存成功了）', () => {
    const seg = between(read('app/api/ingest/questions/route.ts'), 'await isRemovalRequested(', 'ingestCommentQuestions');
    expect(seg).toContain('403');
    expect(seg).toContain('已申请停止采集');
  });
});
