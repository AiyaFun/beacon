import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PLATFORMS } from '@/lib/constants';
import {
  AI_SOURCE,
  AI_SOURCE_UNKNOWN_NOTE,
  AI_SOURCE_VERSION,
  aiSourceOf,
  shouldHintWechatAiSource,
  WECHAT_DERIVE_HINT,
} from '@/lib/algorithm/ai-source';

const SRC = readFileSync(resolve(process.cwd(), 'lib/algorithm/ai-source.ts'), 'utf8');
// 2026-08-25「看效果」三合一后，算法教练的渲染从 app/(app)/algorithm/page.tsx 搬到了
// components/insight/AlgorithmPanel.tsx（作为 /data 的一个标签）。这个源码级守卫跟着指向新文件。
const PAGE = readFileSync(resolve(process.cwd(), 'components/insight/AlgorithmPanel.tsx'), 'utf8');

describe('🔒 引擎信源表：一格 no 都不许有', () => {
  // 这是全文件最重要的守卫。手上的证据只有一份「哪些平台**被统计到**进了引用池」的第三方报告，
  // 从来没有任何一条证据形如「某平台**不**进任何引擎的引用池」。把「权重表里没这行」印成 'no'，
  // 就是把缺席当 0——hotScore 那次（无播放量平台写死 0）一路污染了进榜、排序、选题候选和 AI 上下文。
  it('运行时：每一格只能是 yes 或 unknown', () => {
    for (const [key, row] of Object.entries(AI_SOURCE)) {
      expect(['yes', 'unknown'], `${key} 的 coverage 越界了`).toContain(row.coverage);
      expect(row.coverage, `${key} 被写成了 no——请先读 ai-source.ts 开头那段`).not.toBe('no');
    }
  });

  it('源码级：类型口径本身不许被放宽成三档', () => {
    // 光靠上一条拦不住「先把 'no' 加进 union、下次再填格子」这种两步走：
    // vitest 不跑 tsc，类型放宽当场是绿的，等有人真填了才红。
    const m = SRC.match(/export type AiSourceCoverage\s*=\s*([^;]+);/);
    expect(m, '找不到 AiSourceCoverage 的定义，守卫已经失效').toBeTruthy();
    expect(m![1].trim()).toBe("'yes' | 'unknown'");
    expect(SRC).not.toMatch(/coverage:\s*'no'/);
  });
});

describe('🔒 引擎信源表：结构完整性', () => {
  it('必须覆盖全部 PlatformKey——漏配一个平台就是「表里没有 → 缺省 unknown」', () => {
    // Record<PlatformKey, …> 在 tsc 下会报错，但 vitest 不跑 tsc，得在运行时再钉一遍。
    expect(Object.keys(AI_SOURCE).sort()).toEqual(Object.keys(PLATFORMS).sort());
  });

  it('unknown 的格子不许有引擎名——没有结论就不许有结论的样子', () => {
    for (const [key, row] of Object.entries(AI_SOURCE)) {
      if (row.coverage !== 'unknown') continue;
      expect(row.engine, `${key} 是 unknown 却挂了引擎名`).toBeNull();
      expect(row.confidence, `${key} 是 unknown 却给了可信度`).toBeNull();
    }
  });

  it('yes 的格子必须有引擎名与可信度，且最高只到行业共识', () => {
    for (const [key, row] of Object.entries(AI_SOURCE)) {
      if (row.coverage !== 'yes') continue;
      expect(row.engine, `${key} 说 yes 却不说是哪个引擎`).toBeTruthy();
      // 证据是第三方统计报告，不是平台官方披露、也不是开源代码，够不到 official/opensource。
      expect(row.confidence).toBe('consensus');
    }
  });

  it('每一格都要有出处和口径年份，不然半年后没人敢改', () => {
    for (const [key, row] of Object.entries(AI_SOURCE)) {
      expect(row.source, `${key} 没写出处`).toBeTruthy();
      expect(row.asOf, `${key} 没写口径年份`).toMatch(/^\d{4}$/);
      expect(row.note, `${key} 没写人话说明`).toBeTruthy();
    }
  });

  it('note 里不许出现百分比或评分——这张表给不出那种精度', () => {
    for (const [key, row] of Object.entries(AI_SOURCE)) {
      expect(row.note, `${key} 的 note 印了个数字精度`).not.toMatch(/\d\s*%|\d\s*分/);
    }
  });

  it('口径版本号在，出问题时能一眼看出用户看到的是哪一版', () => {
    expect(AI_SOURCE_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('aiSourceOf / shouldHintWechatAiSource', () => {
  it('认不出来的键返回 null，让调用方整块不渲染', () => {
    // 返回一行 unknown 会让页面看起来像「我们查过了，不知道」——伪平台压根不该进这张表。
    expect(aiSourceOf('multi')).toBeNull();
    // ⚠️ 2026-08-19 之前这里写的是 'weibo'——那天微博进了 PLATFORMS，它就不再是「认不出来的键」了。
    // 举例子要挑一个**确实不在 PLATFORMS 里**的，否则这条断言测的是「表漏配」而不是「兜底」。
    expect(aiSourceOf('douban')).toBeNull();
    expect(aiSourceOf('')).toBeNull();
    expect(aiSourceOf('wechat')?.engine).toBe('腾讯元宝');
  });

  it('只对「有别的平台号、偏偏没有公众号」的人提示', () => {
    expect(shouldHintWechatAiSource(['douyin'])).toBe(true);
    expect(shouldHintWechatAiSource(['douyin', 'xiaohongshu'])).toBe(true);
    // 已经有公众号：他在做了，再提示一遍是噪音
    expect(shouldHintWechatAiSource(['douyin', 'wechat'])).toBe(false);
    // 一个号都没建：先建号比谈 AI 引用池重要，这时候弹提示是给新人加任务
    expect(shouldHintWechatAiSource([])).toBe(false);
    // 伪平台不算「别的平台号」
    expect(shouldHintWechatAiSource(['multi'])).toBe(false);
  });

  it('提示文案只有一处定义，页面引用它而不是抄一遍', () => {
    const derive = readFileSync(resolve(process.cwd(), 'app/(app)/studio/DeriveCard.tsx'), 'utf8');
    expect(derive, '只 import 了没渲染').toMatch(/\{WECHAT_DERIVE_HINT\}/);
    expect(derive).not.toContain(WECHAT_DERIVE_HINT);
  });
});

// ── 源码级：这块数据不许流出「只读小卡」 ────────────────────────────────────
//
// 八格里六格是 unknown。喂给 LLM，模型会自动把「没人统计过」讲成「这个平台对 AI 不可见」；
// 进发布前 Checklist，就变成一条可勾选的动作项。两种都是拿缺席当结论。
// 所以判据不是「提示词里别提 AI」这种模糊话，而是：aiSource 这几个标识符
// **在 llmComplete 调用结束之前一次都不许出现**（checklist 在它上面几十行，一并管住）。
describe('🔒 页面只读渲染：AI 信源不许进提示词，也不许进 Checklist', () => {
  // 注释里提到 AI_SOURCE 是在解释「为什么不接」，不算接线；import 行同理。
  const CODE = PAGE.split('\n')
    .map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l))
    .map((l) => (l.includes("from '@/lib/algorithm/ai-source'") ? '' : l))
    .join('\n');

  /** 从 open 处的左括号开始，返回配对右括号的下标（+1）。 */
  function matchParen(s: string, open: number): number {
    let depth = 0;
    for (let i = open; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return -1;
  }

  const callStart = CODE.indexOf('llmComplete(');
  const callEnd = matchParen(CODE, CODE.indexOf('(', callStart));

  it('守卫本身没瞎——确实找到了那个 llmComplete 调用', () => {
    expect(callStart).toBeGreaterThan(0);
    expect(callEnd).toBeGreaterThan(callStart);
    // 括号配对没跑飞：调用体里应当还看得见提示词的骨架
    const call = CODE.slice(callStart, callEnd);
    expect(call).toContain('role');
    expect(call).toContain('平台算法信号');
    expect(call.length).toBeLessThan(4000);
  });

  it('llmComplete 的参数里一个 aiSource 都不许有', () => {
    expect(CODE.slice(callStart, callEnd)).not.toMatch(/aiSource|AI_SOURCE/);
  });

  it('提示词与 Checklist 都在它前面构建，所以第一次用到 aiSource 必须在调用之后', () => {
    // trusted / checklist / ruleLines 全在 llmComplete 上方；把「调用结束前不许出现」一条钉死，
    // 就同时管住了「塞进提示词」和「塞进发布前 Checklist」两种接法。
    const firstUse = CODE.search(/aiSource|AI_SOURCE/);
    expect(firstUse, '页面里根本没用 aiSource，守卫失去意义').toBeGreaterThan(0);
    expect(firstUse).toBeGreaterThan(callEnd);
  });

  it('unknown 的解释文案只有一处定义，页面引用常量而不是抄一遍', () => {
    // 断在插值上：光 import 就占一处，两处渲染删光照样绿
    expect(PAGE, '只 import 了没渲染').toMatch(/\{AI_SOURCE_UNKNOWN_NOTE\}/);
    expect(PAGE).not.toContain(AI_SOURCE_UNKNOWN_NOTE);
  });
});
