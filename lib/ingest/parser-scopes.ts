// ── 解析自学习的「范围」与「命名空间字段」──────────────────────────────────
//
// 【这个文件是什么】parser-learn 那条闭环（插件采不到 → 上传脱敏骨架 → 模型推断选择器
// → 骨架逐 token 验证 → 自动上线 → 规则包下发）原本只服务竞对主页的数字字段
//（followers / views / likes …）。2026-09-15 起把它扩到三块从没自校准过的地方：
//   · publish  —— 发布页填表：标题输入框、正文编辑器在哪
//   · comments —— 评论读取：评论区容器、单条评论条目在哪
//   · self     —— 创作者后台「作品数据」表：一行作品是哪个元素（新增字段 backend.rows）
//
// 【为什么字段名带命名空间】规则包（activeRulePack / 插件端 rule pack 缓存）**只按
// platform + field 取值**，没有 scope 这一维。`self` 范围早就有 followers 这类字段，
// 后台表格行如果也叫 `rows`、发布页标题如果也叫 `title`，就会和竞对作品页的 `title`
// 撞在同一个键上——一条学给发布页的选择器会被作品页解析器当成标题选择器用。
// 所以新字段一律 `publish.title` / `comments.item` / `backend.rows` 这种带前缀的写法，
// 前缀就是它的命名空间，和旧字段永远不会同键。
//
// 【插件端引用的是这些字面量】extension/content/publish-fill.js、comments.js、
// self-backend.js 上报 parser:miss 时写的就是下面 PARSER_FIELDS 里的字符串（插件是
// 纯 JS，import 不到这里）。tests/ingest/parser-scopes.test.ts 有一条同步守卫：
// 从这里读常量、去 grep 那三个文件，哪边改了名另一边没跟上就红。
//
// 【刻意不做：发布按钮不进规则包】发布页的「发布」按钮**只在插件端按按钮文字判**
//（publish-fill.js 里的文本匹配），绝不从学到的规则里取。填错标题框的代价是内容进错框、
// 用户发布前看得见；点错按钮的代价是把草稿发出去、或点到「删除」——不可逆，且是替用户
// 做的。一条学歪的选择器在这里没有「回滚就好」，所以这个字段不存在。
//
// 【这个文件必须保持纯常量】ParserPanel.tsx 是 client 组件，从这里取 SCOPE_LABEL。
// 一旦 import 了 prisma / gateway 之类的服务端模块，client bundle 就会炸。

export const PARSER_SCOPES = ['rival', 'self', 'publish', 'comments'] as const;
export type ParserScope = (typeof PARSER_SCOPES)[number];

export function isParserScope(raw: unknown): raw is ParserScope {
  return typeof raw === 'string' && (PARSER_SCOPES as readonly string[]).includes(raw);
}

/** 范围的展示文案。运维台与告警都从这里取，不再各写一份三元。 */
export const SCOPE_LABEL: Record<ParserScope, { zh: string; en: string }> = {
  rival: { zh: '竞对采集', en: 'Competitor ingest' },
  self: { zh: '自有采集', en: 'Self ingest' },
  publish: { zh: '发布填表', en: 'Publish form' },
  comments: { zh: '评论读取', en: 'Comment reading' },
};

/** 库里存的 scope 是 string；不认识的原样回显，别把它偷偷显示成「竞对」。 */
export function scopeLabel(scope: string, lang: string): string {
  if (!isParserScope(scope)) return scope;
  return lang === 'en' ? SCOPE_LABEL[scope].en : SCOPE_LABEL[scope].zh;
}

/**
 * 命名空间字段。插件端与服务端引用的**同一批字面量**——见文件头「插件端引用的是这些字面量」。
 *   publish.*  ← scope 'publish'（douyin / xiaohongshu / bilibili / shipinhao / zhihu / toutiao / baijiahao / kuaishou）
 *   comments.* ← scope 'comments'（douyin / bilibili / xiaohongshu / youtube / x / tiktok）
 *   backend.*  ← scope 'self'（shipinhao / douyin / xiaohongshu / bilibili / wechat）
 */
export const PARSER_FIELDS = {
  publishTitle: 'publish.title',
  publishBody: 'publish.body',
  commentsContainer: 'comments.container',
  commentsItem: 'comments.item',
  backendRows: 'backend.rows',
} as const;
export type NamespacedField = (typeof PARSER_FIELDS)[keyof typeof PARSER_FIELDS];

/**
 * 给诊断模型的一句话：这个字段要找的是**什么元素**。
 *
 * 旧字段（followers 之类）不需要——提示词本身就说「定位目标数字」。新字段找的是
 * 输入框 / 容器 / 表格行，模型没这句会照旧去骨架里找一个 NUM 位，然后给出一条
 * 指向数字的选择器：过得了骨架验证（类名真在骨架里），下发后插件却填不进去。
 */
export const FIELD_HINTS: Record<string, string> = {
  [PARSER_FIELDS.publishTitle]:
    '发布页的标题输入框，返回能 querySelector 到那个 input/textarea/contenteditable 元素的选择器',
  [PARSER_FIELDS.publishBody]:
    '发布页的正文编辑器（多为 contenteditable 或 textarea），返回能 querySelector 到编辑器元素本身的选择器',
  [PARSER_FIELDS.commentsContainer]:
    '评论区的列表容器（所有评论条目的共同父元素），返回能 querySelector 到该容器的选择器',
  [PARSER_FIELDS.commentsItem]:
    '单条评论的条目元素，每条评论一个，返回能 querySelectorAll 出全部条目的选择器',
  [PARSER_FIELDS.backendRows]:
    '创作者后台「作品数据」表里的一行（每行一条作品，行内有标题链接与数字列），返回能 querySelectorAll 出全部行的选择器',
};

/**
 * 这次事件要找的是「元素」还是「数字」。
 *
 * publish / comments 两个范围全是元素；self 范围里只有 backend.rows 是元素（followers
 * 那些仍是数字）。proposeSelectors 据此换提示词：元素目标下 anchors 允许为空——
 * 输入框旁边多半没有「粉丝」那种稳定标签文字，硬要模型给锚点只会逼它编。
 */
export function isElementTarget(scope: string, field: string): boolean {
  if (scope === 'publish' || scope === 'comments') return true;
  return field === PARSER_FIELDS.backendRows;
}
