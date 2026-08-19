import { z } from 'zod';
import { parseJson } from './json';
import { PLATFORM_LIST } from './constants';

// 人设卡结构（PRD §8）：身份/受众/价值主张/内容边界/语气风格
export type PersonaCard = {
  identity: string; // 我是谁、做什么生意
  audience: string; // 目标受众
  valueProp: string; // 价值主张
  canDo: string[]; // 能做的内容边界
  cantDo: string[]; // 不能做
  tone: string; // 语气风格
  platforms: string[]; // 主战平台
  niche?: string; // 行业/赛道
  // ── 品牌视觉（域14 · AI 封面）：封面工位的默认值 ──
  // 放人设卡而不是另起一张表：它和「我是谁、什么语气」是同一类长期设定，
  // 而且人设已经有版本历史与导出链路，白捡。空 = 按赛道推荐（rankStylesForPersona）。
  coverStyle?: string; // 默认封面风格 key（lib/cover/styles.ts）
  coverFont?: string;  // 默认字体倾向 key
};

export function emptyPersona(): PersonaCard {
  return { identity: '', audience: '', valueProp: '', canDo: [], cantDo: [], tone: '', platforms: [] };
}

// 库里 personaCard 默认值是 '{}'——它是合法 JSON，parseJson 解析成功、不走 fallback，
// 直接返回 {} → canDo/cantDo/platforms 全 undefined，下游 personaPromptBlock 的
// `p.canDo.join('、')` 对 undefined 直接 TypeError（新用户没填人设点「生成今日推荐」全程 500）。
// 根因修法：把解析结果合并到 emptyPersona() 之上，保证字段永远齐全（数组默认 []），
// 一并兜住 assistant/algorithm/advisor/combine/pipeline 所有裸 readPersona 调用点。
// 非对象（null/数组/数字/非法 JSON）一律回退到完整的空人设，绝不返回残缺对象。
export function readPersona(raw: string): PersonaCard {
  const parsed = parseJson<Partial<PersonaCard>>(raw, {});
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return { ...emptyPersona(), ...parsed };
  }
  return emptyPersona();
}

// 人设是不是还没起步——决定要不要顶冷启动入口给新用户。
// 只看三个核心字段：老用户哪怕只填了身份，也不该再被冷启动引导打扰。
export function isPersonaBlank(p: PersonaCard): boolean {
  return !((p.identity ?? '').trim() || (p.audience ?? '').trim() || (p.valueProp ?? '').trim());
}

export function personaCompleteness(p: PersonaCard): number {
  const fields = [p.identity, p.audience, p.valueProp, p.tone, p.niche];
  const filled = fields.filter((f) => f && f.trim().length > 0).length;
  const listBonus = (p.canDo.length > 0 ? 1 : 0) + (p.cantDo.length > 0 ? 1 : 0) + (p.platforms.length > 0 ? 1 : 0);
  return Math.round(((filled + listBonus) / 8) * 100);
}

// ─────────────── F3-1 冷启动：一句话 → AI 追问 → 扩写 → 逐项确认 ───────────────
// PRD §6 F3-1：用户输入一句话 → AI 追问 3–5 个问题（卖什么/给谁/凭什么）→ 生成完整人设卡
// → 用户逐项确认。跳过的追问由 AI 以低置信度默认值填充并标注「待确认」。

export type PersonaFieldKey = 'identity' | 'audience' | 'valueProp' | 'niche' | 'tone' | 'canDo' | 'cantDo' | 'platforms';

export const PERSONA_FIELD_KEYS: PersonaFieldKey[] = [
  'identity', 'audience', 'valueProp', 'niche', 'tone', 'canDo', 'cantDo', 'platforms',
];

export const PERSONA_FIELD_LABEL: Record<PersonaFieldKey, string> = {
  identity: '身份',
  audience: '目标受众',
  valueProp: '价值主张',
  niche: '赛道 / 行业',
  tone: '语气风格',
  canDo: '能做',
  cantDo: '不能做 / 红线',
  platforms: '主战平台',
};

// 追问的 key 是**固定枚举**：LLM 只能从中挑，不能自创。
// 理由：key 决定「跳过这问 → 哪几个字段降置信度」的映射，自由 key 会让 AC③ 的标注失灵。
export const PERSONA_QUESTION_KEYS = ['what', 'who', 'why', 'edge', 'platform'] as const;
export type PersonaQuestionKey = (typeof PERSONA_QUESTION_KEYS)[number];

export type PersonaQuestion = { key: PersonaQuestionKey; question: string; hint: string };

// 追问 → 受影响字段。跳过某问，这些字段就是「AI 猜的」，要打低置信度 + 待确认。
const QUESTION_FIELDS: Record<PersonaQuestionKey, PersonaFieldKey[]> = {
  what: ['identity', 'niche', 'canDo'],
  who: ['audience'],
  why: ['valueProp'],
  edge: ['cantDo', 'tone'],
  platform: ['platforms'],
};

// 兜底追问：前三问是 PRD 点名的「卖什么/给谁/凭什么」，后两问补齐红线与平台。
// LLM 不可用或返回不合规时用它，保证冷启动流程永不断（PRD 要求全程 <5 分钟）。
export const DEFAULT_PERSONA_QUESTIONS: PersonaQuestion[] = [
  { key: 'what', question: '你打算持续输出什么内容？', hint: '卖什么 · 越具体越好，如「用 AI 工具接单做副业的实操教程」' },
  { key: 'who', question: '你想讲给谁听？', hint: '给谁 · 如「想搞副业但没整块时间的职场新人」' },
  { key: 'why', question: '凭什么是你？你的独特经历或优势是什么？', hint: '凭什么 · 如「自己用 AI 接单半年，从 0 做到月入 2 万」' },
  { key: 'edge', question: '有什么是你绝对不碰的内容？希望用什么语气说话？', hint: '如「不碰荐股、不承诺收入；像朋友聊天，不端着」' },
  { key: 'platform', question: '你主要在哪些平台发内容？', hint: `可选：${PLATFORM_LIST.map((p) => p.name).join(' / ')}` },
];

export type PersonaAnswer = {
  key: PersonaQuestionKey;
  question: string;
  answer: string;
  skipped: boolean; // AC③：用户可跳过任何追问
};

// 字段来源，决定 UI 上的徽标与置信度
export type PersonaFieldSource =
  | 'answer'   // 用户明确回答了对应追问 → 高置信
  | 'sentence' // 从那句话推的 → 中置信
  | 'ai-guess' // 用户跳过了对应追问，AI 拿保守默认值填的 → 低置信，标「待确认」
  | 'local';   // LLM 不可用/输出不合规，本地规则草稿 → 最低置信，标「待确认」

export type PersonaFieldState = { confidence: number; source: PersonaFieldSource; note?: string };

export type PersonaDraft = {
  card: PersonaCard;
  fields: Record<PersonaFieldKey, PersonaFieldState>;
  mocked: boolean;    // 由 Mock provider 产出（没配任何模型 Key）——UI 必须标出来
  degraded: boolean;  // LLM 输出过不了 schema，已降级为本地规则草稿
  provider: string;
  model: string;
  issues: string[];   // schema 校验失败原因（排障用，也给用户看个明白）
};

// ── schema 校验：LLM 返回的东西一律当不可信输入 ──
// min(2)：单个字符/标点这种「交差式」输出直接判不合格，不许当人设进库。
const shortText = (max: number) => z.string().trim().min(2).max(max);

export const personaCardSchema = z.object({
  identity: shortText(120),
  audience: shortText(120),
  valueProp: shortText(200),
  niche: shortText(60),
  tone: shortText(120),
  canDo: z.array(shortText(60)).min(1).max(8),
  cantDo: z.array(shortText(60)).min(1).max(8),
  platforms: z.array(z.string()).max(12).default([]),
});

// 平台别名 → 白名单 key。LLM 爱写「微信公众号」「哔哩哔哩」「Twitter」，不能直接进库。
const PLATFORM_ALIASES: Record<string, string> = {
  微信公众号: 'wechat', 公众号: 'wechat', 微信: 'wechat',
  哔哩哔哩: 'bilibili', b站: 'bilibili', 'b 站': 'bilibili',
  twitter: 'x', 推特: 'x',
  红书: 'xiaohongshu', 小红薯: 'xiaohongshu',
  油管: 'youtube',
  抖音短视频: 'douyin',
};

// 视频号别名。**必须在其它别名之前单独吃掉**：它们都含「微信」，而 PLATFORM_ALIASES 里
// 「微信」是子串匹配 → wechat。若不先剥离，用户写「微信视频号」会凭空多出一个公众号平台，
// 而公众号与视频号的算法口径/数据入口完全不同，多出来的那个会一路污染诊断与推荐。
// 剥离后剩下的文本照常走原有匹配，所以「公众号 + 视频号」仍能同时认出两个。
const SHIPINHAO_ALIAS = /微信视频号|视频号|channels\.weixin\.qq\.com/gi;

// TikTok 别名。同样**必须先单独吃掉**：「抖音国际版 / 抖音海外版」都含「抖音」，
// 而 PLATFORM_LIST 里 douyin 的中文名「抖音」是子串匹配 → 用户写「抖音国际版」会被认成抖音。
// 这两个是**不同平台**（账号不通、算法口径不同，见 lib/constants.ts），认错会让
// 跨平台补发/抢跑窗口这类按 platform 比对的判断整条错掉。
// 英文 key 'tiktok' 不需要走这里——hasKeyWord 按词边界匹配，'tiktok' 够长够独特。
const TIKTOK_ALIAS = /抖音国际版|抖音海外版|tiktok\.com/gi;

// 英文 key 必须按词边界匹配，不能用 includes。
// 血的教训：key 'x'（X/Twitter）是单字符，`'xiaohongshu'.includes('x')` 恒为 true——
// 用户只选了小红书，卡片过一遍清洗就凭空多出个 X。中文名不吃这套（够长够独特），照常子串匹配。
function hasKeyWord(text: string, key: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${key}([^a-z0-9]|$)`, 'i').test(text);
}

// 从任意文本里认平台（既用于校验 LLM 的 platforms，也用于从用户答案的自由文本里认）
export function detectPlatforms(input: unknown): string[] {
  const texts = Array.isArray(input) ? input : [input];
  const out = new Set<string>();
  for (const raw of texts) {
    if (typeof raw !== 'string') continue;
    let s = raw.trim();
    for (const [re, key] of [[SHIPINHAO_ALIAS, 'shipinhao'], [TIKTOK_ALIAS, 'tiktok']] as const) {
      const stripped = s.replace(re, ' ');
      if (stripped !== s) {
        out.add(key);
        s = stripped;
      }
    }
    const low = s.toLowerCase();
    for (const p of PLATFORM_LIST) {
      if (low === p.key || hasKeyWord(low, p.key) || s.includes(p.name)) out.add(p.key);
    }
    for (const [alias, key] of Object.entries(PLATFORM_ALIASES)) {
      const a = alias.toLowerCase();
      // 纯 ASCII 别名（twitter/b站里的 b）同样按词边界，中文别名按子串
      if (/^[a-z0-9 ]+$/.test(a) ? hasKeyWord(low, a.trim()) : low.includes(a)) out.add(key);
    }
  }
  return [...out];
}

// LLM 输出常裹 markdown 代码块，剥掉再解析
function stripFence(text: string): string {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (m ? m[1] : text).trim();
}

// 校验入口：过不了就如实返回原因，绝不「修修补补硬塞进库」
export function validatePersonaCard(raw: unknown): { ok: true; card: PersonaCard } | { ok: false; issues: string[] } {
  const r = personaCardSchema.safeParse(raw);
  if (!r.success) {
    return { ok: false, issues: r.error.issues.map((i) => `${i.path.join('.') || '(根)'}：${i.message}`).slice(0, 6) };
  }
  // platforms 白名单化：认不出来的平台直接丢掉，不是报错（不影响其余字段可用）
  return { ok: true, card: { ...r.data, platforms: detectPlatforms(r.data.platforms) } };
}

// 从 LLM 原始文本到合规人设卡
export function parsePersonaResponse(text: string): { ok: true; card: PersonaCard } | { ok: false; issues: string[] } {
  let obj: unknown;
  try {
    obj = JSON.parse(stripFence(text));
  } catch {
    return { ok: false, issues: ['模型没有返回 JSON（可能返回了大段自然语言或空响应）'] };
  }
  return validatePersonaCard(obj);
}

function cut(s: string, max: number): string {
  const t = (s ?? '').trim();
  return t.length > max ? t.slice(0, max) : t;
}

// 入库清洗：任何路径（AI 扩写 / 手填）保存前都过这里。
// 宽松策略——只截断/白名单化，不拒绝：允许用户存半张卡慢慢补。
export function sanitizePersonaCard(input: Partial<PersonaCard> | null | undefined): PersonaCard {
  const p = input ?? {};
  const list = (arr: unknown, max: number) =>
    (Array.isArray(arr) ? arr : [])
      .filter((x): x is string => typeof x === 'string')
      .map((x) => cut(x, 60))
      .filter(Boolean)
      .slice(0, max);
  return {
    identity: cut(p.identity ?? '', 120),
    audience: cut(p.audience ?? '', 120),
    valueProp: cut(p.valueProp ?? '', 200),
    canDo: list(p.canDo, 8),
    cantDo: list(p.cantDo, 8),
    tone: cut(p.tone ?? '', 120),
    platforms: detectPlatforms(p.platforms),
    niche: cut(p.niche ?? '', 60),
  };
}

// ── 降级：LLM 不可用（含 dev 态 Mock）或输出不合 schema 时的本地规则草稿 ──
// 只做一件事：把用户自己说的话原样搬进对应字段。不编内容、不冒充 AI 生成。
export function localPersonaDraft(sentence: string, answers: PersonaAnswer[]): PersonaCard {
  const ans = (k: PersonaQuestionKey) =>
    answers.find((a) => a.key === k && !a.skipped && a.answer.trim())?.answer.trim() ?? '';
  const what = ans('what');
  const edge = ans('edge');
  return sanitizePersonaCard({
    identity: cut(sentence, 120),
    audience: ans('who'),
    valueProp: ans('why'),
    niche: cut(what, 60),
    tone: edge,
    canDo: what ? [cut(what, 60)] : [],
    cantDo: edge ? [cut(edge, 60)] : [],
    platforms: detectPlatforms(ans('platform')),
  });
}

// 逐字段置信度：由「用户答没答对应追问」决定，不问 LLM 要（模型自评置信度不可信）
export function buildFieldStates(answers: PersonaAnswer[], degraded: boolean): Record<PersonaFieldKey, PersonaFieldState> {
  const out = {} as Record<PersonaFieldKey, PersonaFieldState>;
  for (const k of PERSONA_FIELD_KEYS) {
    out[k] = degraded
      ? { confidence: 0.2, source: 'local', note: '本地草稿，未经 AI 扩写' }
      : { confidence: 0.6, source: 'sentence' };
  }
  for (const q of answers) {
    const fields = QUESTION_FIELDS[q.key] ?? [];
    for (const f of fields) {
      if (degraded) continue;
      out[f] = q.skipped
        ? { confidence: 0.35, source: 'ai-guess', note: '你跳过了这个问题，这是 AI 填的保守默认值' }
        : { confidence: 0.9, source: 'answer' };
    }
  }
  return out;
}

export function isLowConfidence(s: PersonaFieldState): boolean {
  return s.confidence < 0.5;
}

export function personaPromptBlock(p: PersonaCard): string {
  return [
    '【账号人设】',
    `身份：${p.identity || '（未填）'}`,
    `受众：${p.audience || '（未填）'}`,
    `价值主张：${p.valueProp || '（未填）'}`,
    `赛道：${p.niche || '（未填）'}`,
    `能做：${p.canDo.join('、') || '（未定义）'}`,
    `不能做：${p.cantDo.join('、') || '（未定义）'}`,
    `语气风格：${p.tone || '（未填）'}`,
    `主战平台：${p.platforms.join('、') || '（未填）'}`,
  ].join('\n');
}
