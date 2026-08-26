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

export const BROWSER_TASK_KINDS = ['collect_competitor', 'collect_self', 'open_and_read'] as const;
export type BrowserTaskKind = (typeof BROWSER_TASK_KINDS)[number];

/**
 * 「回填自己的后台数据」目前**只支持公众号**。
 *
 * 这不是保守，是照着插件的实际能力写：extension/sw.js 的 `SELF_AUTO_ENTRY` 里只有
 * wechat 一个入口，它自己的注释写着「其它平台的入口等真机验证过再往这里加：
 * 加错了只是白开一个标签页等超时，却会让用户以为『在采』，那比不加更糟」。
 *
 * 放行别的平台 = 服务端排一个插件根本不会做的活，它会白跑到超时、重试三次、
 * 最后判失败——而用户全程以为在采。这正是本文件顶部第 ① 条要防的事。
 *
 * **加平台的顺序是：先给 SELF_AUTO_ENTRY 加入口并真机验证，再回来放宽这里。**
 */
const SELF_COLLECT_PLATFORMS = ['wechat'] as const;

export const browserTaskPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('collect_competitor'),
    /** 要采的竞对（WatchlistItem 里必须有它，服务端建任务时校验） */
    competitorId: z.string().min(1).max(64),
    /** 采几条作品。插件端硬上限 50（服务端一批的上限），超了整批会被打回 */
    limit: z.number().int().min(1).max(50).default(20),
  }),
  z.object({
    kind: z.literal('collect_self'),
    /** 去哪个平台的创作后台回填自己的数据 */
    platform: z.enum(SELF_COLLECT_PLATFORMS),
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
]);

export type BrowserTaskPayload = z.infer<typeof browserTaskPayloadSchema>;

/** 给人看的动作名（运行中心、插件侧栏都用它）。 */
export const KIND_LABEL: Record<BrowserTaskKind, string> = {
  collect_competitor: '去采一个竞对',
  collect_self: '回填自己的后台数据',
  open_and_read: '去读一个网页',
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
  // **将来若加了「替用户在创作后台填内容」这类会产生对外动作的任务，一律返回 false**
  // ——重试一次就是多发一条。
  return kind === 'collect_competitor' || kind === 'collect_self' || kind === 'open_and_read';
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
