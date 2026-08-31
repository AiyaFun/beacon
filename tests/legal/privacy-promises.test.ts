import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MAX_SCROLL_SCREENS } from '@/lib/browser/local';
import {
  COMMENT_TEXT_PURGE_DAYS, MAX_COMMENT_TEXT_LEN,
  MAX_COMMENT_TEXTS_PER_RUN, MAX_READER_COMMENTS_PER_WORKSPACE,
  MIN_ASKED_TO_STORE, COMMENT_NEVER_COLLECTED,
} from '@/lib/comment-collect-rules';

// 隐私承诺 ↔ 代码，两侧同时断言。
//
// 为什么这个守卫必须存在：这个项目栽过两次同一个跟头——
//   · 移除申请页收下了退出申请，采集链路却从来不查它（lib/legal/removal.ts 文件头）；
//   · 隐私政策写着「评论两人以上才留存」，而实现里那道闸当时并不在。
// 两次都是「政策文本先写好，代码没跟上」，而政策是**对外**的，挂在商店页上。
//
// 所以这里断言的不是行为，而是**文本与常量的一致性**：政策里写了 90 天，代码里就必须是 90；
// 谁改了常量而没改政策（或反过来），这条测试当场变红。
//
// 2026-08-11 评论正文留存上线时补齐——那次改动同时动了三份文本：
//   extension/store/privacy.md（商店提交的那份）
//   app/(public)/legal/privacy/page.tsx（站内那份）
//   scripts/privacy-page.ts（境外托管、审核机器实际能打开的那份）
// 三份漂了任何一份，商店披露就与实际行为不符——那是下架级问题，不是文案问题。

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

const STORE_MD = read('extension/store/privacy.md');
const WEB_PAGE = read('app/(public)/legal/privacy/page.tsx');
const OFFSHORE = read('scripts/privacy-page.ts');
const ALL_POLICIES: [string, string][] = [
  ['商店 privacy.md', STORE_MD],
  ['站内 /legal/privacy', WEB_PAGE],
  ['境外托管版 privacy-page.ts', OFFSHORE],
];
const SW = read('extension/sw.js');

// ⚠️ 判据必须是「这条触发**有实质描述**」，不能只是「这几个字在文件里出现过」。
// 第一版就是 toContain('每日定时批量采集')，而这个词在三份文本里各出现好几次
// （权限表一处、枚举表一处、正文一处）——把整段实质说明删掉，它照样绿。
// 改成邻近性断言：这个词的**某一次出现**周围必须同时讲清该讲的几件事。
const near = (text: string, anchor: string, want: RegExp, radius = 600) => {
  let i = text.indexOf(anchor);
  while (i !== -1) {
    if (want.test(text.slice(Math.max(0, i - radius), i + radius))) return true;
    i = text.indexOf(anchor, i + 1);
  }
  return false;
};

describe('评论正文留存：政策文本与代码常量必须对得上', () => {
  it(`🔒 三份政策都写明保留 ${COMMENT_TEXT_PURGE_DAYS} 天`, () => {
    for (const [name, text] of ALL_POLICIES) {
      expect(text, `${name} 里没写保留期，或与代码的 ${COMMENT_TEXT_PURGE_DAYS} 天不一致`)
        .toContain(`${COMMENT_TEXT_PURGE_DAYS} 天`);
    }
  });

  it('🔒 三份政策都承诺「不进入模型训练/生成语料」', () => {
    for (const [name, text] of ALL_POLICIES) {
      expect(/不进入任何模型训练|不会进入任何 AI 生成语料|不进入任何模型训练或生成语料/.test(text), `${name} 缺少「不进语料」承诺`)
        .toBe(true);
    }
  });

  it('🔒 商店与站内政策都写明单条上限与单次条数', () => {
    for (const [name, text] of [ALL_POLICIES[0], ALL_POLICIES[1]] as [string, string][]) {
      expect(text, `${name} 没写单条 ${MAX_COMMENT_TEXT_LEN} 字上限`).toContain(`${MAX_COMMENT_TEXT_LEN} 字`);
      expect(text, `${name} 没写单次 ${MAX_COMMENT_TEXTS_PER_RUN} 条上限`).toContain(`${MAX_COMMENT_TEXTS_PER_RUN} 条`);
    }
  });

  it('🔒 商店与站内政策都写明工作区配额', () => {
    for (const [name, text] of [ALL_POLICIES[0], ALL_POLICIES[1]] as [string, string][]) {
      expect(text, `${name} 没写 ${MAX_READER_COMMENTS_PER_WORKSPACE} 条配额`)
        .toContain(`${MAX_READER_COMMENTS_PER_WORKSPACE} 条`);
    }
  });

  it(`🔒 「${MIN_ASKED_TO_STORE} 人以上才进选题」这条承诺仍在（放开正文≠放开这个）`, () => {
    for (const [name, text] of ALL_POLICIES) {
      expect(/两人以上/.test(text), `${name} 丢了「两人以上」这条承诺`).toBe(true);
    }
  });

  // ⚠️ 清单**从 lib/comment-collect-rules.ts 读**，不许在这里手抄。
  // 2026-08-13：这里原本手抄了 6 项（真值 9 项），于是站内 /legal/privacy 少写「@提及对象」
  // 这件事一直没被发现——守卫的全部意义就是「三份政策不许漂」，它却因为自己抄漏而全绿。
  it('🔒 评论者身份不采清单一条不少（三份政策逐项对齐代码里的唯一事实源）', () => {
    expect(COMMENT_NEVER_COLLECTED.length, '真值清单被砍短了？先确认代码是不是真的开始采了')
      .toBeGreaterThanOrEqual(9);
    for (const [name, text] of ALL_POLICIES) {
      for (const field of COMMENT_NEVER_COLLECTED) {
        expect(text.includes(field), `${name} 的不采清单里少了「${field}」`).toBe(true);
      }
    }
  });
});

describe('承诺兑现在代码里，不只在文本里', () => {
  it('🔒 政策说「不会被导出」→ export.ts 里就不能有 readerComment 的读取', () => {
    const exportSrc = read('lib/account/export.ts');
    // 注释里提到它没关系（那是在解释为什么不导），有实际查询才是违背承诺
    expect(/prisma\.readerComment\.(findMany|findFirst)/.test(exportSrc)).toBe(false);
  });

  // 「申请移除时一并删除」这条**不在这里断言源码**——试过了，守不住：removal.ts 里有两处
  // deleteMany（精确匹配一处、大小写兜底一处），把其中一处改成空操作，
  // `/prisma\.readerComment\.deleteMany/` 照样命中，测试全绿而承诺已经破了。
  // 真正守住它的是行为测试：tests/legal/removal-resolve.test.ts
  // 「正文只删被申请那个账号的」「自有作品的正文不受影响」「从没进过竞对库也要删得掉」三条。
  it('🔒 移除承诺由行为测试守着，不是靠这里的源码扫描', () => {
    // 【要断的是那三条用例还在，不是那个词还在】原来断的是 `toContain('readerComments')`，
    // 而那个词在别处也有（readerCommentsByWork 之类），三条用例被删光它照样绿——
    // 一条守着「别的守卫还在」的守卫，自己失效是最不容易发现的。
    const behavior = read('tests/legal/removal-resolve.test.ts');
    for (const must of [
      '正文只删被申请那个账号的',
      '自有作品的正文（scope=own）不受影响',
      '账号从没进过竞对库，也要删得掉它名下的正文',
    ]) {
      expect(behavior, `行为测试里「${must}」这条没了——移除承诺就没人守了`).toContain(must);
    }
    expect(behavior).toContain('prisma.readerComment.count()');
  });

  it('🔒 政策说「到期物理删除」→ 清理走的必须是 deleteMany，不是改状态', () => {
    const src = read('lib/ingest/reader-comments.ts');
    expect(/purgeExpiredComments[\s\S]*?prisma\.readerComment\.deleteMany/.test(src)).toBe(true);
    expect(/purgeExpiredComments[\s\S]*?state: 'archived'/.test(src)).toBe(false);
  });
});

// ── 2026-08-13 体检补上的两组 ──
//
// 这两条都是「代码在做、政策没说」，方向与上面几条相反（上面是「政策写了、代码没做」）。
// 披露不全与披露不实在审核口径下是同一件事，处罚对象都是**发布者名下的全部扩展**。

describe('每日定时批量采集：默认开启，三份政策都必须说', () => {

  // 先钉住代码事实——如果哪天它改成默认关闭，下面的政策断言就该跟着松绑，
  // 这条会提醒改的人回来看这一组。
  it('代码事实：scheduledCollect 默认开启，且闹钟真的会发起采集', () => {
    expect(SW, 'sw.js 里 scheduledCollect 不再是默认开启了？那下面几条政策措辞要跟着改')
      .toMatch(/s\.scheduledCollect !== false/);
    expect(SW).toMatch(/'beacon-scheduled-collect'\) runScheduledCollect\(\)/);
    expect(SW).toMatch(/runScheduledCollect[\s\S]{0,900}batchCollect\(null\)/);
  });

  it('🔒 三份政策都对「每日定时批量采集」有实质描述（不是只提一嘴）', () => {
    for (const [name, text] of ALL_POLICIES) {
      expect(text, `${name} 完全没提每日定时批量采集`).toContain('每日定时批量采集');
      expect(
        near(text, '每日定时批量采集', /默认开启/),
        `${name} 提到了每日定时批量采集，但附近没说清它**默认开启**——默认开的东西藏起来最要命`,
      ).toBe(true);
      expect(
        near(text, '每日定时批量采集', /可(在设置)?关闭|可关|设置.{0,12}关闭/),
        `${name} 没在附近说明可以关闭`,
      ).toBe(true);
      expect(
        near(text, '每日定时批量采集', /立即关闭|采完.{0,6}关闭|随后.{0,6}关闭/),
        `${name} 没说明打开的标签页会被关掉`,
      ).toBe(true);
    }
  });

  // 曾经写着「闹钟本身不发起任何采集」——与 beacon-scheduled-collect 直接冲突。
  it('🔒 不许再出现「闹钟不发起采集」这类反过来的表述', () => {
    for (const [name, text] of ALL_POLICIES) {
      expect(text, `${name} 里还留着「闹钟本身不发起任何采集」，这句与代码相反`)
        .not.toContain('闹钟本身不发起任何采集');
    }
  });
});

// 2026-08-18 改了行为：未登录时不再当场关页，而是把登录页切到前台交给用户本人登录。
// 这动了「后台标签页、不抢占焦点、采完立即关闭」那条既有承诺，三份政策必须同步说清楚，
// 而且要说清**边界**——否则「插件会把页面弹到你面前」听起来就像它可以随时抢你的屏幕。
describe('未登录 → 把登录页切到前台：三份政策与代码必须一致', () => {
  it('代码事实：等待上限是 5 分钟，且只在 interactive（用户当场点击）时切前台', () => {
    expect(SW, 'sw.js 的等待上限变了？三份政策里写的「5 分钟」要跟着改')
      .toMatch(/const LOGIN_WAIT_MS = 5 \* 60_000/);
    expect(SW, '切前台不再受 interactive 约束了？那定时任务会在用户不在时弹页面')
      .toMatch(/r\?\.needLogin && opts\.interactive/);
    // 切到前台的页不许再被自动关掉——政策里写了「归用户所有」
    expect(SW).toMatch(/!existing && !surfaced && tab\?\.id/);
  });

  it('🔒 三份政策都写明「切到前台 + 最长 5 分钟 + 不代替登录」', () => {
    for (const [name, text] of ALL_POLICIES) {
      expect(text, `${name} 没披露「未登录时把页面切到前台」这个会抢焦点的行为`).toContain('切到前台');
      expect(
        near(text, '切到前台', /5 分钟/),
        `${name} 说了会切到前台，但附近没写等待上限——没有上限的等待等于永久占着用户的屏幕`,
      ).toBe(true);
      expect(
        near(text, '切到前台', /不代替(用户)?登录|不会替(用户|您)登录|不填(写)?(任何)?账号密码/),
        `${name} 说了会切到前台，但附近没重申「登录动作由用户本人完成」`,
      ).toBe(true);
      expect(
        near(text, '切到前台', /当场点击|主动点击|用户点击/),
        `${name} 没说清这只发生在用户当场点击时——定时任务弹页面是完全不同的一件事`,
      ).toBe(true);
    }
  });

  it('🔒 「不代替用户登录」这句承诺一个字都不许少', () => {
    for (const [name, text] of ALL_POLICIES) {
      expect(
        /不代替用户登录|不会替您登录/.test(text),
        `${name} 里「不代替用户登录」没了——这是这次改动最容易被顺手删掉的一句`,
      ).toBe(true);
    }
  });
});

describe('主页滚动翻页：三份政策都必须说，且与「评论不翻页」分清楚', () => {
  const COMMON = read('extension/content/common.js');

  it('代码事实：主页采集确实会滚动，且有三个硬上限', () => {
    expect(COMMON).toMatch(/DEEP_MAX_ROUNDS\s*=\s*12/);
    expect(COMMON).toMatch(/DEEP_BUDGET_MS\s*=\s*30000/);
    expect(COMMON).toMatch(/BEACON_POST_CAP\s*=\s*50/);
  });

  // 同样用邻近性：`12` / `30` / `50` 这几个数字在政策全文里到处都是（300 字、5000 条、90 天…），
  // 全文 toContain 等于什么都没验。必须是「滚动」那段话附近同时出现这三个上限。
  it('🔒 三份政策都写明滚动行为与三个上限（且上限就写在滚动那段旁边）', () => {
    for (const [name, text] of ALL_POLICIES) {
      expect(text, `${name} 没披露主页滚动加载`).toMatch(/向下滚动/);
      // 【锚在「主页作品列表」上，不锚在第一个「向下滚动」上】
      // 2026-08-29 采集配方那段也写了「向下滚动」（CDP 那条路的滚动，上限是另一组数），
      // 于是「第一个出现的位置」被它占了，这条守卫开始查错段落。
      // 政策里会有不止一处滚动说明是正常的——每一处都该带自己那组上限，见下一条。
      const i = text.indexOf('主页作品列表') >= 0 ? text.indexOf('主页作品列表') : text.indexOf('向下滚动');
      const around = text.slice(Math.max(0, i - 400), i + 1200);
      for (const n of ['12', '30', '50']) {
        expect(around, `${name} 的滚动说明附近缺上限 ${n}`).toContain(n);
      }
      expect(around, `${name} 没在滚动说明附近讲清滚动位置会还原`).toMatch(/还原/);
      expect(around, `${name} 没讲清用户正在看的页面不会被自动滚动`).toMatch(/不会被自动滚动/);
    }
  });

  // 「不滚动、不翻页」那句只针对评论区。它单独出现而不说明范围，读者会理解成
  // 「本插件从不滚动页面」——那与 common.js 直接相反。
  it('🔒 出现「不滚动」表述的政策，必须同时说明主页列表是会滚的', () => {
    for (const [name, text] of ALL_POLICIES) {
      if (!/不滚动/.test(text)) continue;
      expect(text, `${name} 写了「不滚动」却没说明那只针对评论区`).toMatch(/向下滚动/);
    }
  });
});

describe('代替用户打开标签页：商店那份必须完整枚举', () => {
  it('🔒 不许再出现「唯一一处代替用户打开页面」（实际有五处）', () => {
    expect(STORE_MD).not.toContain('唯一一处代替用户打开页面');
  });

  it('🔒 商店那份有一节把它们集中列全', () => {
    expect(STORE_MD).toContain('代替用户打开标签页的行为');
    for (const act of ['批量采集', '每日定时批量采集', '补齐前 20 条作品详情', '我的账号一键采集', '公众号竞对采集']) {
      expect(STORE_MD, `枚举里缺「${act}」`).toContain(act);
    }
  });
});

describe('内容脚本清单：manifest 里有的，政策清单里不许漏', () => {
  it('🔒 商店那份逐个列出了 manifest 声明的每一个内容脚本', () => {
    const manifest = JSON.parse(read('extension/manifest.json')) as {
      content_scripts: { js: string[] }[];
    };
    const declared = Array.from(new Set(manifest.content_scripts.flatMap((c) => c.js)))
      .map((p) => p.replace(/^content\//, ''));
    expect(declared.length).toBeGreaterThan(10); // 正则失效时别静默通过
    for (const file of declared) {
      expect(STORE_MD, `政策的内容脚本清单里没有 ${file}——那句「manifest 里可逐条核对」就成了假话`)
        .toContain(file);
    }
  });
});

describe('「打开指定网址并读取正文」：政策与代码必须对得上（0.9.6 新增）', () => {
  it('🔒 三份政策都写明了它、且都说明「默认关闭」', async () => {
    for (const [name, text] of ALL_POLICIES) {
      expect(text, `${name} 完全没提这条能力——而它是唯一一件「读哪一页由服务端决定」的动作`)
        .toMatch(/打开指定网址并读取正文/);
      expect(text, `${name} 没说清它默认是关的`).toMatch(/默认关闭|默认即为关闭/);
    }
  });

  it('🔒 站点清单：政策里列出的，与代码里的白名单逐条对得上', async () => {
    // 这条守的是最容易漂的地方：代码里加一个域名，政策忘了改——
    // 那就是「实际能打开的站点比公示的多」，属于下架级问题而不是文案问题
    const { BROWSER_READ_ALLOWED_ORIGINS } = await import('@/lib/browser-task/read-allowlist');
    const nameOf: Record<string, string> = {
      'https://www.douyin.com': '抖音',
      'https://www.bilibili.com': 'B站',
      'https://www.kuaishou.com': '快手',
      'https://www.tiktok.com': 'TikTok',
      'https://www.xiaohongshu.com': '小红书',
      'https://www.zhihu.com': '知乎',
      'https://zhuanlan.zhihu.com': '知乎',
      'https://weibo.com': '微博',
      'https://www.weibo.com': '微博',
      'https://mp.weixin.qq.com': '公众号',
      'https://www.toutiao.com': '头条',
      'https://baijiahao.baidu.com': '百家号',
      'https://x.com': 'X',
      'https://twitter.com': 'X',
      'https://www.youtube.com': 'YouTube',
    };
    // 代码里出现了清单里没登记名字的域名 = 加域名时漏了这一步，先在这里拦下
    for (const origin of BROWSER_READ_ALLOWED_ORIGINS) {
      expect(nameOf[origin], `白名单里的 ${origin} 还没在这条用例里登记中文名，政策也多半没写`).toBeTruthy();
    }
    const needed = Array.from(new Set(BROWSER_READ_ALLOWED_ORIGINS.map((o) => nameOf[o])));
    for (const [name, text] of ALL_POLICIES) {
      for (const label of needed) {
        expect(text, `${name} 的站点清单里没有「${label}」——实际能打开的比公示的多`).toContain(label);
      }
    }
  });

  it('🔒 那句「服务端不能下发任意指令」已经撤掉——它现在是假话', () => {
    // 撤改而不是补充：open_and_read 字面上就是「打开某个网址」。
    // 留着原话 = 政策与行为直接相反，这正是 08-13 那批缺陷的形状
    expect(STORE_MD, '旧的否定承诺还在，而代码已经能下发网址了')
      .not.toMatch(/服务端不能下发任意指令（例如「打开某个网址」/);
    // 但边界仍然要说清楚：不能点击、不能填表、不能执行任意脚本
    expect(STORE_MD, '撤了旧话却没给出新的边界，等于什么都没说')
      .toMatch(/不能让插件点击按钮|不能让扩展点击按钮/);
  });

  it('🔒 领活时机变了，政策里那句「不新增定时器、不常驻轮询」也要撤', () => {
    // 0.9.6 起加了「每 10 分钟问一次有没有我的活」。留着原话就是又一条与行为相反的承诺
    expect(STORE_MD, '加了轮询闹钟，政策却还写着不新增定时器')
      .not.toMatch(/\*\*不新增定时器、不常驻轮询\*\*/);
    for (const [name, text] of ALL_POLICIES) {
      expect(text, `${name} 没说明新增的轮询频率`).toMatch(/每 10 分钟/);
    }
    // 频率必须与代码里的常量一致
    const sw = SW.replace(/^\s*\/\/.*$/gm, '');
    expect(sw, 'sw 里的轮询间隔与政策写的对不上').toMatch(/TASK_POLL_MINUTES = 10/);
  });

  it('🔒 明说不回传截图（这是与「读正文」最容易被混淆的一件事）', () => {
    for (const [name, text] of ALL_POLICIES) {
      expect(text, `${name} 没说清不回传截图`).toMatch(/不含截图|不回传截图/);
    }
  });
});

// 政策里现在有**两处**滚动说明（插件采竞对主页 / 整机版驱动本机浏览器跑配方），
// 它们的上限是两组不同的数。上面那条只查了主页那处——这条补上「每一处都要带自己那组上限」，
// 否则将来再加第三处滚动，它可以完全不写上限而两条守卫都绿。
describe('每一处滚动说明都要带自己那组上限', () => {
  it('🔒 配方那处（整机版本机浏览器）写明了屏数与行数上限', () => {
    const web = read('app/(public)/legal/privacy/page.tsx');
    const i = web.indexOf('采集配方');
    expect(i, '政策里没有采集配方那一段').toBeGreaterThan(0);
    const around = web.slice(i, i + 2400);
    expect(around, '配方段落里没写滚动').toContain('向下滚动');
    expect(around, '没写屏数上限').toContain('15 屏');
    expect(around, '没写行数上限').toContain('50');
    expect(around, '没说清滚动不等于点击').toContain('不点击任何按钮');
  });

  // ── 2026-08-30：这条守卫原来守的是 `/\d/` ─────────────────────────────────
  //
  // 「附近有没有数字」在一个 1500 字的窗口里几乎恒真——版本号 0.9.10、
  // 「单张 1MB」、「300 字」随便哪一个都够。新增一段**完全没有上限**的滚动说明照样绿。
  // 判据改成两条都要成立：
  //   ① 附近有真正的**上限措辞**（最多 / 不超过 / 上限），不是随便一个数字；
  //   ② 那几个数字与**代码里的常量对得上**——政策上写 12 次、代码改成 40 次时要红。
  it('🔒 政策里出现的每一处「向下滚动」附近都得有数字上限', () => {
    const web = read('app/(public)/legal/privacy/page.tsx');
    let from = 0;
    let seen = 0;
    for (;;) {
      const i = web.indexOf('向下滚动', from);
      if (i < 0) break;
      seen += 1;
      // 【作用域必须是同一个 <li>，不能是「附近 N 个字符」】
      // 第一版用的是 slice(i-600, i+900)。变异验证当场抓到：在 2.1 节末尾新插一段
      // **完全没有上限**的滚动说明，窗口往前 600 字捞到了**邻居条目**的「最多 12 次」，
      // 于是照样绿。一个条目就是一项披露，上限必须写在它自己这一条里。
      const liStart = web.lastIndexOf('<li>', i);
      const liEnd = web.indexOf('</li>', i);
      // 【先把 -1 挡掉再切】否则 slice(-1, …) / slice(…, -1) 会切出一段谁也没想要的文本，
      // 而断言可能恰好在那段上成立——这正是本项目归档的第八种假绿
      //（见 tests/fake-green-guard.test.ts；这一段刚写完就被它抓了一次）。
      if (liStart < 0 || liEnd < 0) {
        throw new Error(`第 ${seen} 处滚动说明不在任何 <li> 里，这条守卫的作用域判断要跟着改`);
      }
      const item = web.slice(liStart, liEnd);
      expect(
        /(最多|不超过|上限)\s*[0-9]/.test(item),
        `第 ${seen} 处滚动说明**这一条里**没有上限措辞。`
        + '（只看「附近有没有数字」是不够的：版本号、字数限制，甚至隔壁条目的上限，'
        + '都会让那种判据恒真。）',
      ).toBe(true);
      from = i + 1;
    }
    expect(seen, '一处滚动说明都没找到，这条守卫自己坏了').toBeGreaterThanOrEqual(2);
  });

  it('🔒 政策上写的滚动上限与代码里的常量对得上', () => {
    // 【为什么要绑常量】只验「政策里写了个数」防不住「代码把 12 改成 40 而政策没动」——
    // 那时对外承诺的上限就成了假的，而且不会有任何东西变红。
    const web = read('app/(public)/legal/privacy/page.tsx');

    // ① 插件侧（主页作品列表的懒加载）：轮数与墙钟预算
    const common = read('extension/content/common.js');
    const rounds = /const DEEP_MAX_ROUNDS = (\d+);/.exec(common)?.[1];
    const budgetMs = /const DEEP_BUDGET_MS = (\d+);/.exec(common)?.[1];
    expect(rounds, '插件里的滚动轮数常量不见了，这条守卫要跟着改').toBeTruthy();
    expect(budgetMs).toBeTruthy();
    expect(web, `政策里的滚动次数上限与 DEEP_MAX_ROUNDS(${rounds}) 对不上`)
      .toContain(`最多 ${rounds} 次`);
    expect(web, `政策里的滚动时长上限与 DEEP_BUDGET_MS(${budgetMs}ms) 对不上`)
      .toContain(`不超过 ${Number(budgetMs) / 1000} 秒`);

    // ② 服务端/CDP 侧（整机版的有界滚动）：屏数
    expect(web, `政策里的屏数上限与 MAX_SCROLL_SCREENS(${MAX_SCROLL_SCREENS}) 对不上`)
      .toContain(`最多 ${MAX_SCROLL_SCREENS} 屏`);
  });
});

// ── 承诺「可以关掉」的开关，界面上必须真的能关（2026-08-30 修）──────────────
//
// 隐私政策写着「一个**每 10 分钟的轮询**（可在插件设置页关闭）」，
// sw.js 的 armTaskPollAlarm 也确实读 `taskPoll` 并在它变化时重设闹钟，
// 连它上面那行注释都写着「用户可以在设置页关掉它」——
// 而**全项目没有任何地方写这个键**：设置页上从来就没有这个开关。
// 三处都以为有，只有界面没有。用户找遍设置也关不掉一个我们承诺他能关的后台请求。
//
// 这与「写了没接」是同一形状，只是缺的那一半在界面上而不是在调用点上。
describe('🔒 政策里说「可关闭」的，设置页上要真的写得了', () => {
  const optsJs = read('extension/options.js');
  const optsHtml = read('extension/options.html');
  const sw = read('extension/sw.js');

  /** 存储键 → 政策里那句承诺的关键词。加一个「可关闭」的能力就往这里加一行。 */
  const SWITCHES: [string, string][] = [
    ['taskPoll', '每 10 分钟的轮询'],
    ['scheduledCollect', '每日定时采集'],
    ['commentCollectOwn', '评论'],
    ['autoClickPublish', '代点发布'],
  ];

  it.each(SWITCHES)('%s：政策里确实承诺了可关', (key, phrase) => {
    const web = read('app/(public)/legal/privacy/page.tsx');
    const md = read('extension/store/privacy.md');
    expect(
      web.includes(phrase) || md.includes(phrase),
      `政策里找不到「${phrase}」——要么承诺没了（那这条守卫该删），要么措辞改了`,
    ).toBe(true);
  });

  it.each(SWITCHES)('%s：设置页上有控件，且真的写得进 storage', (key) => {
    expect(optsHtml, `设置页上没有 id="${key}" 这个控件`).toContain(`id="${key}"`);
    // 【必须验「写」而不只是「读」】只读不写正是这次的缺陷形状：
    // sw.js 读得好好的，而没有任何地方写它，于是那个开关等于不存在。
    expect(
      optsJs,
      `${key} 只有读没有写——设置页上摆了个控件却存不进去，和没有一样`,
    ).toMatch(new RegExp(`chrome\\.storage\\.sync\\.set\\(\\{[^}]*\\b${key}\\b`));
  });

  it('🔒 sw.js 里每个读 storage 开关的键，设置页都得写得了它', () => {
    // 这条是上面那张表的兜底：**新加一个开关时不必记得来改这份清单**，
    // 只要 sw.js 读了某个 sync 键、而 options.js 从来不写它，这里就会红。
    const readKeys = new Set<string>();
    for (const m of sw.matchAll(/chrome\.storage\.sync\.get\(\[([^\]]*)\]\)/g)) {
      for (const raw of m[1].split(',')) {
        const k = raw.trim().replace(/^['"]|['"]$/g, '');
        if (k) readKeys.add(k);
      }
    }
    expect(readKeys.size, '一个 sync 读取都没扫到，扫描逻辑坏了').toBeGreaterThan(5);

    /** 不该由设置页控制的键，每条写明理由。 */
    const NOT_A_SETTING: Record<string, string> = {
      host: '服务器地址，由令牌桥或用户手填，不是开关（options.js 里另有 hostEl 在写）',
      token: '采集令牌，同上（tokenEl 在写）',
      selfAccountId: '回填账号绑定，由侧栏与 popup 三个入口写，不在设置页',
      scheduledCollectHour: '时刻选择，由 scheduledCollectHourEl 写（不是 checkbox 那套判据）',
      selfAutoHour: '同上',
      wechatRiskAck: '风险确认，由 popup 的一次性弹窗写，刻意不放进设置页',
    };
    const unwritable = [...readKeys].filter(
      (k) => !NOT_A_SETTING[k]
        && !new RegExp(`chrome\\.storage\\.sync\\.set\\(\\{[^}]*\\b${k}\\b`).test(optsJs)
        && !optsJs.includes(`${k}:`),
    );
    expect(
      unwritable,
      `sw.js 读了这些 sync 键，但设置页写不了它们：${unwritable.join(', ')}。\n`
      + '要么补上控件，要么在本用例的 NOT_A_SETTING 里写明为什么不该由用户控制。\n'
      + '（这次真踩的是 taskPoll：政策承诺「可在插件设置页关闭」，而那个开关根本不存在。）',
    ).toEqual([]);
  });
});
