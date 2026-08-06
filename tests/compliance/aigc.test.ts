import { describe, it, expect, vi, afterEach } from 'vitest';
import { hasAigcLabel, ensureAigcLabel, AIGC_LABEL, buildAigcMetadata, aigcMetadataJson, aigcHtmlPayload } from '@/lib/compliance/aigc';

afterEach(() => vi.unstubAllEnvs());

describe('aigc · AIGC_LABEL 文案符合 GB 45438-2025', () => {
  it('同时含「人工智能/AI」与「生成/合成」两类关键词', () => {
    expect(AIGC_LABEL).toMatch(/人工智能|AI/);
    expect(AIGC_LABEL).toMatch(/生成|合成/);
  });

  it('标识文案本身能被 hasAigcLabel 识别（自洽）', () => {
    expect(hasAigcLabel(AIGC_LABEL)).toBe(true);
  });
});

// ── 本文件的核心：锁死 `text.includes('AI 生成')` 那个误判 ──
// 旧实现只要正文里出现「AI 生成」四个字就判定已带标识，于是真标识不再追加 → 违反《办法》第四条。
// 这是「合规检查反而导致不合规」，且只在特定正文下触发，肉眼 review 极难发现。
describe('aigc · hasAigcLabel 误判回归锁（正文提及 ≠ 已标识）', () => {
  const 正文提及但无标识 = [
    'AI 生成的图片最近很火，我来聊聊这个话题。',
    '今天讲讲怎么用 AI 生成短视频封面。',
    '本内容由人工智能生成的部分只占一小段，其余是我自己写的。', // 行尾续了正文 → 不是标识
    '很多人问我 AI 生成内容算不算原创。',
    '人工智能生成技术的发展速度超出想象。',
    '这篇文章讨论 AI 合成语音的伦理问题。',
  ];

  for (const text of 正文提及但无标识) {
    it(`不应误判为已标识：${text.slice(0, 20)}…`, () => {
      expect(hasAigcLabel(text)).toBe(false);
    });
  }

  for (const text of 正文提及但无标识) {
    it(`ensureAigcLabel 必须补上真标识：${text.slice(0, 14)}…`, () => {
      const out = ensureAigcLabel(text);
      expect(out).toContain(AIGC_LABEL);
      expect(out.length).toBeGreaterThan(text.length);
    });
  }
});

// ── 第二轮修复的回归锁：Markdown 块级结构符被当成装饰符剥掉 ──
// 上一轮把 `text.includes('AI 生成')` 换成整行正则，误判换了个姿势重现：
// DECOR_HEAD 里含 `#`/`-`，于是 `## AI 生成`（一篇讲 AI 绘图的文章的小标题）被剥成 `AI 生成`
// → 命中整行正则 → 判定「已带标识」→ ensureAigcLabel 静默不追加 → 导出件无标识 → 违反第四条。
//
// 两道防线，任一失效本组都会红：
// 1. `#`/`-`/`+` 不再算装饰符（块级结构承载语义，剥掉等于改写正文）；`*`/`_` 按 Markdown 规则
//    区分「强调符紧贴文字」与「列表符后跟空白」。
// 2. 整行正则要求 (由|系|为|经) 必填 —— 光杆名词短语不是声明。
describe('aigc · hasAigcLabel 回归锁：Markdown 结构符 ≠ 装饰符', () => {
  it('审查的原始复现：讲「做图方式」的文章不得被判为已标识', () => {
    const draft = '# 三种做图方式对比\n\n## AI 生成\n成本低、速度快。\n\n## 手绘\n慢。';
    expect(hasAigcLabel(draft)).toBe(false);
    expect(ensureAigcLabel(draft)).toContain(AIGC_LABEL); // 标识必须真的补上
  });

  const 结构符行 = [
    '# AI 生成',
    '## AI 生成',
    '### AI 生成内容',
    '- AI 生成',
    '+ AI 生成',
    '* AI生成', // 列表符（后跟空白）≠ 强调符
    '1. AI 生成',
    '> AI 生成', // 引用块
    '> 人工智能生成',
  ];

  for (const text of 结构符行) {
    it(`结构符行不算标识：${JSON.stringify(text)}`, () => {
      expect(hasAigcLabel(text)).toBe(false);
    });
  }

  // 整行恰好是一句合法声明、但挂在块级结构里 —— 人也难判，故一律往「不算标识」兜底：
  // 代价只是多补一条标识，比「无标识」这个违规结果轻得多。
  for (const text of ['- 本内容由AI生成', '* 本内容由人工智能生成', '## 本内容由人工智能生成']) {
    it(`块级结构里的声明按不算标识兜底：${JSON.stringify(text)}`, () => {
      expect(hasAigcLabel(text)).toBe(false);
      expect(hasAigcLabel(ensureAigcLabel(text))).toBe(true);
    });
  }
});

// 光杆名词短语：`AI生成` / `人工智能生成` 单独成行，与 Markdown 标题内容**逐字符相同**，
// 无法区分。故按不算标识处理（上一轮把它们当标识，正是 `## AI 生成` 误判的另一半原因）。
describe('aigc · hasAigcLabel 收紧：光杆名词短语不是声明', () => {
  for (const text of ['AI生成', 'AI 生成', '人工智能生成', '人工智能合成']) {
    it(`不算标识（缺「由/系/为/经」）：${JSON.stringify(text)}`, () => {
      expect(hasAigcLabel(text)).toBe(false);
    });
  }

  it('漏判方向安全：会补一条真标识，绝不会得到无标识结果', () => {
    expect(hasAigcLabel(ensureAigcLabel('AI生成'))).toBe(true);
  });
});

describe('aigc · hasAigcLabel 正例（整行即标识）', () => {
  const 是标识 = [
    '本内容由人工智能生成',
    '本内容由 AI 生成',
    '——本内容由人工智能生成', // ensureAigcLabel 自己的产物：破折号是 U+2014，不是 ASCII `-`
    '【本内容由人工智能生成】',
    '（本内容由AI生成）',
    '*本内容由人工智能生成*', // 强调符紧贴文字 → 是装饰
    '**本内容由人工智能生成**',
    '_本内容由人工智能生成_',
    '> 本内容由人工智能生成',
    '> **本内容由人工智能生成**', // 嵌套装饰要逐层剥净
    '本内容由人工智能生成。',
    '本文章由AI生成合成',
    '此视频由人工智能合成',
    '该文案由AI辅助生成',
    '  本内容由人工智能生成  ',
  ];

  for (const text of 是标识) {
    it(`识别为标识：${JSON.stringify(text)}`, () => {
      expect(hasAigcLabel(text)).toBe(true);
    });
  }

  it('标识在多行正文的末尾也能识别', () => {
    expect(hasAigcLabel(`第一段。\n第二段。\n\n——${AIGC_LABEL}`)).toBe(true);
  });

  it('标识在起始位置也能识别（第四条允许起始/末尾/中间）', () => {
    expect(hasAigcLabel(`${AIGC_LABEL}\n\n正文开始。`)).toBe(true);
  });

  it('标识在中间位置也能识别', () => {
    expect(hasAigcLabel(`正文上半。\n${AIGC_LABEL}\n正文下半。`)).toBe(true);
  });

  it('旧文案「本内容由 AI 生成」向后兼容（历史内容不该被重复加标）', () => {
    expect(hasAigcLabel('正文。\n\n——本内容由 AI 生成')).toBe(true);
  });
});

// ⚠️ 已知缺口（测试写到这里时发现，非回归）：整行匹配正则的名词枚举
//    `(内容|文本|文章|文案|图片|视频|音频)` 里**没有光杆的「文」**，
//    所以「本文由AI生成」「该文由AI生成」这类最口语的写法漏判，而「本文章由AI生成」「本文本由AI生成」正常。
//
// 严重度评估（方向决定一切）：
//   · 漏判(false negative) → ensureAigcLabel 会**再补一条**标识 → 出现重复标识。难看，但**偏安全**。
//   · 误判(false positive) → 真标识不再追加 → **违反《办法》第四条**。这才是致命方向，且已被正确修复。
// 故本缺口不构成合规风险，不阻塞上线；修法是在名词枚举里加 `文`（注意别把「文」写在「文章|文本」前面，
// 交替是最左优先，会把长词吃掉）。
//
// 这里断言的是**当前真实行为**而非期望行为——一旦有人修好正则，这几条会变红，
// 那时把它们挪进上面的正例组即可。刻意留成显式记录，不让缺口悄悄消失。
describe('aigc · 已知缺口：光杆「文」漏判（偏安全方向，见上方注释）', () => {
  for (const text of ['本文由AI生成', '本文由人工智能生成', '该文由AI生成']) {
    it(`当前漏判（修好后本条应变红并移入正例）：${JSON.stringify(text)}`, () => {
      expect(hasAigcLabel(text)).toBe(false);
    });
  }

  it('漏判的后果只是重复标识，不会导致「无标识」这种违规结果', () => {
    const out = ensureAigcLabel('本文由AI生成');
    expect(out).toContain(AIGC_LABEL); // 标识一定在 → 合规底线守住
  });
});

describe('aigc · ensureAigcLabel 幂等', () => {
  it('已带标识 → 原样返回，不重复追加', () => {
    const once = ensureAigcLabel('正文内容。');
    expect(ensureAigcLabel(once)).toBe(once);
  });

  it('连跑三次与跑一次结果一致', () => {
    const a = ensureAigcLabel('正文内容。');
    expect(ensureAigcLabel(ensureAigcLabel(a))).toBe(a);
    expect((a.match(new RegExp(AIGC_LABEL, 'g')) ?? []).length).toBe(1);
  });

  it('追加到文末且与正文空行分隔', () => {
    expect(ensureAigcLabel('正文。')).toBe(`正文。\n\n——${AIGC_LABEL}`);
  });

  it('正文尾部空白被规整，不产生多余空行', () => {
    expect(ensureAigcLabel('正文。\n\n\n  ')).toBe(`正文。\n\n——${AIGC_LABEL}`);
  });

  it('空正文也会带上标识（空导出同样是出口）', () => {
    expect(hasAigcLabel(ensureAigcLabel(''))).toBe(true);
  });

  it('原正文内容不被破坏', () => {
    const text = '第一段。\n第二段有 AI 生成这个词。';
    expect(ensureAigcLabel(text).startsWith(text)).toBe(true);
  });
});

describe('aigc · 隐式标识元数据（第五条 / GB 45438-2025）', () => {
  it('Label=1 表示生成合成内容', () => {
    expect(buildAigcMetadata('c-1').AIGC.Label).toBe('1');
  });

  it('ProduceID 原样带入', () => {
    expect(buildAigcMetadata('content-42').AIGC.ProduceID).toBe('content-42');
  });

  it('ContentProducer 默认回退产品名（dev 零配置可跑）', () => {
    expect(buildAigcMetadata('c-1').AIGC.ContentProducer).toBe('烽火台');
  });

  it('NEXT_PUBLIC_AIGC_PRODUCER 优先（复制出口跑在客户端，只有 NEXT_PUBLIC_* 会被注入）', () => {
    vi.stubEnv('NEXT_PUBLIC_AIGC_PRODUCER', '某某科技');
    expect(buildAigcMetadata('c-1').AIGC.ContentProducer).toBe('某某科技');
  });

  it('BEACON_AIGC_PRODUCER 作为服务端回退', () => {
    vi.stubEnv('BEACON_AIGC_PRODUCER', '服务端主体');
    expect(buildAigcMetadata('c-1').AIGC.ContentProducer).toBe('服务端主体');
  });

  it('aigcMetadataJson 输出可解析 JSON', () => {
    expect(JSON.parse(aigcMetadataJson('c-9')).AIGC.ProduceID).toBe('c-9');
  });
});

describe('aigc · aigcHtmlPayload（复制出口的 text/html flavor）', () => {
  it('HTML 特殊字符被转义，防止正文注入标记', () => {
    const html = aigcHtmlPayload('<script>alert(1)</script>', 'c-1');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('& 被转义', () => {
    expect(aigcHtmlPayload('a & b', 'c-1')).toContain('a &amp; b');
  });

  it('换行转 <br>', () => {
    expect(aigcHtmlPayload('第一行\n第二行', 'c-1')).toContain('第一行<br>第二行');
  });

  it('挂上了元数据注释与 meta 标签', () => {
    const html = aigcHtmlPayload('正文', 'c-7');
    expect(html).toContain('<!--{"AIGC"');
    expect(html).toContain('name="aigc-metadata"');
    expect(html).toContain('data-aigc-label="1"');
  });

  it('meta 的 content 里引号被转义，属性不会被提前闭合', () => {
    expect(aigcHtmlPayload('正文', 'c-1')).toContain('&quot;');
  });
});
