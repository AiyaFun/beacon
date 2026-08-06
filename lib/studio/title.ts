import { parseJson } from '../json';
import { scanAiFlavor } from '../humanize/lexicon';
import { platformName } from '../constants';

// 标题矩阵 + 封面建议。
//
// 【为什么这块必须补上】产品此前只产出正文：算法教练在诊断「封面标题够不够勾」、
// 智囊团里有专门看「标题封面怎么配」的席位——**产品在评判一个它自己不生产的东西**。
// 而在中文平台上，标题与封面决定了至少一半的点击。正文写得再好，没人点开就等于没写。
//
// 【为什么是矩阵不是一个标题】一个标题没法比较，用户只能接受或不接受。
// 给出角度互不相同的一组，用户是在**选**而不是在**审**——选比审快，也更容易选到他自己敢发的那个。
// 角度固定成下面 6 种（不让模型自由发挥），是为了保证这一组之间真的不同：
// 让模型自己想 6 个标题，它给的多半是同一个角度的 6 种措辞。

export type TitleAngle = {
  key: string;
  name: string;
  brief: string;
};

export const TITLE_ANGLES: TitleAngle[] = [
  { key: 'result', name: '结果前置', brief: '把最终结果/数字直接摆在标题里，不留悬念' },
  { key: 'suspense', name: '悬念缺口', brief: '给出一个信息缺口，让人非点开不可（但不许标题党式欺骗）' },
  { key: 'counter', name: '反常识', brief: '说一句和大多数人认知相反、且你能自圆其说的话' },
  { key: 'identity', name: '身份指向', brief: '点名说给谁听，让目标读者对号入座' },
  { key: 'listicle', name: '数字清单', brief: '用具体条数承诺信息密度' },
  { key: 'pain', name: '痛点提问', brief: '把读者心里那句抱怨原样说出来' },
];

// 各平台标题长度建议区间（字符数）。
// ⚠️ 这些是**方向性经验值**，不是平台官方参数——与 algorithm/content-optimizer.ts 同一约定，
// UI 上不许说成「平台规定」。小红书的 20 字是硬上限（超了会被截断），单独标出来。
export type TitleLengthRule = { min: number; max: number; hardMax?: number; note: string };

export const TITLE_LENGTH_RULES: Record<string, TitleLengthRule> = {
  douyin: { min: 8, max: 22, note: '手机上一行放不下就会被折，前 12 个字要能独立成立' },
  xiaohongshu: { min: 10, max: 20, hardMax: 20, note: '小红书标题上限 20 字，超出会被截断' },
  wechat: { min: 10, max: 26, note: '订阅号列表里长标题会被截断，关键信息放前 14 字' },
  bilibili: { min: 10, max: 24, note: '首页卡片两行内能读完最好' },
  shipinhao: { min: 8, max: 20, note: '视频号标题短促为宜，说清对谁有用' },
  zhihu: { min: 12, max: 32, note: '知乎可以长一点，但要像一句人话不像标题党' },
  x: { min: 6, max: 40, note: '推文首句即标题，凝练为上' },
  youtube: { min: 10, max: 40, note: '搜索结果里约 60 个字符后会被截断' },
  // TikTok 的文案兼任标题与话题标签位，且是叠在画面上的——写长了会挡住画面并被折叠
  tiktok: { min: 6, max: 60, note: '文案叠在画面上，前 40 个字符之后会被「更多」折叠；标签另计' },
};

export function titleLengthRule(platform: string): TitleLengthRule {
  return TITLE_LENGTH_RULES[platform] ?? { min: 8, max: 26, note: '控制在一行内读完' };
}

export type TitleCandidate = { angle: string; title: string; why: string };
export type CoverSuggestion = { headline: string; sub: string; visual: string; note: string };
export type TitleMatrix = { titles: TitleCandidate[]; cover: CoverSuggestion | null };

export type TitleDiagnosis = {
  chars: number;
  severity: 'good' | 'warn' | 'bad';
  notes: string[];
};

// 逐条诊断（纯规则，零 LLM）：长度、套话、是否有具体信息。
// 合规红线不在这里判——那要查库，由 action 层用同一套 redlineHits 做，语义与导出硬闸一致。
export function diagnoseTitle(title: string, platform: string): TitleDiagnosis {
  const t = (title ?? '').trim();
  const chars = t.length;
  const rule = titleLengthRule(platform);
  const notes: string[] = [];
  let severity: TitleDiagnosis['severity'] = 'good';

  if (rule.hardMax && chars > rule.hardMax) {
    severity = 'bad';
    notes.push(`${chars} 字，超过${platformName(platform)}的 ${rule.hardMax} 字上限，会被截断`);
  } else if (chars > rule.max) {
    severity = 'warn';
    notes.push(`${chars} 字偏长（建议 ${rule.min}-${rule.max}）：${rule.note}`);
  } else if (chars < rule.min) {
    severity = 'warn';
    notes.push(`${chars} 字偏短（建议 ${rule.min}-${rule.max}），信息量可能不够`);
  }

  const flavor = scanAiFlavor(t);
  if (flavor.length > 0) {
    severity = severity === 'bad' ? 'bad' : 'warn';
    notes.push(`含套话「${flavor.map((f) => f.word).join('、')}」，标题里的套话最劝退`);
  }

  // 具体信息：数字、时间、专名括号之类。一个都没有的标题往往等于什么都没说。
  // 「两/俩/半/倍」必须算数字：真机跑出来的第一组标题里就有「收入涨了两成」被误报成「没有任何数字」——
  // 中文口语里的量恰恰最常用这几个字，漏掉它们等于对着写得最自然的那条标题挑错。
  if (!/[0-9０-９一二三四五六七八九十百千万两俩半倍]/.test(t) && chars >= rule.min) {
    notes.push('没有任何数字/具体量词，可以考虑加一个具体的数让承诺落地');
  }

  if (notes.length === 0) notes.push('长度与用词都没问题');
  return { chars, severity, notes };
}

// 生成提示词。角度写死，标题条数 = 角度条数。
export function buildTitlePrompt(opts: {
  platform: string;
  draftTitle: string;
  content: string;
  contextBlock?: string;
}): string {
  const rule = titleLengthRule(opts.platform);
  return [
    `为下面这篇「${platformName(opts.platform)}」稿件写一组标题，并给一版封面建议。`,
    opts.contextBlock ? opts.contextBlock : '',
    `【当前标题】${opts.draftTitle}`,
    `【正文】\n${opts.content.slice(0, 2500)}`,
    '【标题要求】',
    `- 每个角度各写 1 条，共 ${TITLE_ANGLES.length} 条，角度不许串味：`,
    ...TITLE_ANGLES.map((a) => `  · ${a.key}（${a.name}）：${a.brief}`),
    `- 长度控制在 ${rule.min}-${rule.max} 字${rule.hardMax ? `（硬上限 ${rule.hardMax} 字）` : ''}；`,
    '- 只能用正文里真实存在的信息，**不许编造数字、结果或身份**——标题承诺的东西正文必须兑现，否则是标题党，平台会限流；',
    '- 不要出现「震惊」「速看」「99% 的人都不知道」这类诱导式模板，也不要用大模型套话；',
    '- why 字段用一句话说清这个标题赌的是读者的什么心理。',
    '【封面要求】',
    '- headline：封面主文案，不超过 12 字，能被一眼读完；',
    '- sub：副文案，不超过 18 字，可为空字符串；',
    '- visual：画面建议（拍什么/放什么图/主体在画面哪个位置），一句话；',
    '- note：为什么这么设计，一句话。',
    '【输出】严格输出 JSON，不要 markdown 围栏、不要任何解释：',
    '{"titles":[{"angle":"result","title":"…","why":"…"}],"cover":{"headline":"…","sub":"…","visual":"…","note":"…"}}',
  ].filter(Boolean).join('\n');
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// 解析 LLM 输出。宽进严出：字段缺失就丢那一条，整体解析不了返回空矩阵（调用方据此如实告诉用户失败）。
export function parseTitleMatrix(raw: string): TitleMatrix {
  const obj = parseJson<Record<string, unknown>>(stripFence(raw), {});
  const list = Array.isArray(obj.titles) ? obj.titles : [];
  const known = new Set(TITLE_ANGLES.map((a) => a.key));
  const titles: TitleCandidate[] = [];
  const seen = new Set<string>();
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const title = str(o.title, 60);
    if (!title || seen.has(title)) continue; // 同一条标题重复出现只留一条
    seen.add(title);
    const angle = str(o.angle, 20);
    titles.push({
      angle: known.has(angle) ? angle : 'other',
      title,
      why: str(o.why, 120),
    });
  }
  const c = obj.cover && typeof obj.cover === 'object' ? (obj.cover as Record<string, unknown>) : null;
  const cover: CoverSuggestion | null = c
    ? {
        headline: str(c.headline, 30),
        sub: str(c.sub, 40),
        visual: str(c.visual, 200),
        note: str(c.note, 160),
      }
    : null;
  return { titles, cover: cover && cover.headline ? cover : null };
}

// 有些模型即使被要求「只输出 JSON」也会包一层 ```json 围栏（与 gateway 里那处兜底同源问题）
function stripFence(raw: string): string {
  const t = (raw ?? '').trim();
  if (!t.startsWith('```')) return t;
  return t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
}

export function angleName(key: string): string {
  return TITLE_ANGLES.find((a) => a.key === key)?.name ?? '其他';
}
