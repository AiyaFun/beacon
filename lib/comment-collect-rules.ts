// 评论采集的硬上限——唯一事实源。
//
// 插件是纯 js、import 不了这里的 TS 常量，所以 extension/content/comments.js 里有一份**手抄**的副本
// （曾经写着「由 comment-rules.gen.js 生成」，但那个生成器从来没存在过——照着这句话去找会扑空）。
// 手抄就必须有人盯着：tests/ingest/comment-questions.test.ts 逐个数字比对两边，改一处不改另一处直接红。

export const MAX_COMMENTS_READ = 200;
export const MAX_QUESTIONS_PER_RUN = 12;
export const RATE_LIMIT_PER_HOUR = 30;
export const MIN_LEN = 5;
export const MAX_LEN = 60;
export const STALE_DAYS = 90;
export const PURGE_DAYS = 180;

/**
 * 一句话要被**至少这么多人**问过，才会作为「读者提问」进灵感箱。归并后 count=1 的不进。
 *
 * ⚠️ 这个阈值管的是**灵感箱/选题候选池**那条链路，不是「评论正文留存」那条（后者见
 * COMMENT_TEXT_PURGE_DAYS 的长注释）。两条链路的口径不同，是刻意的：
 *
 *   · 进灵感箱的提问会被**当作创作输入**参与选题排序、喂进 AI 上下文。放到那个位置上的，
 *     必须是「读者共同的疑问」这种需求信号，而不是某一个人说过的一句话——
 *     这正是「把第三方 UGC 用于生产」能站得住的那个论证，阈值拿掉论证就跟着失效。
 *   · 读者原声（ReaderComment）只被**用户本人阅读**和做聚合统计，不进候选池、不进语料池、
 *     不参与任何生成，所以它按另一套护栏走（无身份信息 + 保留期 + 随移除申请删）。
 *
 * 改这个数之前先改隐私政策，且两边由 tests/ingest/comment-questions.test.ts 钉死。
 */
export const MIN_ASKED_TO_STORE = 2;

/**
 * ── 评论正文（ReaderComment）专用 ──
 *
 * 2026-08-11 按「要能逐条读评论、看清粉丝在关心什么」的需求放开了原先「正文一律不落库」
 * 的口径。放开的是**正文文本**，不是身份信息——下面这份不采清单一个字没松：
 *   见下方 COMMENT_NEVER_COLLECTED（**唯一事实源**，三份政策都要逐项写到）。
 * 回传结构里根本没有这些字段（extension/content/comments.js），服务端 zod 也不收。
 *
 * 换来的四条护栏（缺一条这功能就不该上线，tests/ingest/reader-comment.test.ts 逐条钉死）：
 *   ① **保留期**：正文最多留 COMMENT_TEXT_PURGE_DAYS 天，到期自动物理删除（不是归档）。
 *      提问短句是需求信号可以长期留，别人说过的话不行。
 *   ② **绝不进生成语料池**：原句样本只取 Material(type=sample)/PublishRecord/DraftVersion(human)。
 *      与文章剪藏同一条红线（tests/clip/never-in-exemplar.test.ts 的同款守卫）。
 *   ③ **随移除申请一起删**：被监控账号申请退出时，它名下作品的评论正文跟着走
 *      （lib/legal/removal.ts 的 purgeRemovedAccountData）。
 *   ④ **不导出、不共享**：只落用户自己工作区（workspaceId + RLS），不进 CSV 导出、不进机器人回执。
 *
 * 改这里之前先改 extension/store/privacy.md 第 6 条与 app/(public)/legal/privacy——
 * 政策文本和代码由 tests/legal/privacy-promises.test.ts 同时断言。
 */
export const COMMENT_TEXT_PURGE_DAYS = 90;

/**
 * 评论采集**一概不取**的评论者信息 —— 三份政策文本逐项承诺的那份清单，**唯一事实源**。
 *
 * 提成常量而不是继续写在注释里，是因为 2026-08-13 发现它被手抄进了守卫测试（只抄了 6 项），
 * 而三份政策此刻**已经漂了**：站内 /legal/privacy 少了「@提及对象」，另两份有。
 * 守卫的全部意义就是「三份不许漂」，它却因为自己抄漏而全绿。
 * 现在 tests/legal/privacy-promises.test.ts 从这里读，加一项就自动要求三份政策都补上。
 *
 * ⚠️ 往这里加词之前先确认代码真的不取它——这份清单是对外承诺，不是愿望清单。
 */
export const COMMENT_NEVER_COLLECTED = [
  '昵称', '头像', '主页链接', '用户 ID', 'IP 属地',
  '评论时间', '点赞数', '楼层回复关系', '@提及对象',
] as const;

/** 单条评论正文的长度上限，超出截断（不丢弃——长评论往往信息量最大）。 */
export const MAX_COMMENT_TEXT_LEN = 300;

/** 一次采集最多回传多少条正文。与 MAX_COMMENTS_READ 同值：读到多少就是多少，不额外放大。 */
export const MAX_COMMENT_TEXTS_PER_RUN = MAX_COMMENTS_READ;

/**
 * 单个工作区最多留多少条评论正文，超出删最旧的。
 * 没有这个盖子，把每条作品都采一遍的重度用户能撑到几十万行——而读者原声越旧越没人看，
 * 留着只是在延长第三方 UGC 的留存面。
 */
export const MAX_READER_COMMENTS_PER_WORKSPACE = 5000;
