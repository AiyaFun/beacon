import { describe, it, expect } from 'vitest';
import {
  parsePersonaResponse,
  validatePersonaCard,
  sanitizePersonaCard,
  localPersonaDraft,
  buildFieldStates,
  detectPlatforms,
  isPersonaBlank,
  isLowConfidence,
  DEFAULT_PERSONA_QUESTIONS,
  PERSONA_QUESTION_KEYS,
  type PersonaAnswer,
} from '@/lib/persona';

// F3-1 人设卡 schema 闸门。
// 存在理由：人设是推荐/记忆/改写/智囊团的全局输入——一旦让 LLM 的脏输出进库，
// 下游每个功能都会拿着一坨占位文本当「用户是谁」。这里把「什么叫合格的人设卡」钉死。

const good = {
  identity: '教普通人用 AI 工具接单做副业的博主',
  audience: '想搞副业但没整块时间的职场新人',
  valueProp: '把 AI 接单流程拆成可复制的步骤',
  niche: 'AI 工具 / 副业',
  tone: '真诚、接地气，像朋友聊天',
  canDo: ['AI 工具实测', '接单流程拆解', '真实收入复盘'],
  cantDo: ['承诺具体收入', '荐股', '医疗建议'],
  platforms: ['douyin', 'xiaohongshu'],
};

describe('人设卡 schema 校验 · LLM 输出一律当不可信输入', () => {
  it('合格的完整卡片通过', () => {
    const r = validatePersonaCard(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.card.identity).toBe(good.identity);
  });

  it('Mock provider 的真实输出必须被判不合格（这是 dev 态的实际情形）', () => {
    // 实测：lib/llm/mock.ts 没有人设分支，json:true 时命中兜底返回 {"reply":"..."}。
    // 它长得像 JSON、parse 得动，但一个人设字段都没有——最危险的那种脏数据。
    const r = parsePersonaResponse('{"reply":"（Mock）已理解你的需求，建议从人设匹配度最高的两个热点切入。"}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.length).toBeGreaterThan(0);
  });

  it('模型返回大段自然语言（非 JSON）→ 不合格，不抛异常', () => {
    const r = parsePersonaResponse('好的！这是我为你写的人设卡：\n首先你是一个……');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toContain('JSON');
  });

  it('空响应 → 不合格', () => {
    expect(parsePersonaResponse('').ok).toBe(false);
  });

  it('markdown 代码块包裹的合格 JSON 能被剥出来（真实模型的常见习惯）', () => {
    const r = parsePersonaResponse('```json\n' + JSON.stringify(good) + '\n```');
    expect(r.ok).toBe(true);
  });

  it('字段缺失 → 不合格', () => {
    const { audience, ...missing } = good;
    expect(validatePersonaCard(missing).ok).toBe(false);
  });

  it('字段空字符串 / 纯空格 → 不合格（AC②要求五区块各字段非空）', () => {
    expect(validatePersonaCard({ ...good, identity: '' }).ok).toBe(false);
    expect(validatePersonaCard({ ...good, tone: '   ' }).ok).toBe(false);
  });

  it('「交差式」单字符输出 → 不合格', () => {
    expect(validatePersonaCard({ ...good, valueProp: '。' }).ok).toBe(false);
  });

  it('canDo/cantDo 空数组 → 不合格（内容边界不许空着）', () => {
    expect(validatePersonaCard({ ...good, canDo: [] }).ok).toBe(false);
    expect(validatePersonaCard({ ...good, cantDo: [] }).ok).toBe(false);
  });

  it('数组里混进非字符串 → 不合格', () => {
    expect(validatePersonaCard({ ...good, canDo: ['正常一条', 42, null] }).ok).toBe(false);
  });

  it('超长字段 → 不合格（防模型把整篇小作文塞进 identity）', () => {
    expect(validatePersonaCard({ ...good, identity: '啊'.repeat(200) }).ok).toBe(false);
  });

  it('根本不是对象 → 不合格', () => {
    for (const junk of [null, 42, 'string', []]) expect(validatePersonaCard(junk).ok).toBe(false);
  });
});

describe('平台白名单 · 模型幻觉出来的平台不许进库', () => {
  it('识别 key、中文名与常见别名', () => {
    expect(detectPlatforms(['douyin'])).toEqual(['douyin']);
    expect(detectPlatforms(['抖音'])).toEqual(['douyin']);
    expect(detectPlatforms(['微信公众号'])).toEqual(['wechat']);
    expect(detectPlatforms(['哔哩哔哩'])).toEqual(['bilibili']);
    expect(detectPlatforms(['Twitter'])).toEqual(['x']);
  });

  it('白名单外的平台被丢弃，其余字段照常可用', () => {
    const r = validatePersonaCard({ ...good, platforms: ['抖音', '知乎', '快手'] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.card.platforms).toEqual(['douyin']);
  });

  it('平台全是幻觉 → platforms 为空，但卡片仍合格（不因此毙掉整张卡）', () => {
    const r = validatePersonaCard({ ...good, platforms: ['Threads', 'Mastodon'] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.card.platforms).toEqual([]);
  });

  it('去重：同一平台的 key 与中文名同时出现只留一个', () => {
    expect(detectPlatforms(['douyin', '抖音'])).toEqual(['douyin']);
  });

  // 视频号与公众号同在微信生态，但算法口径/数据入口完全不同，认错一个会一路污染诊断与推荐。
  // 「微信视频号」里含「微信」，而 PLATFORM_ALIASES 的「微信」是子串匹配 → 必须先被剥离。
  describe('视频号 · 不能和公众号串台', () => {
    it('识别 key、中文名与别名', () => {
      expect(detectPlatforms(['shipinhao'])).toEqual(['shipinhao']);
      expect(detectPlatforms(['视频号'])).toEqual(['shipinhao']);
      expect(detectPlatforms(['微信视频号'])).toEqual(['shipinhao']);
    });

    it('「微信视频号」不得同时认出公众号', () => {
      expect(detectPlatforms(['微信视频号'])).not.toContain('wechat');
      expect(detectPlatforms(['我在做微信视频号和抖音'])).toEqual(expect.arrayContaining(['shipinhao', 'douyin']));
      expect(detectPlatforms(['我在做微信视频号和抖音'])).not.toContain('wechat');
    });

    it('剥离视频号后，剩下的文本照常认公众号 —— 两个都提到就两个都要', () => {
      const r = detectPlatforms(['公众号 + 视频号双开']);
      expect(r).toEqual(expect.arrayContaining(['wechat', 'shipinhao']));
      expect(r).toHaveLength(2);
    });

    it('单说「微信」仍然是公众号（不因为新增视频号就把老口径改掉）', () => {
      expect(detectPlatforms(['微信'])).toEqual(['wechat']);
      expect(detectPlatforms(['微信公众号'])).toEqual(['wechat']);
    });

    it('创作者后台域名也算提到视频号', () => {
      expect(detectPlatforms(['channels.weixin.qq.com'])).toEqual(['shipinhao']);
    });
  });
});

describe('入库清洗 sanitizePersonaCard · 手填与 AI 两条路径共用的最后一道闸', () => {
  it('截断超长字段而非拒绝（允许用户存半张卡慢慢补）', () => {
    const c = sanitizePersonaCard({ identity: '啊'.repeat(500) });
    expect(c.identity.length).toBe(120);
  });

  it('平台白名单化', () => {
    const c = sanitizePersonaCard({ platforms: ['douyin', '快手', 'evil'] });
    expect(c.platforms).toEqual(['douyin']);
  });

  it('数组元素上限 8 条、单条 60 字', () => {
    const c = sanitizePersonaCard({ canDo: Array.from({ length: 20 }, (_, i) => `条目${i}`), cantDo: ['啊'.repeat(99)] });
    expect(c.canDo.length).toBe(8);
    expect(c.cantDo[0].length).toBe(60);
  });

  it('null / undefined / 缺字段都能吃下，不抛', () => {
    expect(() => sanitizePersonaCard(null)).not.toThrow();
    expect(sanitizePersonaCard({}).canDo).toEqual([]);
  });

  it('数组里的非字符串被剔除', () => {
    const c = sanitizePersonaCard({ canDo: ['好的', 1, undefined, {}] as unknown as string[] });
    expect(c.canDo).toEqual(['好的']);
  });
});

describe('降级草稿 localPersonaDraft · 一个字都不许编', () => {
  const answers: PersonaAnswer[] = [
    { key: 'what', question: 'q', answer: 'AI 接单实操教程', skipped: false },
    { key: 'who', question: 'q', answer: '职场新人', skipped: false },
    { key: 'why', question: 'q', answer: '', skipped: true },
    { key: 'platform', question: 'q', answer: '主要发抖音和小红书', skipped: false },
  ];

  it('字段只来自用户自己说的话', () => {
    const card = localPersonaDraft('我是教人用 AI 做副业的博主', answers);
    expect(card.identity).toBe('我是教人用 AI 做副业的博主');
    expect(card.audience).toBe('职场新人');
    expect(card.niche).toBe('AI 接单实操教程');
  });

  it('跳过的问题对应字段留空——不编内容顶上', () => {
    const card = localPersonaDraft('我是教人用 AI 做副业的博主', answers);
    expect(card.valueProp).toBe('');
  });

  it('从平台答案的自由文本里认出平台 key', () => {
    const card = localPersonaDraft('句子', answers);
    expect(card.platforms.sort()).toEqual(['douyin', 'xiaohongshu']);
  });

  it('降级草稿本身过不了 schema —— 它就不是「AI 生成的人设卡」，不该冒充', () => {
    const card = localPersonaDraft('我是教人用 AI 做副业的博主', answers);
    expect(validatePersonaCard(card).ok).toBe(false);
  });
});

describe('逐项置信度 · 跳过的追问要标「待确认」（AC③）', () => {
  const answers: PersonaAnswer[] = [
    { key: 'what', question: 'q', answer: '答了', skipped: false },
    { key: 'who', question: 'q', answer: '', skipped: true },
  ];

  it('答过的追问 → 高置信，不标待确认', () => {
    const f = buildFieldStates(answers, false);
    expect(f.identity.source).toBe('answer');
    expect(isLowConfidence(f.identity)).toBe(false);
  });

  it('跳过的追问 → 低置信 + ai-guess + 有说明文案', () => {
    const f = buildFieldStates(answers, false);
    expect(f.audience.source).toBe('ai-guess');
    expect(isLowConfidence(f.audience)).toBe(true);
    expect(f.audience.note).toContain('跳过');
  });

  it('降级时全部字段标 local 且低置信', () => {
    const f = buildFieldStates(answers, true);
    for (const k of Object.keys(f) as (keyof typeof f)[]) {
      expect(f[k].source).toBe('local');
      expect(isLowConfidence(f[k])).toBe(true);
    }
  });

  it('八个字段一个不漏都有状态（UI 靠它逐项渲染徽标）', () => {
    const f = buildFieldStates([], false);
    expect(Object.keys(f).sort()).toEqual(
      ['audience', 'canDo', 'cantDo', 'identity', 'niche', 'platforms', 'tone', 'valueProp'].sort(),
    );
  });
});

describe('冷启动入口的显隐 · 老用户不该被打扰', () => {
  it('三个核心字段全空 → 顶冷启动', () => {
    expect(isPersonaBlank(sanitizePersonaCard({}))).toBe(true);
  });

  it('只要填了任一核心字段 → 不再顶冷启动', () => {
    expect(isPersonaBlank(sanitizePersonaCard({ identity: '博主' }))).toBe(false);
    expect(isPersonaBlank(sanitizePersonaCard({ audience: '职场人' }))).toBe(false);
  });

  it('只填了平台这种边角字段 → 仍算空白（人设没起步）', () => {
    expect(isPersonaBlank(sanitizePersonaCard({ platforms: ['douyin'] }))).toBe(true);
  });
});

describe('兜底追问 · PRD 点名的三问必须在', () => {
  it('数量落在 PRD 的 3–5 问区间', () => {
    expect(DEFAULT_PERSONA_QUESTIONS.length).toBeGreaterThanOrEqual(3);
    expect(DEFAULT_PERSONA_QUESTIONS.length).toBeLessThanOrEqual(5);
  });

  it('卖什么 / 给谁 / 凭什么 一个不少', () => {
    const keys = DEFAULT_PERSONA_QUESTIONS.map((q) => q.key);
    expect(keys).toContain('what');
    expect(keys).toContain('who');
    expect(keys).toContain('why');
  });

  it('key 全在白名单内且不重复', () => {
    const keys = DEFAULT_PERSONA_QUESTIONS.map((q) => q.key);
    for (const k of keys) expect(PERSONA_QUESTION_KEYS).toContain(k);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
