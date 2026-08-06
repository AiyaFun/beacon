import { llmComplete } from '../llm/gateway';
import { platformName } from '../constants';
import type { WordHit } from './engine';

export type SemanticHit = {
  snippet: string;
  reason: string;
  action: 'warn' | 'suggest';
  suggestion: string;
};

export type SemanticReviewResult = {
  hits: SemanticHit[];
  mocked: boolean;
};

const MIN_TEXT_LENGTH = 10;

export async function llmSemanticReview(
  text: string,
  platform: string,
  tenantId: string,
  dfaHits: WordHit[],
): Promise<SemanticReviewResult> {
  if (text.length < MIN_TEXT_LENGTH) return { hits: [], mocked: false };

  const dfaWords = [...new Set(dfaHits.map((h) => h.word))];

  const sys = `你是内容合规语义审核引擎。任务：找出 DFA 词库匹配无法捕获的语义违规。

重点排查：
1. 变体极限词（"第1""No.1""头牌""断货王"等变体）
2. 隐含虚假承诺（"亲测有效""包你满意""零风险"）
3. 诱导/紧迫性表达（"限时""最后X名""不买就亏""错过再等一年"）
4.「${platformName(platform)}」平台特定违规（引流、私信、站外交易等）
5. 行业夸大宣传（医疗/金融/教育领域的疗效/收益承诺）

以下词语已被词库捕获，不要重复报告：${dfaWords.length ? dfaWords.join('、') : '无'}

输出 JSON 数组，每个元素：
{"snippet":"原文问题片段","reason":"违规原因(一句话)","action":"warn或suggest","suggestion":"建议改为"}

没有额外发现时输出 []。只报告真正有风险的，不过度解读日常用语。`;

  const usr = `目标平台：${platformName(platform)}\n待审核文案：\n${text}`;

  try {
    const r = await llmComplete(tenantId, 'compliance', [
      { role: 'system', content: sys },
      { role: 'user', content: usr },
    ], { temperature: 0.2, json: true });

    const hits = parseSemanticHits(r.text);
    return { hits, mocked: r.mocked };
  } catch {
    return { hits: [], mocked: false };
  }
}

function parseSemanticHits(text: string): SemanticHit[] {
  try {
    const raw = JSON.parse(text);
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((h: unknown): h is Record<string, unknown> =>
        typeof h === 'object' && h !== null && typeof (h as Record<string, unknown>).snippet === 'string' && typeof (h as Record<string, unknown>).reason === 'string',
      )
      .slice(0, 10)
      .map((h) => ({
        snippet: String(h.snippet),
        reason: String(h.reason),
        action: h.action === 'warn' ? 'warn' as const : 'suggest' as const,
        suggestion: String(h.suggestion || ''),
      }));
  } catch {
    return [];
  }
}
