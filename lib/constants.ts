// 平台、状态、维度等全局常量（避免 SQLite 不支持 enum 的问题）

export const PLATFORMS = {
  douyin: { key: 'douyin', name: '抖音', color: '#000000', kind: 'short_video' },
  xiaohongshu: { key: 'xiaohongshu', name: '小红书', color: '#ff2442', kind: 'image_text' },
  wechat: { key: 'wechat', name: '公众号', color: '#07c160', kind: 'article' },
  bilibili: { key: 'bilibili', name: 'B站', color: '#fb7299', kind: 'long_video' },
  // 视频号与公众号同属微信生态但是两个平台：算法口径（完播+转发裂变 vs 完读+在看）、
  // 数据入口（创作者后台「数据中心-作品数据」vs datacube API）、链接形态都不同，不能合并。
  shipinhao: { key: 'shipinhao', name: '视频号', color: '#fa9d3b', kind: 'short_video' },
  x: { key: 'x', name: 'X', color: '#1d9bf0', kind: 'short_text' },
  youtube: { key: 'youtube', name: 'YouTube', color: '#ff0000', kind: 'long_video' },
  // TikTok 与抖音是**两个平台**，不是同一个的两个皮肤：账号体系不通（sec_user_id vs 主页 @unique_id）、
  // 内容不互通、算法与合规口径也不同（TikTok 侧重完播+分享，抖音侧重完播+评论互动）。
  // 合并会让「我抖音发过 = 我 TikTok 发过」这种判断全线错掉（跨平台补发、抢跑窗口都按 platform 比对）。
  tiktok: { key: 'tiktok', name: 'TikTok', color: '#ee1d52', kind: 'short_video' },
  // ── 大陆图文/资讯平台（2026-08-19 补齐）──────────────────────────────────
  // 加进来的判据只有一个：**用户真的在这些平台上发东西**。能不能走官方接口是另一回事，
  // 由 lib/publish/capability.ts 逐个如实写明（微博是这批里唯一有个人可用官方接口的）。
  weibo: { key: 'weibo', name: '微博', color: '#e6162d', kind: 'short_text' },
  zhihu: { key: 'zhihu', name: '知乎', color: '#0084ff', kind: 'article' },
  toutiao: { key: 'toutiao', name: '头条号', color: '#f04142', kind: 'article' },
  baijiahao: { key: 'baijiahao', name: '百家号', color: '#2932e1', kind: 'article' },
  kuaishou: { key: 'kuaishou', name: '快手', color: '#ff4906', kind: 'short_video' },
} as const;

export type PlatformKey = keyof typeof PLATFORMS;

export const PLATFORM_LIST = Object.values(PLATFORMS);

export function platformName(key: string): string {
  if (key === 'multi') return '多平台';
  return (PLATFORMS as Record<string, { name: string }>)[key]?.name ?? key;
}
export function platformColor(key: string): string {
  return (PLATFORMS as Record<string, { color: string }>)[key]?.color ?? '#888';
}

// 热榜源。已移除小红书/X 趋势（无任何可用数据源：小红书本身无公开热榜、X 需登录token且被禁）。
// YouTube 保留但当前国内服务器够不到 Google（GFW），显示示例，接代理后可转真数据。
export const HOT_SOURCES = [
  { key: 'douyin', name: '抖音热榜', beta: false },
  { key: 'weibo', name: '微博热搜', beta: false },
  { key: 'bilibili', name: 'B站热门', beta: false },
  { key: 'zhihu', name: '知乎热榜', beta: false },
  { key: 'baidu', name: '百度热搜', beta: false },
  { key: 'toutiao', name: '头条热榜', beta: false },
  { key: 'youtube', name: 'YouTube 热门', beta: true },
] as const;

// 榜单源的品牌名（去掉「热榜/热搜/热门」后缀）。
//
// 存在的理由：HOT_SOURCES 的 key 与 PLATFORMS **不完全重合**——百度只有热榜、没有发布通道，
// 所以 platformName 查不到它，会原样吐回英文 key。（微博/知乎/头条 2026-08-19 已进 PLATFORMS，
// 但 baidu 仍然只是榜单源。）凡是把「榜单源」写进
// 面向用户的句子的地方（如抢跑窗口的证据句）都必须走这里，否则会出现
// 「该话题已在 weibo、zhihu 共 2 个平台上榜」这种半英文文案。
export function sourceBrandName(key: string): string {
  const hot = HOT_SOURCES.find((s) => s.key === key);
  if (hot) return hot.name.replace(/\s*(热榜|热搜|热门)$/, '');
  return platformName(key);
}

// 选题七态状态机
export const TOPIC_STATES = {
  candidate: '候选',
  recommended: '已推荐',
  accepted: '已采纳',
  rejected: '已拒绝',
  drafting: '创作中',
  published: '已发布',
  reviewed: '已复盘',
} as const;

// 选题时间队列（lib/topic/queue.ts）：回答「先做哪个」，与六维评分回答的「值不值得做」正交。
export const TOPIC_QUEUES = [
  {
    key: 'today',
    name: '今日突击',
    icon: '⚡',
    desc: '有时间窗口，过期作废——今天不动手就没了',
  },
  {
    key: 'week',
    name: '本周窗口',
    icon: '📆',
    desc: '有节奏但不紧急，适合排进本周产能',
  },
  {
    key: 'evergreen',
    name: '常青储备',
    icon: '🌲',
    desc: '不依赖热点，什么时候做都成立；产能空档和没头绪时用',
  },
] as const;

export type TopicQueueKey = (typeof TOPIC_QUEUES)[number]['key'];

export function topicQueueName(key: string): string {
  return TOPIC_QUEUES.find((q) => q.key === key)?.name ?? key;
}

// 选题来源标签。前四种来自「别人已经做爆的东西」，后四种是延伸候选源（lib/topic/sources/）。
export const TOPIC_SOURCE_LABEL: Record<string, { name: string; badge: string; hint: string }> = {
  hot: { name: '来自热点', badge: 'badge-red', hint: '当前热榜在榜话题' },
  competitor: { name: '来自竞对', badge: 'badge-brand', hint: '订阅竞对的高热作品' },
  advisor: { name: '来自智囊团', badge: 'badge-accent', hint: '智囊团会诊产出' },
  manual: { name: '手动录入', badge: 'badge-gray', hint: '你自己加的选题' },
  gap: { name: '抢跑窗口', badge: 'badge-amber', hint: '话题已在别的平台爆了，你的主战平台还没有' },
  recycle: { name: '旧文翻新', badge: 'badge-accent', hint: '你做过同题内容，这个话题重新上榜了' },
  crossplat: { name: '跨平台补发', badge: 'badge-brand', hint: '你在某平台的爆款，还没发到其他主战平台' },
  evergreen: { name: '常青题', badge: 'badge-gray', hint: '赛道长青话题，无时效压力' },
  calendar: { name: '节点日历', badge: 'badge-amber', hint: '每年确定会来的流量节点，赢在提前量' },
  inspiration: { name: '灵感箱', badge: 'badge-accent', hint: '你自己收藏进灵感库的内容' },
  comment: { name: '读者提问', badge: 'badge-amber', hint: '你的读者在评论区反复问到的问题' },
  'rival-comment': { name: '同行读者提问', badge: 'badge-brand', hint: '同行作品评论区被反复问到的问题' },
};

// 选题六维评分
export const TOPIC_DIMENSIONS = [
  { key: 'traffic', name: '流量潜力' },
  { key: 'personaFit', name: '人设匹配' },
  { key: 'cost', name: '制作成本' },
  { key: 'monetization', name: '变现路径' },
  { key: 'compliance', name: '合规风险' },
  { key: 'differentiation', name: '差异空间' },
] as const;

// 账号项目体检六维
export const ACCOUNT_HEALTH_DIMENSIONS = [
  { key: 'positioning', name: '定位清晰度' },
  { key: 'quality', name: '内容质量稳定度' },
  { key: 'algoFit', name: '算法适配度' },
  { key: 'audience', name: '粉丝结构' },
  { key: 'monetization', name: '变现潜力' },
  { key: 'risk', name: '风险敞口' },
] as const;

// 记忆类型
export const MEMORY_TYPES = {
  persona: { name: '人设记忆', desc: '我是谁' },
  preference: { name: '偏好记忆', desc: '改稿与拒绝透露的口味' },
  performance: { name: '绩效记忆', desc: '哪类内容数据好' },
  fact: { name: '事实记忆', desc: '行业知识与粉丝画像' },
} as const;

// 合规词库四级
export const COMPLIANCE_TIERS = {
  legal: { name: '法律级', color: '#dc2626', desc: '广告法/AIGC 等法定红线' },
  platform: { name: '平台级', color: '#ea580c', desc: '各平台社区规范' },
  industry: { name: '行业级', color: '#ca8a04', desc: '医疗/金融等高危类目' },
  custom: { name: '自定义级', color: '#0891b2', desc: '租户自建黑白名单' },
  semantic: { name: '语义级', color: '#7c3aed', desc: 'AI 语义分析发现' },
} as const;

// 算法结论可信度
export const CONFIDENCE_LEVELS = {
  official: { name: '官方披露', color: '#16a34a', weight: 1.0 },
  opensource: { name: '开源代码', color: '#0891b2', weight: 0.85 },
  consensus: { name: '行业共识', color: '#ca8a04', weight: 0.6 },
  rumor: { name: '坊间传闻', color: '#94a3b8', weight: 0.3 },
} as const;

// LLM 功能路由键（BYOK 可按功能分别指定模型）
// video 与其它几项有一处不同：它**只走 BYOK**，没有平台兜底（一次视频调用抵几十次文本，
// 而配额按次计——理由写在 lib/llm/gateway.ts 的 llmVideo 上方）。
// image = 文生图/图生图（小红书 AI 封面）。走 images/generations 端点而非 chat/completions，
// 执行层是 lib/llm/image.ts 而非通用 provider；配额与记账仍与其它功能同一套（见 llmImage）。
// agent = 执行模式（任务台派活）的推理循环。它**不是**一个新的记账口径：
// 执行器仍然按 fn='chat' 记账与走 BYOK，这一项只作为「按功能路由」里的一个**可选偏好**——
// 配了就用它选渠道，没配就完全照旧（见 lib/llm/gateway.ts 的 preferFn）。
//
// 【为什么值得单列】执行模式对模型的要求与聊天完全不同：它必须稳定地发**结构化工具调用**。
// 2026-08-23 真机实测，平台默认的 MiniMax-Text-01 会把调用写成正文
//（「我这就去建草稿」＋一段 functions.create_draft(...) 文本），三次真跑三种表现。
// 而同一条渠道对普通问答是够用的——所以要的不是「换掉默认模型」，
// 是「让执行模式能单独指一条更会用工具的渠道」。
export const LLM_FUNCTIONS = ['scoring', 'generation', 'advisor', 'compliance', 'chat', 'diagnosis', 'video', 'image', 'agent'] as const;

// 连通性测试的两个判据（渠道设置用）。放这里而不是 settings/actions.ts：
// 'use server' 文件只能导出 async 函数，同步判据放不进去；这里本来就是端点白名单的家。
//
// looksNonChatModel：这个模型名一看就不是对话模型（即梦生图 / 视频生成…）。对它发 chat ping
// 必然报错，但那说明的是「不是对话模型」，不是「Key 不能用」——不能据此判 failed，
// 否则 lib/llm/image.ts 与 gateway.ts 的解析会把这条渠道排除掉（两处都过滤 status not:'failed'），
// 用户就会遇到「明明配了却说没有可用渠道」。
export function looksNonChatModel(model: string): boolean {
  return /seedream|seededit|seedance|image|vision-?gen|即梦|-i2v|-t2v/i.test(model ?? '');
}

/** 认证类错误：只有这一类才说明 Key 本身有问题。 */
export const AUTH_ERROR_RE = /\b(401|403)\b|invalid[_ ]?api[_ ]?key|unauthorized|authentication|api key|鉴权|未授权|无效的?\s*key/i;
export type LlmFunction = (typeof LLM_FUNCTIONS)[number];

// ───────────── F12-1 BYOK 供应商白名单 + 端点锁定 ─────────────
// PRD §6 F12-1 验收①③ / §10.5-④ / §9.4-7 / §13-18 红线：
// 供应商只能从白名单选，base_url 由平台预置且不可改，**任意自定义端点（L3）永不开放**
// ——任意端点 = 变相境外 API 中转 + 租户内容（人设卡/记忆含个人信息）出境，2026 有立案处罚先例。
//
// 这张表是唯一事实来源：服务端校验（settings/actions.ts）与表单下拉（ProviderForm.tsx）读同一份。
// 别在客户端另开一份——两份必然漂移，而漂移的那份恰好是能被绕过的那份。

export type LlmRegion = 'cn' | 'overseas';

export type LlmVendor = {
  key: string;
  name: string;
  baseUrl: string; // 平台预置端点，唯一允许值
  model: string; // 默认模型名（模型名白名单是 F12-1 验收④，尚未实现）
  region: LlmRegion; // 由供应商强绑，不由用户自选
};

export const LLM_VENDORS: Record<string, LlmVendor> = {
  // 🇨🇳 国内已备案 / 头部大模型
  deepseek: { key: 'deepseek', name: 'DeepSeek 深度求索', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', region: 'cn' },
  qwen: { key: 'qwen', name: '通义千问 Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', region: 'cn' },
  kimi: { key: 'kimi', name: 'Kimi 月之暗面', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', region: 'cn' },
  glm: { key: 'glm', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', region: 'cn' },
  hunyuan: { key: 'hunyuan', name: '腾讯混元 Hunyuan', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', model: 'hunyuan-pro', region: 'cn' },
  doubao: { key: 'doubao', name: '火山引擎 豆包 Doubao', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-pro-32k', region: 'cn' },
  baichuan: { key: 'baichuan', name: '百川智能 Baichuan', baseUrl: 'https://api.baichuan-ai.com/v1', model: 'baichuan4', region: 'cn' },
  minimax: { key: 'minimax', name: 'MiniMax 稀宇科技', baseUrl: 'https://api.minimax.chat/v1', model: 'abab6.5s-chat', region: 'cn' },
  yi: { key: 'yi', name: '零一万物 Yi', baseUrl: 'https://api.lingyiwanwu.com/v1', model: 'yi-lightning', region: 'cn' },
  spark: { key: 'spark', name: '讯飞星火 Spark', baseUrl: 'https://spark-api-open.xf-yun.com/v1', model: 'spark-v3.5', region: 'cn' },
  stepfun: { key: 'stepfun', name: '阶跃星辰 StepFun', baseUrl: 'https://api.stepfun.com/v1', model: 'step-1-8k', region: 'cn' },
  sensenova: { key: 'sensenova', name: '商汤日日新 SenseNova', baseUrl: 'https://api.sensenova.cn/v1', model: 'sensechat-5', region: 'cn' },

  // 🌍 海外主流商业与开源算力大模型
  openai: { key: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', region: 'overseas' },
  claude: { key: 'claude', name: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-20241022', region: 'overseas' },
  gemini: { key: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-1.5-pro', region: 'overseas' },
  groq: { key: 'groq', name: 'Groq 超高速推理引擎', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', region: 'overseas' },
  mistral: { key: 'mistral', name: 'Mistral AI 法国开源顶级', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-large-latest', region: 'overseas' },
  perplexity: { key: 'perplexity', name: 'Perplexity AI 联网检索', baseUrl: 'https://api.perplexity.ai', model: 'sonar-pro', region: 'overseas' },
  together: { key: 'together', name: 'Together AI 云算力托管', baseUrl: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', region: 'overseas' },
  deepinfra: { key: 'deepinfra', name: 'DeepInfra 高性能开源模型', baseUrl: 'https://api.deepinfra.com/v1/openai', model: 'Qwen/Qwen2.5-72B-Instruct', region: 'overseas' },
};

// 下拉顺序：国内已备案在前，海外在后
export const LLM_VENDOR_KEYS = Object.keys(LLM_VENDORS);

export function llmVendor(key: string): LlmVendor | null {
  return Object.prototype.hasOwnProperty.call(LLM_VENDORS, key) ? LLM_VENDORS[key] : null;
}

// 海外端点（L2）门槛：企业版 + 出海工作区（PRD §10.5-③，V2 能力）
export const OVERSEAS_MIN_PLAN = 'enterprise';
export function canUseOverseas(plan: string): boolean {
  return plan === OVERSEAS_MIN_PLAN;
}

// 端点归一化。**必须解析后逐字段比对，绝不能用 startsWith/includes**——那是经典绕过：
//   https://api.deepseek.com.evil.com  ← 后缀域名，startsWith 直接放行
//   https://api.deepseek.com@evil.com  ← userinfo 陷阱，真实 host 是 evil.com
// 返回 null = 连形状都不合法，直接拒。
function canonicalEndpoint(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null; // 明文 http 与 file:/javascript: 一律拒
  if (u.username || u.password) return null; // userinfo 陷阱
  if (u.search || u.hash) return null; // 查询串/锚点不属于 base_url
  // u.host 含非默认端口；hostname 已由 URL 归一为小写 + punycode；pathname 已归一掉 ../
  // 末尾斜杠归一（/v1/ === /v1）；路径**大小写敏感**（/V1 ≠ /v1，路径本就区分大小写）
  return `https://${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

export type EndpointCheck = { ok: true; vendor: LlmVendor } | { ok: false; error: string };

// 校验「vendor + baseUrl」是否命中白名单。校验通过后**一律用 vendor.baseUrl 入库**，
// 不存用户提交的字符串——库里永远不该出现用户可控的端点。
export function checkVendorEndpoint(vendorKey: string, baseUrl: string): EndpointCheck {
  const v = llmVendor(vendorKey);
  if (!v) {
    return { ok: false, error: '该供应商不在白名单内。平台只支持从白名单中选择供应商，不开放自定义端点（PRD §10.5 L3）' };
  }
  const got = canonicalEndpoint(baseUrl);
  const want = canonicalEndpoint(v.baseUrl);
  if (got === null || want === null || got !== want) {
    return { ok: false, error: `端点不在白名单内：${v.name} 的 base_url 由平台锁定为 ${v.baseUrl}，不可修改（PRD §6 F12-1）` };
  }
  return { ok: true, vendor: v };
}

// ── 发票 / 客服渠道 ─────────────────────────────────────────────
// 发票开具走人工客服（不自建开票系统，见 billing 页说明卡）。
// ⚠️ 上线前务必用 env 配上真实客服渠道，否则展示的是占位符=给用户假联系方式。
// billing 页是服务端组件，直接读 BEACON_ 服务端变量即可（无需 NEXT_PUBLIC_）。
export function invoiceContact(): { wechat: string; email: string; configured: boolean } {
  const wechat = process.env.BEACON_CS_WECHAT?.trim() ?? '';
  const email = process.env.BEACON_CS_EMAIL?.trim() ?? '';
  return {
    wechat: wechat || '（待配置客服微信号）',
    email: email || '（待配置客服邮箱）',
    configured: Boolean(wechat || email),
  };
}
