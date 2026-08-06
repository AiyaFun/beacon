// 公众号竞对采集的节流规则 —— **唯一事实源**。
//
// 三处必须一致：
//   · 本文件            → 网页上展示给用户看的规则
//   · extension/content/wechat-competitor.js → 一次采集**内部**的节流（翻几页、隔多久、取多久内的）
//   · extension/sw.js   → 两次采集**之间**的节流（同号冷却、每轮上限、撞频控后停多久）
//
// tests/ingest/wechat-collect-rules.test.ts 会读那两个 js 文件把数字比对回来：改了这里没改插件
// （或反过来）直接测红。理由很实在——「界面上写的规则」和「代码里执行的规则」对不上，是这类
// 功能最容易骗人的地方：用户以为一天只采一次，实际点一次采一次，账号被限了都不知道为什么。
//
// 定这些数的依据：这条通道用的是用户**自己**的公众号后台登录态，非官方接口。踩线的后果由用户
// 自己的号承担，所以一律往保守取——采得慢一点没有代价，被限接口有。

export const WECHAT_COLLECT_RULES = {
  /** 单次采集最多翻几页 */
  maxPages: 2,
  /** 每页条数（微信后台一页 10 条） */
  pageSize: 10,
  /** 只取最近多少天的文章，早于此即停止翻页 */
  recentDays: 7,
  /** 两次请求之间的随机间隔（毫秒），下界 */
  minGapMs: 3000,
  /** 两次请求之间的随机间隔（毫秒），上界 */
  maxGapMs: 6000,
  /**
   * 同一个公众号多少小时内只采一次。**只按本机（你自己）的采集记录算**。
   * 别人采过不拦你：冷却是为了保护你自己那个公众号后台账号的频率预算，而别人用他自己的号
   * 和 IP 采集并不消耗你的额度。（他采到的文章你本来就能看到——竞对档案是全局共享表。）
   */
  perAccountCooldownHours: 12,
  /** 一轮批量采集最多处理几个公众号 */
  maxAccountsPerRun: 5,
  /** 一轮里换下一个公众号前至少等多久（毫秒） */
  betweenAccountsMs: 30_000,
  /** 撞上微信频控后，多少分钟内不再发起公众号采集 */
  rateLimitCooldownMinutes: 30,
} as const;

export type WechatCollectRules = typeof WECHAT_COLLECT_RULES;

/** 展示用规则清单（网页与插件提示共用同一套措辞，免得两处各说各话）。 */
export function wechatCollectRuleLines(r: WechatCollectRules = WECHAT_COLLECT_RULES): string[] {
  return [
    `每次只取最近 ${r.recentDays} 天、最多翻 ${r.maxPages} 页（约 ${r.maxPages * r.pageSize} 篇），翻到更早的就停`,
    `每个请求之间随机等 ${r.minGapMs / 1000}–${r.maxGapMs / 1000} 秒，不连发`,
    `同一个公众号，你自己 ${r.perAccountCooldownHours} 小时内只采一次（别人采过不拦你；他采到的文章你本来就看得到，竞对数据全局共享）`,
    `一轮最多采 ${r.maxAccountsPerRun} 个公众号，换号之间再等 ${r.betweenAccountsMs / 1000} 秒`,
    `一旦被微信提示操作频繁，立即停止并 ${r.rateLimitCooldownMinutes} 分钟内不再发起，不重试`,
    '只读文章标题/链接/发布时间，不下正文、不取阅读量；用的是你自己公众号后台的登录态，token 不上传',
  ];
}
