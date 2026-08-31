// AI 爬虫的单一真相源（2026-08-29）。
//
// ── 为什么必须是「单一」真相源 ──
// 这个东西天生会散：robots.txt 里要写一份、识别代码里要写一份、界面上要展示一份、
// 文档里还要说一份。HeiGe-GEO-SEO 的审查里有一条病灶就是「**UA 表散落 4+ 处已矛盾**」——
// 散落之后没人知道哪份是对的，而它错了不会报错：robots 拦的是 A、代码认的是 B，
// 页面上显示的是 C，三者各自看起来都很正常。所以这里定死：**这张表是唯一的一份**，
// robots.ts、识别、界面全部从它派生。
//
// ── 这张表最容易被搞错的一件事：robots 令牌 ≠ User-Agent ──
// `Google-Extended` 和 `Applebot-Extended` **不是爬虫**，它们是只能写在 robots.txt 里的
// **策略令牌**：谷歌/苹果用它来问你「已经抓走的内容，允不允许拿去训练」。
// 它们**永远不会出现在任何一条请求的 User-Agent 里**。
// 把它们当 UA 去匹配，结果是「识别永远为零，而 robots 规则其实是对的」——
// 一个看起来像「AI 都不来」的假象，方向完全错。所以类型上就把两者分开（kind 字段）。
//
// ── 第二件容易搞错的：三种用途完全不是一回事 ──
// 同一家公司往往有三个爬虫，拦错一个的代价截然不同：
//   · training    拿去训练模型。拦了不影响你被检索到。
//   · search      建检索索引。**拦了 = 从此不可能被引用**，这是 GEO 上最贵的一次误操作。
//   · user_fetch  用户当场问问题时实时取回你这一页。拦了 = 用户问到你时它读不到。
// 「屏蔽 AI 爬虫」这句话在这三档上是三个不同的决定，混成一句就必然有人拦错。
//
// ── 证据纪律：与 lib/algorithm/ai-source.ts 同一条 ──
// **有公开文档才写，没有就是 null，绝不编一个看起来合理的 UA。**
// 国产引擎里只有 Bytespider 是长期公开可查的；元宝/文心/DeepSeek/Kimi 没有公开披露
// 独立的爬虫 UA —— 那就如实写 null，而不是猜一个。猜出来的 UA 会让 robots 规则
// 拦不到任何东西，而界面上显示「已拦截」，比不做更糟。

/** 这张表的口径版本。改任何一行都要连它一起改。 */
export const AI_CRAWLER_VERSION = '2026-08-29';
/**
 * 下次校准日期：2027-02-28。
 * AI 爬虫半年就会变一批（OAI-SearchBot 是 2024 下半年才有的，Claude 拆成三个更晚）。
 * 过期不改的后果不是「旧」，是拿一份已经不成立的清单去决定拦谁放谁。
 */
export const AI_CRAWLER_NEXT_REVIEW = '2027-02-28';

/** 这一条是真会发请求的爬虫，还是只能写在 robots.txt 里的策略令牌。 */
export type AiAgentKind = 'crawler' | 'robots_token';

/**
 * 用途三分。**拦错哪一档，代价完全不同**，所以任何界面上都必须把它显示出来，
 * 不许合并成「AI 爬虫」一个词。
 */
export type AiAgentPurpose = 'training' | 'search' | 'user_fetch';

export const PURPOSE_LABEL: Record<AiAgentPurpose, string> = {
  training: '拿去训练模型',
  search: '建检索索引（拦了就不可能被引用）',
  user_fetch: '用户当场提问时实时取回这一页',
};

export type AiAgent = {
  /** robots.txt 里写的那个名字。crawler 与 robots_token 都用它。 */
  token: string;
  /** 归谁 */
  operator: string;
  kind: AiAgentKind;
  purpose: AiAgentPurpose;
  /**
   * 用来在 User-Agent 里匹配的**小写子串**。
   * `kind: 'robots_token'` 的**必须是 null** —— 它不会出现在任何 UA 里，
   * 给它一个匹配串就是制造一个永远不会命中的规则，而界面上却像是在识别它。
   */
  uaMatch: string | null;
  /** 公开文档地址。查不到出处的条目不许进这张表。 */
  doc: string;
  /** 给人看的一句话。 */
  note: string;
};

/**
 * 有公开文档的 AI 代理。
 *
 * 【收录门槛】必须有官方公开文档说明这个名字。做不到就不收 —— 见文件头的证据纪律。
 * 【为什么把传统搜索引擎也放进来】bingbot 与 Baiduspider 不是 AI 爬虫，
 * 但 Copilot 用的是 bing 的索引、文心用的是百度的索引：**在国产/微软生态里，
 * 「被 AI 引用」的前置恰恰是「被传统搜索引擎收录」**。把它们排除在外，
 * 用户会以为「我只要放行 AI 爬虫就行」，而那正好漏掉最要紧的一条。
 */
export const AI_AGENTS: readonly AiAgent[] = [
  // ── OpenAI：三个分得最清楚的，拿它当理解另外几家的模板 ──
  {
    token: 'GPTBot', operator: 'OpenAI', kind: 'crawler', purpose: 'training', uaMatch: 'gptbot',
    doc: 'https://platform.openai.com/docs/bots',
    note: '抓内容用于训练。拦掉它不影响你被 ChatGPT 检索到。',
  },
  {
    token: 'OAI-SearchBot', operator: 'OpenAI', kind: 'crawler', purpose: 'search', uaMatch: 'oai-searchbot',
    doc: 'https://platform.openai.com/docs/bots',
    note: '给 ChatGPT 搜索建索引。**这条拦了就不可能被 ChatGPT 引用**，是最不该误拦的一个。',
  },
  {
    token: 'ChatGPT-User', operator: 'OpenAI', kind: 'crawler', purpose: 'user_fetch', uaMatch: 'chatgpt-user',
    doc: 'https://platform.openai.com/docs/bots',
    note: '用户当场问到你这一页时实时取回。拦了 = 有人问起你时它读不到。',
  },

  // ── Anthropic ──
  {
    token: 'ClaudeBot', operator: 'Anthropic', kind: 'crawler', purpose: 'training', uaMatch: 'claudebot',
    doc: 'https://support.anthropic.com/en/articles/8896518',
    note: '抓内容用于训练。',
  },
  {
    token: 'Claude-User', operator: 'Anthropic', kind: 'crawler', purpose: 'user_fetch', uaMatch: 'claude-user',
    doc: 'https://support.anthropic.com/en/articles/8896518',
    note: '用户当场提问时实时取回这一页。',
  },
  {
    token: 'Claude-SearchBot', operator: 'Anthropic', kind: 'crawler', purpose: 'search', uaMatch: 'claude-searchbot',
    doc: 'https://support.anthropic.com/en/articles/8896518',
    note: '给 Claude 的搜索建索引。',
  },

  // ── Perplexity ──
  {
    token: 'PerplexityBot', operator: 'Perplexity', kind: 'crawler', purpose: 'search', uaMatch: 'perplexitybot',
    doc: 'https://docs.perplexity.ai/guides/bots',
    note: '建索引。Perplexity 是引用来源标得最显眼的一家。',
  },
  {
    token: 'Perplexity-User', operator: 'Perplexity', kind: 'crawler', purpose: 'user_fetch', uaMatch: 'perplexity-user',
    doc: 'https://docs.perplexity.ai/guides/bots',
    note: '用户当场提问时实时取回。',
  },

  // ── 只能写在 robots.txt 里的策略令牌（不是爬虫，见文件头）──
  {
    token: 'Google-Extended', operator: 'Google', kind: 'robots_token', purpose: 'training', uaMatch: null,
    doc: 'https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers',
    note: '**不是爬虫**。Googlebot 已经抓走的内容，允不允许拿去训练 Gemini —— 只在 robots.txt 里表态。'
      + '拦它**不影响**你在谷歌搜索里的收录。',
  },
  {
    token: 'Applebot-Extended', operator: 'Apple', kind: 'robots_token', purpose: 'training', uaMatch: null,
    doc: 'https://support.apple.com/en-us/119829',
    note: '**不是爬虫**。同上，管的是 Applebot 抓走的内容能否用于训练。',
  },

  // ── 传统搜索引擎：在 AI 生态里是「被引用」的前置 ──
  {
    token: 'bingbot', operator: 'Microsoft', kind: 'crawler', purpose: 'search', uaMatch: 'bingbot',
    doc: 'https://www.bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0',
    note: 'Copilot 用的是必应的索引 —— 拦了 bingbot 等于同时拦掉 Copilot。',
  },
  {
    token: 'Baiduspider', operator: '百度', kind: 'crawler', purpose: 'search', uaMatch: 'baiduspider',
    doc: 'https://help.baidu.com/question?prod_id=99&class=0&id=3001',
    note: '文心一言与百度 AI 搜索用的是百度的索引。',
  },
  {
    token: 'Googlebot', operator: 'Google', kind: 'crawler', purpose: 'search', uaMatch: 'googlebot',
    doc: 'https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers',
    note: 'AI 概览（AI Overviews）用的是谷歌搜索的索引。',
  },

  // ── 国产：只有这一个有长期公开可查的独立 UA ──
  {
    token: 'Bytespider', operator: '字节跳动', kind: 'crawler', purpose: 'training', uaMatch: 'bytespider',
    doc: 'https://www.toutiao.com/robots.txt',
    note: '字节系（豆包/头条）的抓取。它的抓取强度历来较高，如果服务器吃不消，'
      + '正确做法是限速而不是直接拦死 —— 拦死等于退出豆包的引用池。',
  },

  // ── 其余常见的训练抓取 ──
  {
    token: 'CCBot', operator: 'Common Crawl', kind: 'crawler', purpose: 'training', uaMatch: 'ccbot',
    doc: 'https://commoncrawl.org/ccbot',
    note: '公益抓取，几乎所有开源模型的训练集都源于它。拦它等于从大部分开源模型里消失。',
  },
  {
    token: 'Amazonbot', operator: 'Amazon', kind: 'crawler', purpose: 'training', uaMatch: 'amazonbot',
    doc: 'https://developer.amazon.com/amazonbot',
    note: 'Alexa / Amazon 的 AI 抓取。',
  },
  {
    token: 'meta-externalagent', operator: 'Meta', kind: 'crawler', purpose: 'training', uaMatch: 'meta-externalagent',
    doc: 'https://developers.facebook.com/docs/sharing/webmasters/web-crawlers',
    note: 'Meta 的 AI 训练抓取。',
  },
  {
    token: 'Applebot', operator: 'Apple', kind: 'crawler', purpose: 'search', uaMatch: 'applebot',
    doc: 'https://support.apple.com/en-us/119829',
    note: 'Siri 与 Spotlight 的检索抓取（训练用途另由 Applebot-Extended 表态）。',
  },
] as const;

/**
 * **明知有、但没有公开 UA 的引擎**。
 *
 * 【为什么要把「不知道」显式列出来】不列的话，界面上就是一份纯英文清单，
 * 用户会得出「国产引擎不抓我的站」这个结论 —— 而真相是**我们不知道它们用什么名字抓**。
 * 这与 ai-source.ts 里那六个 unknown 是同一条纪律：
 * **缺席不许当成 0**（本库在 hotScore 上栽过这个跟头）。
 */
export const AI_ENGINES_WITHOUT_PUBLIC_UA: readonly { name: string; why: string }[] = [
  { name: '腾讯元宝', why: '未公开披露独立爬虫 UA；其内容池以微信生态内的既有内容为主，不一定经由公网抓取。' },
  { name: 'DeepSeek', why: '未公开披露独立爬虫 UA。' },
  { name: 'Kimi（月之暗面）', why: '未公开披露独立爬虫 UA。' },
  { name: '智谱清言', why: '未公开披露独立爬虫 UA。' },
] as const;

/** 只有这些才是真会发请求、能在 UA 里认出来的。 */
export function realCrawlers(): AiAgent[] {
  return AI_AGENTS.filter((a) => a.kind === 'crawler');
}

/** 只能写进 robots.txt 的策略令牌。 */
export function robotsTokens(): AiAgent[] {
  return AI_AGENTS.filter((a) => a.kind === 'robots_token');
}

/**
 * 从 User-Agent 里认出是哪一个。认不出返回 null。
 *
 * 【为什么是子串匹配而不是正则】真实 UA 长这样：
 * `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot`
 * —— 名字埋在中间，前后都有别的东西。子串是这里唯一稳的判据。
 *
 * 【为什么先匹配长的】`Claude-SearchBot` 与 `ClaudeBot`、`Perplexity-User` 与 `PerplexityBot`
 * 互相不包含，但 `ChatGPT-User` 之类将来可能出现包含关系。按 uaMatch 长度倒序，
 * 长的先中 —— 短的先中会把一个精确的子类认成它的父类，而那正好把三种用途搞混。
 */
export function identifyAiCrawler(userAgent: string | null | undefined): AiAgent | null {
  const ua = String(userAgent ?? '').toLowerCase();
  if (!ua) return null;
  const candidates = realCrawlers()
    .filter((a) => a.uaMatch)
    .sort((a, b) => (b.uaMatch!.length - a.uaMatch!.length));
  return candidates.find((a) => ua.includes(a.uaMatch!)) ?? null;
}

/** 按 token 找一条（robots.ts 与界面共用）。 */
export function findAgent(token: string): AiAgent | null {
  return AI_AGENTS.find((a) => a.token.toLowerCase() === token.toLowerCase()) ?? null;
}
