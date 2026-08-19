import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
    const behavior = read('tests/legal/removal-resolve.test.ts');
    expect(behavior).toContain('readerComments');
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
      const i = text.indexOf('向下滚动');
      const around = text.slice(Math.max(0, i - 400), i + 900);
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
