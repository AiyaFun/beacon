import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RECIPE_STALE_DAYS } from '@/lib/scrape/recipe';
import { orderedBefore, between } from '../helpers/anchor';
import {
  originWaitMs, markOriginHit, resetOriginThrottle, jitterFor, ORIGIN_MIN_GAP_MS,
} from '@/lib/scrape/sweep';

// 跑得住（2026-08-29 批四）：验证码/风控识别、按站点节流、调试端口三态、登录态久未成功提醒。
//
// 这一批治的都是**「不是我们坏了，但看起来像我们坏了」**：
//   · 撞上验证码 → 被当成改版拿去重学，学出一堆「请输入验证码」的规则；
//   · 同一站点十个配方 20 秒内打十次 → 代价是用户自己的账号被风控；
//   · Chrome 已经带端口开着 → 仍被告知「请先完全退出 Chrome」；
//   · 登录态过期（页面不跳登录页、只是渲染成未登录）→ 永远在自己修、永远修不好。

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('验证码 / 风控页：和登录墙同一类处置，但话不一样', () => {
  const src = read('lib/browser/local.ts');

  it('是第四条信号，且认得出中英文两种常见说法', () => {
    expect(src).toContain("kind: 'captcha'");
    for (const w of ['安全验证', '访问过于频繁', 'unusual traffic', 'too many requests']) {
      expect(src, `没认 ${w}`).toContain(w);
    }
  });

  it('🔒 不计失败（计了会把好配方推去重学，而重学看到的还是验证码页）', () => {
    expect(read('lib/scrape/recipe.ts')).toContain('// failCount 刻意**不动**：这不是失败');
    const sweep = read('lib/scrape/sweep.ts');
    const i = sweep.indexOf('page.rateLimited');
    expect(i).toBeGreaterThan(0);
    // 【只截到这一支的右花括号】原来写死 200 字符，把后面的 else 分支也圈了进来，
    // 于是断言恒假——守卫窗口开太大和开太小是同一类错，都让断言说的不是它想说的事
    const branch = sweep.slice(i, sweep.indexOf('} else', i));
    expect(branch).toContain('markRateLimited');
    expect(branch).not.toContain('recordScrapeResult');
  });

  it('🔒 与「等你登录」分成两个状态（处置一样，但下一步完全不同）', () => {
    const list = read('app/(app)/skills/RecipeList.tsx');
    expect(list).toContain('rate_limited');
    expect(list).toContain('被站点拦下了');
    // 登录墙让他去登录，风控让他等——合成一句就必然给错建议
    expect(list).toContain('把频率调低');
    expect(list).toContain('等你登录');
  });

  it('🔒 验证码不推前台、不等（我们过不了它，也明确不做规避）', () => {
    // 只有 kind === 'login' 才 bringToFront 并等待
    expect(src).toContain("if (wall.walled && wall.kind === 'login' && waitForLoginSec > 0)");
    expect(src).toContain('我们不会替你过验证码');
  });

  it('验证码那一页不留着（登录页留着有用，验证码页留着对用户没有任何用处）', () => {
    // captcha 分支整体在 login 分支**之前**，所以要看的是这一支自己的函数体，
    // 而不是它前面那一段（前面那段属于等待循环）
    const i = src.indexOf("if (wall.walled && wall.kind === 'captcha')");
    expect(i).toBeGreaterThan(0);
    const branch = src.slice(i, src.indexOf('if (wall.walled) {', i));
    expect(branch).toContain('rateLimited: true');
    expect(branch).not.toContain('leaveOpen = true');
    // 而登录那一支必须仍然留着页面
    const loginBranch = src.slice(src.indexOf('if (wall.walled) {', i));
    expect(loginBranch.slice(0, 300)).toContain('leaveOpen = true');
  });

  it('采到了就一并恢复（needs_login 与 rate_limited 都是临时状态）', () => {
    expect(read('lib/scrape/recipe.ts')).toContain('needs_login 与 rate_limited 一并恢复');
  });
});

describe('按站点节流：代价是用户自己的账号', () => {
  beforeEach(() => resetOriginThrottle());

  it('第一次不用等', () => {
    expect(originWaitMs('https://a.com', 1_000_000)).toBe(0);
  });

  it('同一站点紧接着再来要等够', () => {
    const t = 1_000_000;
    markOriginHit('https://a.com', t);
    expect(originWaitMs('https://a.com', t + 1_000)).toBeGreaterThan(0);
    expect(originWaitMs('https://a.com', t + ORIGIN_MIN_GAP_MS)).toBe(0);
  });

  it('🔒 不同站点互不影响（节流是按站点，不是全局限速）', () => {
    const t = 1_000_000;
    markOriginHit('https://a.com', t);
    expect(originWaitMs('https://b.com', t + 1)).toBe(0);
  });

  it('间隔不短于既有的「配方之间 2 秒」一个量级', () => {
    expect(ORIGIN_MIN_GAP_MS).toBeGreaterThanOrEqual(10_000);
  });

  it('🔒 抖动按 id 稳定，不用 Math.random（否则节流效果时好时坏且复现不了）', () => {
    expect(jitterFor('abc')).toBe(jitterFor('abc'));
    expect(jitterFor('abc')).not.toBe(jitterFor('abd'));
    expect(jitterFor('abc')).toBeGreaterThanOrEqual(0);
    expect(jitterFor('abc')).toBeLessThan(1);
    const src = read('lib/scrape/sweep.ts');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('Math.random');
  });

  it('🔒 节流真的挡在打开页面之前（记了却不等于没节流）', () => {
    const src = read('lib/scrape/sweep.ts');
    orderedBefore(src, 'const wait = originWaitMs(', 'await browseLocal(vet.url!');
    const seg = between(src, 'const wait = originWaitMs(', 'await browseLocal(vet.url!');
    expect(seg).toContain('await sleep(wait)');
    expect(seg).toContain('markOriginHit(r.origin)');
  });
});

describe('采集专用浏览器：不碰用户日常的 Chrome', () => {
  // 2026-09-04 重写。原先这里守的是「用日常 profile 带调试端口起 Chrome，端口三态 + ⌘Q 指引」，
  // 那条路已经**被 Chrome 自己封死**：≥136 拒绝在默认 user-data-dir 上开调试端口（真机 152 实测），
  // 而且日常 Chrome 开着时新进程会直接退出。真机连撞三次、任务三次判死，才换成独立 profile。
  // 守卫跟着行为走：现在要钉住的是「独立目录、不碰日常浏览器、登录态长期留着」。
  const cb = read('desktop/src-tauri/src/collect_browser.rs');
  const rs = read('desktop/src-tauri/src/main.rs');

  it('🔒 用独立的 user-data-dir，且端口不与日常那条老路撞号', () => {
    expect(cb, '没传 --user-data-dir 就是又回到日常 profile（Chrome ≥136 上根本开不出端口）')
      .toMatch(/--user-data-dir=/);
    expect(cb).toContain('COLLECT_PORT: u16 = 9223');
    // 剥注释再判：注释里正解释着「刻意不用 9222」，不剥的话这条会被自己的注释骗（本仓老坑）
    const cbCode = cb.replace(/^\s*\/\/.*$/gm, '');
    expect(cbCode, '端口撞回 9222 会连上用户手工起的日常 Chrome，行为不可预测').not.toContain('9222');
  });

  it('🔒 登录态要长期留着：profile 放在 app_data_dir，只有用户主动点才清', () => {
    expect(cb).toContain('app_data_dir');
    expect(cb).toContain('collect-profile');
    // 清除是显式动作，且托盘里说明白后果（登录态会一起没）
    expect(cb).toMatch(/pub fn wipe\(/);
    expect(rs).toContain('清除采集浏览器登录数据');
    expect(rs).toContain('登录态也一起没了');
  });

  it('🔒 绝不杀浏览器，也不要求用户退出他日常的 Chrome', () => {
    const code = (cb + rs).replace(/^\s*\/\/.*$/gm, '');
    for (const bad of ['pkill', 'taskkill', 'killall', '.kill()']) {
      expect(code, `不该出现 ${bad}`).not.toContain(bad);
    }
    // ⌘Q 那句指引是旧路的产物：新路下用户什么都不用退出，再出现就是行为回退了
    expect(code, '又要求用户退出 Chrome 了').not.toContain('完全退出 Chrome');
  });

  it('🔒 调试端口只绑本机，且不改任何系统设置', () => {
    expect(cb).toContain('--remote-debugging-address=127.0.0.1');
    expect(cb).toContain('TcpStream::connect_timeout');
    const code = (cb + rs).replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('LaunchAgents');
    expect(code).not.toContain('defaults write');
  });

  it('🔒 撞上登录墙时把窗口摆到用户面前，但绝不替他输密码', () => {
    const ex = read('desktop/src-tauri/src/executor.rs');
    // 2026-09-04 审计后：推到前台的必须是执行器自己那一页（原先另开标签，用户登完也检测不到）
    expect(ex).toContain('Page.bringToFront');
    expect(ex).toMatch(/不会替你输入账号密码/);
    // 只读采集的红线：CDP 不点、不填、不提交
    const code = ex.replace(/^\s*\/\/.*$/gm, '');
    for (const bad of ['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText']) {
      expect(code, `执行器出现了写操作 ${bad}`).not.toContain(bad);
    }
  });

  it('🔒 冷启动的等待要够长（真机实测建 profile 要 5 秒以上）', () => {
    const m = cb.match(/for _ in 0\.\.(\d+) \{[\s\S]{0,200}?port_open\(COLLECT_PORT\)/);
    expect(m, '找不到等端口的循环').toBeTruthy();
    const rounds = Number(m![1]);
    expect(rounds * 400, '等待窗口短于 20 秒：冷启动那一次会误判成「端口没通」').toBeGreaterThanOrEqual(20000);
  });
});

describe('自动检测端点：能探到就别让人手打', () => {
  const src = read('app/(app)/settings/shell-actions.ts');

  it('🔒 握手确认这是个浏览器（本机随便一个服务都可能占着 9222）', () => {
    expect(src).toContain('/json/version');
    expect(src).toContain('webSocketDebuggerUrl');
  });

  it('🔒 只探本机，且探出来的地址仍然过 vetCdpUrl', () => {
    expect(src).toContain('http://127.0.0.1:${port}');
    expect(src).toContain('vetCdpUrl(url)');
    // 不给「填一个远程地址去探」的入口
    expect(src).not.toContain('input.host');
  });

  it('🔒 形态与角色两道闸都在（界面判过不算数）', () => {
    const i = src.indexOf('export async function actDetectCdp');
    const body = src.slice(i, i + 900);
    expect(body).toContain("can('localBrowser')");
    expect(body).toContain("requireRole(s, 'byok.manage')");
  });

  it('界面上真的有这个按钮，且说清了托盘那条路', () => {
    const card = read('app/(app)/settings/LocalShellCard.tsx');
    expect(card).toContain('自动检测');
    // 2026-09-04：托盘那两项随「采集专用浏览器」改名（旧的「生成采集浏览器快捷方式」
    // 是给日常 profile 用的，那条路已被 Chrome ≥136 封死并删除）
    expect(card).toContain('清除采集浏览器登录数据');
    expect(card, '设置页没说破「每个平台要各登一次」——用户会一直等一个不会发生的自动登录')
      .toContain('每个平台要各登录一次');
  });
});

describe('久未成功：登录态过期最常见的形态不是跳登录页', () => {
  const src = read('lib/scrape/recipe.ts');

  it('阈值是天，不是次（网络抖动几次不该触发）', () => {
    expect(RECIPE_STALE_DAYS).toBeGreaterThanOrEqual(2);
  });

  it('🔒 只提醒、不改状态（我们并不知道是登录过期还是站点改版，不替用户下结论）', () => {
    const i = src.indexOf('export async function noticeStaleRecipes');
    const body = src.slice(i, i + 1600);
    expect(body).toContain('notify(');
    // 【查的是「不写状态」，不是「不出现 status 这个词」】
    // where 子句里本来就有 status（筛 active/broken），原来那条断言因此恒假。
    // 要证明的是它不去 update——改状态等于替用户下结论，而我们并不知道是哪一种。
    expect(body).not.toContain('scrapeRecipe.update');
  });

  it('🔒 从来没成功过的不提醒（那是「还没学会」，提醒查登录态会把人带偏）', () => {
    expect(src).toContain('lastOkAt: { not: null, lt: cutoff }');
  });

  // 【这条原来把一个不存在的行为钉住了】它的标题写着「不带的话 notify 合并后永远只显示第一条」，
  // 而 notify() 从头到尾是个裸 create，**从来不按 refId 合并**。
  // 于是这条守卫既守不住真正要守的东西（同一天里发了几条），
  // 又让读它的人相信了一个假前提——下一个人还会照它写。
  it('🔒 refId 带天数 + once：同一天只响一次，情况恶化时再响', () => {
    // 天数：3 天 → 10 天是两条不同的提醒，用户该看见恶化
    expect(src).toContain('refId: `recipe-stale:${r.id}:${days}`');
    // once：同一天里那 4 轮 cron 只发一条。少了它，天数分量一点用都没有
    expect(
      src,
      'refId 带了天数但没传 once——notify 不会自己合并，同一天的 4 轮 cron 会发 4 条一模一样的',
    ).toContain('once: true');
  });

  it('提醒里给的是最可能的下一步，而不是「出错了」', () => {
    expect(src).toContain('登录态过期');
    expect(src).toContain('原地渲染成未登录的样子');
  });

  it('🔒 一轮跑完再判（这轮刚成功的已经刷新了 lastOkAt，先跑完才不会误报）', () => {
    const sweep = read('lib/scrape/sweep.ts');
    // 【锚在调用点的相对位置上，不锚在缩进上】原来写死了 `\n    }` 的缩进，
    // 一次无关的格式调整就会让它对不上——守卫写死语法细节会在重构里假失效
    const call = sweep.indexOf('await noticeStaleRecipes(');
    const lastRecipeWork = sweep.lastIndexOf('await sleep(GAP_MS)');
    expect(call).toBeGreaterThan(0);
    expect(lastRecipeWork, '逐个配方的 sleep(GAP_MS) 不在了——下一条 call > -1 会恒绿').toBeGreaterThan(0);
    expect(call, '久未成功的提醒必须在逐个配方跑完之后').toBeGreaterThan(lastRecipeWork);
  });
});
