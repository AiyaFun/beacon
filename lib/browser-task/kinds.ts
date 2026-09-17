import { z } from 'zod';
import { isReadAllowed } from './read-allowlist';

// ── 浏览器能替 AI 做的事：白名单 ────────────────────────────────────────────
//
// 【为什么必须是白名单】这里的每一项最终都会在**用户已登录的浏览器里**执行，
// 带着他的登录态去访问平台。让 AI 生成任意指令（「打开这个 URL、点这个按钮」）
// 等于把一个可远程驱动的浏览器交到模型手上——那不是功能，是漏洞。
// 与 lib/agent/tools.ts 同一条原则：没注册的就是做不了，想让它会新事就来这张表加一项。
//
// 【每项三个必答问题】
//   ① 插件真的会做这件事吗？—— 白名单里只能有插件**已经实现**的动作，
//      不能先在服务端排一个插件不认识的活（它会一直失败到过期，用户还以为在跑）。
//   ② 它需要用户的登录态吗？—— 需要的话必须在隐私政策里已披露的范围内。
//   ③ 失败了要不要重试？—— 采集类可以重试；任何会**产生对外动作**的一律不重试。

export const BROWSER_TASK_KINDS = [
  'collect_competitor',
  'collect_self_profile',
  'open_and_read',
  'collect_self_backend',
  'collect_competitor_recipe',
  'collect_self_recipe',
] as const;
export type BrowserTaskKind = (typeof BROWSER_TASK_KINDS)[number];

/**
 * 【已删除的 kind：collect_self】2026-09-03 移除公众号采集时一并删掉。
 *
 * 它唯一支持的平台是公众号：插件开用户**自己**已登录的公众号后台、换 token、站内跳两次再读数。
 * 那条通道整条撤掉之后，这个 kind 没有任何平台可派——留着就是让服务端能排一个插件不会做的活，
 * 正是本文件顶部第 ① 条要防的事。
 *
 * 2026-09-15 起创作者后台的自有回填由 **collect_self_backend** 承担（见下）。它不是 collect_self
 * 的复活：名字不同是刻意的——老插件对 collect_self 有一套只认公众号的步进机，认到旧名字就会去开
 * mp.weixin.qq.com；新名字老插件不认识，会立刻交回「请更新插件」，而不是白开一个标签页等超时。
 */

/**
 * 「回填自己主页上的数据」支持的平台（2026-09-03；2026-09-15 加 YouTube）。
 *
 * 这些平台的自有数据就摆在自己的公开主页上——X 的浏览量对所有人可见，
 * TikTok 主页九宫格每条封面都带播放量，YouTube 频道页的视频列表带播放量、且插件的
 * youtube.js 能认出「这是我自己的频道」。插件的 `batchCollectSelf`（extension/sw.js 的
 * SELF_COLLECT_URL）按 handle 打开这些主页回填，服务端派活只是把账号与 handle 对上再排队：
 * 它曾与只认公众号的 collect_self 并存（那个 kind 已随公众号采集一起删除）：分成两个 kind
 * 而不是放宽一个 enum，是因为老版本插件拿到 collect_self + platform=x 会照着公众号那套步进机
 * 去开 mp.weixin.qq.com（它不看 platform），白开一个标签页等 90 秒超时；新 kind 老插件不认识，
 * 会立刻交回「请更新插件」。这正是文件顶部第 ① 条要防的事。
 *
 * 加平台的顺序仍然是：先给 SELF_COLLECT_URL 加入口并真机验证，再回来放宽这里。
 */
export const SELF_PROFILE_PLATFORMS = ['x', 'tiktok', 'youtube', 'douyin', 'xiaohongshu', 'bilibili'] as const;

/**
 * 【2026-09-16 起抖音/小红书/B站也能采自己的公开主页】用户原话：「每一个平台都可以通过插件或者调用浏览器
 * 的方式采集对应的数据」。这三个平台的公开主页与竞对主页是同一张页、同一个解析器（douyin.js / xhs.js /
 * bilibili.js 采竞对时就在读它），有 handle 就能开；公开页上只有播放/点赞/评论这类公开数字，完播率、
 * 流量来源仍只有创作者后台才有——所以它们是**后台回填的退路**，不是替代：派活时后台优先，
 * 没有会进后台的执行器（旧插件、旧客户端）才退到主页，且回执里要说破「这是公开数字」。
 * 视频号/公众号没有公开主页，只有后台一条路。
 */
export function selfProfileFallbackFor(platform: string): boolean {
  return (SELF_PROFILE_PLATFORMS as readonly string[]).includes(platform);
}

/**
 * 「回填自己创作者后台的数据」支持的平台（2026-09-15）。
 *
 * 这些平台的自有数据不在公开主页上（完播率、粉丝画像、阅读来源只有后台有），住在各自的创作者后台：
 * 视频号 channels.weixin.qq.com / 抖音 creator.douyin.com / 小红书 creator.xiaohongshu.com /
 * B站 member.bilibili.com / 公众号 mp.weixin.qq.com。
 *
 * 【谁会做（2026-09-16 起三条路都会）】插件在用户日常登录着的 Chrome 里打开后台页、由内容脚本读数；
 * 桌面客户端在**采集专用浏览器**（独立 profile，登录态长存，见 desktop/src-tauri/src/collect_browser.rs）
 * 里打开同一批后台页，注入同一份 self-backend.js（从 /api/ingest/executor?kind=collect_self_backend 现取）
 * 读数后交回；整机版的本机浏览器同理（lib/browser/local-collect.ts collectBackendLocal）。
 * 后台入口地址在 lib/browser-task/backend-entries.ts（与 extension/sw.js 的 SELF_AUTO_CORE_ENTRIES 同一份，
 * 有测试钉着）；站内走哪几页由 self-backend.js 的 autoRoutes 决定，三条路一份。
 * 此前这里写的是「只有浏览器插件会做」——那是 2026-09-15 那一版的事实，用户 2026-09-16 明确要求
 * 「每一个平台都可以通过插件或者调用浏览器的方式采集」，桌面客户端/本机浏览器随之补上。
 *
 * 【公众号是可选模块】插件里要先在设置页单独授权 mp.weixin.qq.com；桌面客户端/本机浏览器那条路不需要
 * 授权（采集浏览器是我们自己的 profile），但要服务端这个发行版带 self-backend-wechat.js（开源发行版不带，
 * loadBackendSources 会如实拒绝）。**服务端不知道插件授权状态**，派给插件之前只能把这句话预先告诉用户。
 */
export const SELF_BACKEND_PLATFORMS = ['shipinhao', 'douyin', 'xiaohongshu', 'bilibili', 'wechat'] as const;

/**
 * 没有手写解析器、靠「采集配方」采竞对的平台（2026-09-15）。
 *
 * 微博/快手/知乎/头条/百家号在 extension/content 里没有主页解析器，插件用服务端学出来的配方
 * （lib/scrape/recipe.ts：先上传脱敏骨架 → 服务端学规则 → 插件按规则取值）去采；且插件对这些站点
 * 是**按需单站点授权**——用户要先在侧边栏对该站点授权一次，插件才拿得到页面。
 * 2026-09-16 起桌面客户端与本机浏览器也会做：服务端把 extension/tools/recipe-run.js 与这个工作区的
 * 内置配方一起下发（/api/ingest/executor?kind=collect_competitor_recipe），执行器在采集浏览器里按规则取值、
 * 把行/骨架原样交回，学习与映射仍在服务端一份（lib/browser-task/local-run.ts ingestRecipeOutcome）。
 * 采集浏览器不需要站点授权（按需授权是 Chrome 扩展模型的事，独立 profile 没有这层）。
 *
 * 【自己的主页也走配方】这五个平台的用户自有账号（微博号/快手号/知乎号/头条号/百家号）与竞对是同一张
 * 公开主页，同一份配方能读；kind=collect_self_recipe（platform + accountId + handle），行映射进自有作品
 * 而不是竞对库（lib/scrape/platform-map.ts ingestPlatformRecipeRowsAsOwn）。
 */
export const RECIPE_PLATFORMS = ['weibo', 'kuaishou', 'zhihu', 'toutiao', 'baijiahao'] as const;

/**
 * 用户说「回填我的 <平台>」时**优先**该派哪个 kind（2026-09-16 起每个平台都有一条）。
 * 创作者后台类 → collect_self_backend（抖音/小红书/B站也在主页表里，那是退路，见 selfProfileFallbackFor）；
 * 主页类 → collect_self_profile；配方平台 → collect_self_recipe；
 * null = 这个平台没有服务端能派的自有回填路（PLATFORMS 之外的键才会走到这里）。
 */
export function selfCollectKindFor(platform: string): 'collect_self_profile' | 'collect_self_backend' | 'collect_self_recipe' | null {
  // 后台优先：抖音/小红书/B站既在后台表也在主页表，完播率/流量来源只有后台有——主页只是没执行器会进后台时的退路
  if ((SELF_BACKEND_PLATFORMS as readonly string[]).includes(platform)) return 'collect_self_backend';
  if ((SELF_PROFILE_PLATFORMS as readonly string[]).includes(platform)) return 'collect_self_profile';
  if ((RECIPE_PLATFORMS as readonly string[]).includes(platform)) return 'collect_self_recipe';
  return null;
}

/** 采某个平台的竞对该派哪个 kind：配方平台走 collect_competitor_recipe，其余走手写解析器那条 collect_competitor。 */
export function competitorKindFor(platform: string): 'collect_competitor_recipe' | 'collect_competitor' {
  return (RECIPE_PLATFORMS as readonly string[]).includes(platform) ? 'collect_competitor_recipe' : 'collect_competitor';
}

export const browserTaskPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('collect_competitor'),
    /** 要采的竞对（WatchlistItem 里必须有它，服务端建任务时校验） */
    competitorId: z.string().min(1).max(64),
    /** 采几条作品。插件端硬上限 50（服务端一批的上限），超了整批会被打回 */
    limit: z.number().int().min(1).max(50).default(20),
  }),
  z.object({
    kind: z.literal('collect_self_profile'),
    /** 去哪个平台的**自己主页**回填（见 SELF_PROFILE_PLATFORMS） */
    platform: z.enum(SELF_PROFILE_PLATFORMS),
    /** 记在哪个账号名下。服务端按工作区账号解析好再派，插件不再猜归属 */
    accountId: z.string().min(1).max(64),
    /** 主页地址由它拼（extension/sw.js SELF_COLLECT_URL）。来自 CreatorAccount.handle */
    handle: z.string().min(1).max(128),
  }),
  z.object({
    kind: z.literal('open_and_read'),
    /**
     * 要读的网页。**必须在域名白名单里**（lib/browser-task/read-allowlist.ts）。
     *
     * 这是唯一一个由服务端指定 URL、让用户已登录的浏览器去打开的动作，
     * 所以这道校验在三个地方各做一次，一处都不能省：
     *   ① 这里（服务端排活时，早失败早说清楚）；
     *   ② 插件端的硬编码清单（**那份才是真正的防线**——服务端地址是可配的）；
     *   ③ 页面加载完成后按最终 URL 复验（白名单域里到处是跳转口）。
     */
    url: z.string().url().max(500).refine(isReadAllowed, {
      message: '这个网址不在允许插件打开的站点清单里',
    }),
    /**
     * 读法：article=只取正文（长文用，去掉导航与推荐位），text=整页可见文字。
     * 拿不准就用 article——整页文字里那些「猜你喜欢」会把模型带跑。
     */
    mode: z.enum(['article', 'text']).default('article'),
  }),
  z.object({
    kind: z.literal('collect_self_backend'),
    /** 去哪个平台的**创作者后台**回填（见 SELF_BACKEND_PLATFORMS）。后台地址由插件自己知道，服务端不拼 */
    platform: z.enum(SELF_BACKEND_PLATFORMS),
    /**
     * 记在哪个账号名下。服务端按工作区账号解析好再派。
     * **不带 handle**：后台页认的是登录态，页面自己会说出这是哪个号；账号没填 handle 也不该拦住后台回填。
     */
    accountId: z.string().min(1).max(64),
  }),
  z.object({
    kind: z.literal('collect_competitor_recipe'),
    /** 要采的竞对（WatchlistItem 里必须有它，服务端建任务时校验）；平台必须在 RECIPE_PLATFORMS 里 */
    competitorId: z.string().min(1).max(64),
    /** 采几条作品。与 collect_competitor 同口径：插件端硬上限 50 */
    limit: z.number().int().min(1).max(50).default(20),
  }),
  z.object({
    kind: z.literal('collect_self_recipe'),
    /** 去哪个配方平台的**自己主页**按配方回填（见 RECIPE_PLATFORMS） */
    platform: z.enum(RECIPE_PLATFORMS),
    /** 记在哪个账号名下。服务端按工作区账号解析好再派 */
    accountId: z.string().min(1).max(64),
    /** 主页地址由它拼（lib/competitor-url.ts competitorHomeUrl，插件端 SELF_COLLECT_URL 同一套拼法） */
    handle: z.string().min(1).max(128),
  }),
]);

export type BrowserTaskPayload = z.infer<typeof browserTaskPayloadSchema>;

/** 给人看的动作名（运行中心、插件侧栏都用它）。 */
export const KIND_LABEL: Record<BrowserTaskKind, string> = {
  collect_competitor: '去采一个竞对',
  collect_self_profile: '去自己的主页回填数据',
  open_and_read: '去读一个网页',
  collect_self_backend: '回填创作者后台',
  collect_competitor_recipe: '按配方采集竞对',
  collect_self_recipe: '按配方回填自己的主页',
};

/**
 * 失败了能不能自动重试。
 *
 * 采集类可以：它是幂等的读操作，多跑一次最多是多花一点时间。
 * 将来若加了「替用户在创作后台填内容」这类**会产生对外动作**的任务，
 * 一律返回 false —— 重试一次就是多发一条。
 */
export function retriable(kind: BrowserTaskKind): boolean {
  // open_and_read 也可以重试：它是纯读，多打开一次页面最多多花几秒。
  // collect_self_backend / collect_competitor_recipe 同样是只读采集（进后台只**读**数、按配方只**取**值），
  // 与 collect_competitor 同一档。
  // **将来若加了「替用户在创作后台填内容」这类会产生对外动作的任务，一律返回 false**
  // ——重试一次就是多发一条。
  return kind === 'collect_competitor' || kind === 'collect_self_profile' || kind === 'open_and_read'
    || kind === 'collect_self_backend' || kind === 'collect_competitor_recipe' || kind === 'collect_self_recipe';
}

/**
 * 一次回执最多带回多少字符的页面文本。
 *
 * 【为什么是「截断」不是「分片」】分片要引入分片号、重组、超时半截的处理，
 * 是一整套新的失败模式；而 6 万字远超任何一次抽取需要的量（服务端抽取那步
 * 本来也只取前几千字）。截断不打回——展示用的长文本超长就截断，
 * 打回整批只会让用户看到一句「数据格式不合法」。
 *
 * 【上限从哪来的】宝塔 WAF 对超过 client_body_buffer_size 的请求体会回
 * 「HTTP 200 + HTML 错误页」（阈值约 256KB），插件那边看到的是一次假成功。
 * 6 万字符经 JSON 转义后大约 60-180KB，留足余量。
 */
export const MAX_READ_TEXT_CHARS = 60_000;

/** 最多重试几次。超过就判失败，别让一个死任务把插件的每一轮都占掉。 */
export const MAX_ATTEMPTS = 3;

/**
 * 任务多久算过期。
 *
 * 取 2 天：这些任务的价值全在时效性上——三天前让采的竞对数据，
 * 现在采回来既解答不了当时那个问题，还会把「今天的采集」挤掉。
 * 过期不是失败，是「不用做了」，界面上要分开说。
 */
export const TASK_TTL_HOURS = 48;

/**
 * 领走之后多久没交活就放回池子。
 *
 * 插件可能被关掉、浏览器可能崩、用户可能直接关机——领了不还是常态而不是异常。
 * 取 15 分钟：比一次采集（含翻页、节流等待）的最坏耗时宽一些，又不至于让一个
 * 死掉的浏览器把任务扣住半天。
 */
export const LEASE_MINUTES = 15;

/**
 * 同一个活刚采完多久之内不再采（2026-09-04）。
 * 用户真机看到的是：采集浏览器反复开、关、开，同一个主页被采了五遍——对平台来说这就是可疑行为。
 * 半小时内同一 payload 的任务已经 done，就直接把那次结果给 AI，不再排新的。
 */
export const RECOLLECT_COOLDOWN_MINUTES = 30;
/**
 * 失败后的重试退避：第 n 次失败后至少等这么久再让执行器领（分钟）。
 * 原先失败即刻放回池子，执行器下一分钟就再领——三次失败挤在三分钟里，同样是「反复开关浏览器」。
 *
 * 【第一次失败不退避】（2026-09-15 真机）采集浏览器冷启动的第一次尝试 32 秒失败 → 按 10 分钟退避 →
 * 第二次 20 秒成功；用户等了 11 分钟，其中 10 分钟在等一个不该有的退避。退避防的是「三次失败挤在三分钟里」，
 * 而第一次失败后立刻再试一次，与用户自己再派一次没有区别（执行器复用同一页，不是再开一个窗口）。
 * 第二次再失败才退 10 分钟；第三次失败判死（MAX_ATTEMPTS）。
 * 例外见 backoffMinutesAfterFailure：错误明确要用户动手（登录墙/人机验证/限频）时，立刻重试只会把登录页
 * 再弹到他面前——照旧退避；客户端已经当场重试过一次的（retriedAfter）也照旧退避。
 */
export const RETRY_BACKOFF_MINUTES = [0, 10] as const;
/** 第一次失败但错误要用户动手 / 客户端已当场重试过时，用这个退避（分钟） */
export const FIRST_FAILURE_GUARDED_BACKOFF_MINUTES = 10;

/**
 * 错误里出现这些字样 = 要用户动手（登录、过验证、等限频解除），机器立刻重试没有意义。
 * 桌面执行器与插件各有各的措辞，都列在这里；改措辞时两边一起改（tests/browser-task/retry-and-attempt-log 钉着）。
 */
export const USER_ACTION_ERROR_HINTS = [
  '等你在采集浏览器里登录', // 桌面执行器：撞硬登录墙，等了几分钟没登上
  '所以读不到你的内容', // 桌面执行器：软信号判出没登录
  '人机验证', '访问过于频繁', '验证码',
  '没登录', '未登录', '请先登录', // 插件那条路的措辞
] as const;
/**
 * 「解析器取不到内容」那句人话里提到「还没登录」只是最常见原因的提示——页面没渲染完也报同一句，
 * 而那正是冷启动第一次失败的典型样子。它不算要用户动手。
 */
const NOT_USER_ACTION_HINTS = ['解析器取不到内容', 'parser_stale'] as const;

export function needsUserAction(error?: string | null): boolean {
  if (!error) return false;
  if (NOT_USER_ACTION_HINTS.some((s) => error.includes(s))) return false;
  return USER_ACTION_ERROR_HINTS.some((s) => error.includes(s));
}

/** 第 attempts 次失败后要退避几分钟（0 = 立刻可再领）。attempts 从 1 数。 */
export function backoffMinutesAfterFailure(attempts: number, error?: string | null, retriedInPlace = false): number {
  const n = Math.min(Math.max(attempts, 1), RETRY_BACKOFF_MINUTES.length);
  const base = RETRY_BACKOFF_MINUTES[n - 1] ?? FIRST_FAILURE_GUARDED_BACKOFF_MINUTES;
  if (base === 0 && (retriedInPlace || needsUserAction(error))) return FIRST_FAILURE_GUARDED_BACKOFF_MINUTES;
  return base;
}

/**
 * 令牌多久没来领活就不算「在线的执行器」（2026-09-05）。
 * 用户原话：「检测不到插件就立刻用浏览器」。原先只要令牌没吊销就算插件在——他半个月前装过、
 * 早已卸载的插件令牌照样让系统说「插件/桌面客户端都在」，还会把活派给一个永远不会来领的东西。
 * 判据用 lastUsedAt：插件约每 10 分钟领一次、桌面客户端 20 秒一次，而 lastUsedAt 的写入有
 * 10 分钟节流（lib/ingest/token.ts）——所以窗口要盖住「10 分钟轮询 + 10 分钟节流」，取 25 分钟。
 */
export const EXECUTOR_ALIVE_MINUTES = 25;
