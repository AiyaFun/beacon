import type { Metadata } from 'next';
import { HOT_INGEST_INTERVAL_MINUTES, HOT_SOURCES, sourceBrandName } from '../constants';
import { PRICING, TRIAL_DAYS, BYOK_LIFETIME_FEN } from '../pay/pricing';

// 每一页自己的标题与描述（2026-09-17 深度 SEO/GEO 轮次）。
//
// ── 这一层解决的是什么 ──
// 根布局 app/layout.tsx 给了一个**全站默认** title/description。一个页面不写自己的，
// 就静默沿用那一份。**不报错、不掉功能、本地看不出来**——只有在搜索结果页上才会现形：
// 六个不同的页面，六条一模一样的标题和摘要。对搜索引擎这叫「重复内容」，
// 对 AI 检索更糟：模型拿不到「这一页专门讲什么」的信号，只能退回站点级描述，
// 于是**永远不会有某一页被单独引用**——而被单独引用正是 GEO 唯一想要的结果。
//
// 上一轮补过 /hotlists /topics-today /pricing /overview 四页，
// 但 /desktop /extension /login 三页（都在 sitemap.xml 里递交给了搜索引擎）
// 以及 /legal 三页（只写了 title、没有 description）一直漏着。
//
// ── 为什么收成一处，而不是各页各写 ──
// 与 lib/geo/public-surface.ts 同一条纪律：robots / sitemap / llms.txt 已经是同一批路径的
// 三个消费者，页面 metadata 是第四个。各写一份必然漂移，而**漂移不会报错**。
// 收在这里还换来一件此前做不到的事：tests/geo/page-seo.test.ts 能逐条断言
// 「sitemap 递交的每个 URL 都有自己的标题和描述」——漏一页就红，不必再靠人去数。
//
// ⚠️ 这一层**一个可见像素都不改**。title / description / keywords / canonical
//    全部落在 <head> 里，页面正文、布局、排版原样不动。
//
// ⚠️ 描述里只写页面上真的有的东西。价格、平台数、更新间隔一律从各自的真相源派生——
//    写死的数字会在改价那天变成谎言，而没有任何测试会因此变红。

/** 热榜源数量与名字：从 HOT_SOURCES 派生，不写死。 */
const HOT_COUNT = HOT_SOURCES.length;
const HOT_NAMES = HOT_SOURCES.map((s) => sourceBrandName(s.key)).join('、');
/** 价格：从 lib/pay/pricing.ts 派生，改价当天描述自动跟着改。 */
const YUAN = (fen: number) => `¥${Math.round(fen / 100)}`;

export type PageSeo = {
  /**
   * `<title>`。**不要自带品牌名**——根布局的 title.template 会拼上
   * 「| 烽火台 · 跨平台内容作战室」。自带一次就会输出两遍品牌名，
   * 而 /legal 三页此前正是这样：「隐私政策 — 烽火台 | 烽火台 · 跨平台内容作战室」，
   * /pricing 与 /overview 同病（「价格方案 · 烽火台跨平台内容作战室 | 烽火台 · …」）。
   * tests/geo/page-seo.test.ts 逐条断言这里不出现品牌名——它不会再长回来。
   * 分享卡片的 ogTitle **要**自带品牌名：卡片不走 template，不写就没有品牌。
   */
  title: string;
  /** 摘要。中文搜索结果里大约 78 个汉字后截断，把最重要的话放前面。 */
  description: string;
  /** 这一页自己的检索词（站点级的那批在 lib/geo/keywords.ts）。 */
  keywords: readonly string[];
  /** 分享卡片标题/摘要。不填就用上面那两条。卡片不走 template，所以这里要自带品牌名。 */
  ogTitle?: string;
  ogDescription?: string;
  /**
   * 英文版文案。**只有真的渲染英文正文的页才填**——
   * 填了却仍然输出中文正文，等于对着搜索引擎自称英文页，比不填更糟。
   * 当前只有 /legal/data-request 有英文分支（见那一页的 isEn）。
   */
  titleEn?: string;
  descriptionEn?: string;
  /**
   * 允不允许被收录。
   * 判据是**两条同时成立**：robots.txt 放行了它，且它免登录能打开。
   * 登录墙后面的页面写 false —— 它们被索引只会产出一条点进去是登录页的结果。
   */
  indexable: boolean;
};

/**
 * 首页 `/` 不在这张表里，这是刻意的：
 * 它的标题与描述**就是**根布局那一份全站默认值（首页本来就该代表整个站），
 * 在这里再写一遍等于把同一句话维护两遍。守卫对这一条有显式豁免。
 */
export const ROOT_USES_SITE_DEFAULT = '/';

export const PAGE_SEO: Record<string, PageSeo> = {
  '/hotlists': {
    title: `全网热榜聚合 · ${HOT_COUNT} 大平台实时热点与爆款风向标`,
    description: `烽火台全网热点聚合中心：汇聚${HOT_NAMES}等 ${HOT_COUNT} 大主流平台实时热榜，自动聚类与去重，免登录可看。`,
    keywords: [
      '全网热榜', '全网热点聚合', '抖音热榜', 'B站热搜', '微博热搜榜', '知乎热榜',
      '百度热搜', '今日头条热榜', '爆款选题库', '实时热点追踪', '自媒体找热点', '热点趋势分析',
    ],
    ogTitle: `全网热榜实时聚合 · ${HOT_COUNT} 大主流平台爆款风向标 | 烽火台`,
    ogDescription: `每 ${HOT_INGEST_INTERVAL_MINUTES} 分钟同步一次全网 ${HOT_COUNT} 大平台热榜，自动话题聚类与敏感词过滤，助创作者快速捕捉爆款灵感。`,
    indexable: true,
  },

  '/topics-today': {
    title: '今日选题榜 · 跨平台扩散话题与常青流量节点推荐',
    description: '按垂直赛道智能推荐今日高潜选题：精选跨平台正在扩散的焦点话题、不依赖热点的爆款常青题以及未来 30 天流量爆发节点，每条自带「为什么是今天」深度研判理由，免登录可看。',
    keywords: [
      '今日选题榜', '爆款选题推荐', '跨平台扩散话题', '常青选题库', '流量节点日历',
      '自媒体选题灵感', '抖音爆款选题', '小红书热门选题', '公众号深度选题', 'B站视频策划', '垂直赛道选题',
    ],
    ogTitle: '今日选题榜 · 跨平台扩散话题与常青流量节点推荐 | 烽火台',
    ogDescription: '每天早上一份带理由的选题推荐，跨平台扩散话题 + 常青选题公式 + 30天节点日历。',
    indexable: true,
  },

  '/pricing': {
    title: '价格方案 · 标准版 / 自带 Key 版 / 永久买断三档',
    description: `烽火台透明价格：${PRICING.personal.name} ${YUAN(PRICING.personal.monthFen)}/月、${PRICING.byok.name} ${YUAN(PRICING.byok.monthFen)}/月、永久买断版 ${YUAN(BYOK_LIFETIME_FEN)}。新用户注册即送 ${TRIAL_DAYS} 天${PRICING.personal.name}，无需绑定付款方式。`,
    keywords: [
      '烽火台价格', '自媒体SaaS收费', '融媒体工具报价', 'AI选题工具会员', '自带Key版SaaS',
      '永久买断内容创作软件', '新媒体运营工具试用', 'MCN机构软件采购', '跨平台作战室版本对比',
    ],
    ogTitle: '价格方案 · 烽火台跨平台内容作战室',
    ogDescription: `三档价格：${PRICING.personal.name} ${YUAN(PRICING.personal.monthFen)}/月、${PRICING.byok.name} ${YUAN(PRICING.byok.monthFen)}/月、永久买断 ${YUAN(BYOK_LIFETIME_FEN)}。注册送 ${TRIAL_DAYS} 天${PRICING.personal.name}。`,
    indexable: true,
  },

  // ── 上一轮漏掉的三页：它们都在 sitemap.xml 里，却一直沿用全站默认标题 ──
  '/desktop': {
    title: '桌面客户端下载 · macOS 与 Windows 版自动回流助手',
    description: '烽火台桌面客户端（macOS / Windows）：装上它，同行动态与你在 X / TikTok / YouTube 主页的数据每天自动回流，不用装插件，网页功能一样不少。macOS 版已签名并公证。',
    keywords: [
      '烽火台桌面客户端', '自媒体桌面工具下载', 'macOS内容运营软件', 'Windows自媒体软件',
      'X主页数据回流', 'TikTok数据采集', 'YouTube频道数据回流', '竞对动态自动监控', '免插件数据采集',
    ],
    ogTitle: '桌面客户端下载 · macOS 与 Windows | 烽火台',
    ogDescription: '装上它，同行动态与你在 X / TikTok / YouTube 主页的数据每天自动回流，不用装插件。',
    indexable: true,
  },

  '/extension': {
    title: '浏览器插件下载 · Chrome 采集助手（商店版与 zip 版）',
    description: '烽火台采集助手浏览器插件：Chrome 应用商店版与自托管 zip 版两种装法都保留。浏览时顺手存灵感、回填自己作品的表现数据，只采你在页面上亲眼可见的公开数据。',
    keywords: [
      '烽火台浏览器插件', 'Chrome扩展下载', '自媒体采集插件', '内容数据回填工具',
      '灵感收集扩展', '竞对作品采集', '创作者后台数据回填', '新媒体运营Chrome插件',
    ],
    ogTitle: '浏览器插件下载 · Chrome 采集助手 | 烽火台',
    ogDescription: 'Chrome 应用商店版与自托管 zip 版：浏览时顺手存灵感、回填自己作品的表现数据。',
    indexable: true,
  },

  '/login': {
    title: '登录 / 注册',
    description: `登录烽火台跨平台内容作战室。新用户注册即送 ${TRIAL_DAYS} 天${PRICING.personal.name}，无需绑定付款方式；也可以先以访客身份看全网热榜与今日选题榜。`,
    keywords: [
      '烽火台登录', '烽火台注册', '自媒体工具免费试用', '内容作战室入口', '新媒体运营系统登录',
    ],
    ogTitle: '登录 / 注册 · 烽火台',
    ogDescription: `注册即送 ${TRIAL_DAYS} 天${PRICING.personal.name}，不用填付款方式。`,
    indexable: true,
  },

  // ── 法务三页：此前只有 title，且 title 自带品牌名，被模板拼成两遍 ──
  //    法务页是**必须**可被抓取的（Chrome 应用商店的检查器遵守 robots.txt，
  //    见 lib/geo/public-surface.ts 顶部那条），所以它们也值得一条像样的摘要。
  '/legal/privacy': {
    title: '隐私政策',
    description: '烽火台隐私政策：逐条说明采集了什么数据、留存多久、如何删除，含浏览器插件的逐项行为披露与第三方共享清单。',
    keywords: ['烽火台隐私政策', '数据采集披露', '浏览器插件权限说明', '个人信息保护', '数据留存期限'],
    ogTitle: '隐私政策 | 烽火台',
    indexable: true,
  },

  '/legal/terms': {
    title: '服务条款',
    description: '烽火台服务条款：服务范围、账号与付费规则、内容合规责任、知识产权归属与终止条款。',
    keywords: ['烽火台服务条款', 'SaaS用户协议', '内容合规责任', '订阅与退款规则'],
    ogTitle: '服务条款 | 烽火台',
    indexable: true,
  },

  '/legal/data-request': {
    title: '数据移除申请',
    description: '被烽火台监控的账号作者、以及留下过评论的读者，都可以在这里要求移除自己的数据；申请会被逐条处理并留档。',
    keywords: ['数据移除申请', '被监控账号申诉', '评论数据删除', '内容采集退出', '数据主体权利'],
    ogTitle: '数据移除申请 | 烽火台',
    // 这一页有真的英文正文分支（DataRequestPage 里的 isEn），所以英文文案是成立的
    titleEn: 'Data Removal Request',
    descriptionEn: 'Authors of monitored accounts and readers who left comments can request removal of their data here; every request is processed and logged.',
    indexable: true,
  },

  // ── 一条**有待拍板**的：游客打得开，但 robots 不让爬 ──
  //    /overview 在 middleware 的 PUBLIC_PATHS 里（middleware.ts:66），游客裸访问返回 200；
  //    但它既不在 robots 的放行清单（lib/geo/public-surface.ts 的 PUBLIC_ALLOW）里，
  //    也不在 sitemap.xml 里。于是此前的状态是自相矛盾的：
  //    一页带着 canonical 和一整套关键词，却被 `Disallow: /` 挡在门外，谁也抓不到。
  //
  //    这里先按 robots 的现状写 indexable: false，让声明和事实对上（守卫逐条比对这两者）。
  //    **但这是一个产品决定，不是技术决定**：这一页讲的是整机/Win/Mac/SaaS/插件全端形态，
  //    正是「私有化部署」「桌面客户端」这类搜索词该落的地方。要开放收录，需要三处一起改：
  //    PUBLIC_ALLOW 加 '/overview'、PUBLIC_PAGES 加一条、sitemap.ts 加一行，再把这里改成 true。
  //    三处缺一，就会退回今天这种「说了要收录、实际爬不到」的状态。
  '/overview': {
    title: '全端生态总览 · 整机/Win/Mac/SaaS/插件',
    description: '烽火台跨平台内容作战室全端形态架构：覆盖私有化整机一体机部署、Windows 与 macOS 桌面客户端、云端 SaaS 服务与 Chrome 采集扩展插件。',
    keywords: [
      '烽火台全端生态', '私有化整机部署', '桌面客户端', 'macOS创作者工具',
      'Windows内容工具', 'Chrome采集插件', '云端SaaS', '跨平台内容作战室',
    ],
    ogTitle: '全端生态总览 · 烽火台 Beacon (整机/Win/Mac/SaaS/插件)',
    ogDescription: '烽火台跨平台内容作战室全端产品介绍，覆盖整机私有化部署、桌面客户端、云端 SaaS 与采集扩展。',
    indexable: false,
  },
};

/**
 * 把一条 PAGE_SEO 变成 Next 的 Metadata。
 *
 * 【canonical 为什么一定要写】同一页往往有多个可达地址（带 utm、带尾斜杠、
 * 带 ?lang=en）。不声明 canonical，搜索引擎就得自己猜哪个是正主，
 * 而它猜错的那一次，权重会被拆散到几个地址上。
 *
 * 【noindex 页为什么还给 openGraph】收录与分享是两件事：
 * 一个登录墙后面的页不该进搜索结果，但同事在群里贴它的链接时仍然该有卡片。
 */
export function pageMetadata(path: string, lang?: string): Metadata {
  const seo = PAGE_SEO[path];
  // 【拿不到就抛，不给「回退默认值」留缝】静默回退等于这一页悄悄退回全站默认标题，
  // 而那正是这个模块存在的理由。构建期就炸掉，比上线后在搜索结果里发现强。
  if (!seo) throw new Error(`lib/geo/page-seo.ts 里没有 ${path} 的条目`);

  // 英文只在**这一页真有英文正文**时才切（titleEn 填了才算数）。
  // 没填就继续给中文——标题和正文对不上，比标题是中文糟得多。
  const en = lang === 'en' && seo.titleEn;
  const title = en ? seo.titleEn! : seo.title;
  const description = en ? (seo.descriptionEn ?? seo.description) : seo.description;

  return {
    title,
    description,
    keywords: [...seo.keywords],
    alternates: { canonical: path },
    openGraph: {
      title: en ? title : (seo.ogTitle ?? title),
      description: en ? description : (seo.ogDescription ?? description),
      url: path,
      type: 'website',
    },
    ...(seo.indexable ? {} : { robots: { index: false, follow: true } }),
  };
}
