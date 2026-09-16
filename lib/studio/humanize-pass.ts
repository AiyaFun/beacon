import { humanizeReport, humanizeProblemBlock, type HumanizeReport } from '../humanize/score';
import { aiFlavorBanBlock } from '../humanize/lexicon';
import { checkFactDrift } from '../humanize/factcheck';
import { llmComplete } from '../llm/gateway';
import type { ChatMessage } from '../llm/types';
import { personaPromptBlock, type PersonaCard } from '../persona';
import type { AccountContext } from '../account-context';
import { platformFormatBlock, tidyDraft } from './platform-format';

// 自动去 AI 味（2026-09-16，用户：「初稿那个，要看起来不是 ai 写的」）。
//
// 【为什么是第二道，不是把提示词再写长】提示词只降概率——本项目在「提示词泄漏」上栽过三次，
// 结论一直是同一条：**出口清洗才是保证**。这里把「人味体检」（lib/humanize/score.ts，用户在工坊里
// 手动点的那个）挪到每个起稿出口的落库之前：测出套话、句长一律、排比堆叠、段落等长任何一样，
// 就再调一次模型，把**被检出的那几处**改掉，其余一字不动；改完再测一遍，没变好就用原稿。
//
// 【三条纪律】
//   ① 只在测出问题时才多调一次（多数情况是一次额度）；测不出就原样放行，不白烧；
//   ② 改稿不许添事实：改完过 checkFactDrift，冒出原文没有的数字/引语/来源就整篇作废用原稿；
//   ③ 永远不因为这一道失败而让起稿失败：模型没返回/被拒/超时，都回原稿并在 note 里说明。

/** 人味分低于它就再改一遍（score 是 20-100，80 以上读者基本认不出 AI） */
export const HUMANIZE_TARGET_SCORE = 80;

export type HumanizeVerdict = { needed: boolean; reasons: string[]; report: HumanizeReport };

export function judgeDraft(text: string, platform: string): HumanizeVerdict {
  const report = humanizeReport(text, platform);
  const reasons: string[] = [];
  if (report.hits.length > 0) reasons.push(`命中 ${report.hits.length} 处套话`);
  for (const f of report.findings) if (f.severity === 'bad') reasons.push(f.dimension);
  if (report.sufficient && report.score < HUMANIZE_TARGET_SCORE) reasons.push(`人味分 ${report.score} 低于 ${HUMANIZE_TARGET_SCORE}`);
  return { needed: reasons.length > 0, reasons: [...new Set(reasons)], report };
}

export type HumanizePassInput = {
  text: string;
  platform: string;
  report: HumanizeReport;
  personaBlock?: string;
  /** 原句样本 + 口头禅 + 指纹：改成「他的说法」而不是「另一种 AI 的说法」 */
  voiceBlock?: string;
  formatBlock?: string;
};

/** 与工坊「一键去 AI 味」（actDeflavor）同一套口径，外加：逐条列出命中位置、不许破坏平台格式。 */
export function buildHumanizePassMessages(input: HumanizePassInput): ChatMessage[] {
  const hitLines = input.report.hits.slice(0, 20).map((h, i) => `${i + 1}. 「${h.word}」→ ${h.suggestion}`);
  return [
    {
      role: 'system',
      content: [
        '你的任务是把一篇带着「AI 腔」的稿子改成像真人写的。**信息一个不许少、一个不许加**——不是重写，是换一种说法；没被点名的句子尽量一字不动。',
        input.personaBlock || '',
        input.voiceBlock || '',
        humanizeProblemBlock(input.report),
        hitLines.length ? ['【被点名的套话（每一处都要处理）】', ...hitLines].join('\n') : '',
        input.formatBlock || '',
        aiFlavorBanBlock(),
        [
          '【怎么改】',
          '- 套话整句删掉，或换成具体的人、事、数字、时间；换个同义套话等于没改；',
          '- 打散节奏：让几句话变短，短到只剩半句也行；再让一两句放长。不要句句等长；',
          '- 拆掉排比对仗（不仅…而且 / 不是…而是 / 既…又），留最有力的一组就够；去掉「首先/其次/最后」这类路标词；',
          '- 段落不要等长，允许一段只有一句话；关键的一句可以单独成段；',
          '- 保留原文的事实、数据、结论、顺序与平台格式（标题行、话题标签、段落数量级），不要新增任何未经核实的内容。',
        ].join('\n'),
        '最后确认一遍：改好的正文里出现的每一个事实、数字、时间、人物、经历，都必须能在**原文**里找到。上面那些风格样本是别的稿子，只借语感，一个字的内容都不许搬。',
        '只输出改好的正文，不要解释、不要列出你改了什么。',
      ].filter(Boolean).join('\n\n'),
    },
    { role: 'user', content: input.text },
  ];
}

export type HumanizePassResult = {
  text: string;
  changed: boolean;
  /** 改前/改后的人味分；文本太短算不出时为 null */
  before: number | null;
  after: number | null;
  reasons: string[];
  /** 给人看的一句话：改了什么、或为什么没改 */
  note?: string;
};

function scoreOf(r: HumanizeReport): number | null {
  return r.sufficient ? r.score : null;
}

/**
 * 跑一遍去 AI 味。没测出问题 → 原样返回（不调模型）；测出问题 → 调一次模型改，改得更好才采用。
 * 绝不抛：这一道失败不该让起稿失败。
 */
export async function humanizePass(
  tenantId: string | null,
  text: string,
  platform: string,
  opts: { personaBlock?: string; voiceBlock?: string; formatBlock?: string; providerId?: string; timeoutMs?: number } = {},
): Promise<HumanizePassResult> {
  const body = (text ?? '').trim();
  const verdict = judgeDraft(body, platform);
  const before = scoreOf(verdict.report);
  if (!body || !verdict.needed) return { text: body, changed: false, before, after: before, reasons: [] };

  const messages = buildHumanizePassMessages({
    text: body, platform, report: verdict.report,
    personaBlock: opts.personaBlock, voiceBlock: opts.voiceBlock,
    formatBlock: opts.formatBlock ?? platformFormatBlock(platform),
  });
  let raw: { text: string; mocked: boolean };
  try {
    raw = await llmComplete(tenantId, 'generation', messages, {
      temperature: 0.7,
      timeoutMs: opts.timeoutMs ?? 90_000,
      ...(opts.providerId ? { providerId: opts.providerId } : {}),
    });
  } catch (e) {
    return { text: body, changed: false, before, after: before, reasons: verdict.reasons, note: `去 AI 味这一步没跑成（${(e as Error).message.slice(0, 80)}），用的是原稿` };
  }
  if (raw.mocked) return { text: body, changed: false, before, after: before, reasons: verdict.reasons, note: '没接真实模型，去 AI 味这一步跳过' };

  const candidate = tidyDraft(raw.text, platform);
  const keep = (why: string): HumanizePassResult => ({ text: body, changed: false, before, after: before, reasons: verdict.reasons, note: `去 AI 味改出来的一版不如原稿（${why}），用的是原稿` });
  if (!candidate) return keep('模型没返回内容');
  if (candidate.length < body.length * 0.5 || candidate.length > body.length * 1.6) return keep('长度变化太大');
  const drift = checkFactDrift(body, candidate);
  if (drift.level !== 'none') return keep(`冒出了原文没有的${drift.level === 'number' ? '数字' : '引语或来源'}`);
  const afterReport = humanizeReport(candidate, platform);
  const after = scoreOf(afterReport);
  if (afterReport.hits.length > verdict.report.hits.length) return keep('套话反而更多');
  if (before !== null && after !== null && after < before) return keep(`人味分 ${before} → ${after}`);

  const scoreNote = before !== null && after !== null ? `人味分 ${before} → ${after}` : `去掉了 ${verdict.report.hits.length - afterReport.hits.length} 处套话`;
  return { text: candidate, changed: true, before, after, reasons: verdict.reasons, note: `已自动去 AI 味：${scoreNote}` };
}

/** 各起稿出口共用的收尾：拼上人设/语感/格式再跑 humanizePass。 */
export async function finishDraft(input: {
  tenantId: string | null;
  text: string;
  platform: string;
  persona?: PersonaCard;
  accountCtx?: Pick<AccountContext, 'parts'>;
  providerId?: string;
}): Promise<HumanizePassResult> {
  const parts = input.accountCtx?.parts ?? {};
  return humanizePass(input.tenantId, input.text, input.platform, {
    personaBlock: input.persona ? personaPromptBlock(input.persona) : undefined,
    voiceBlock: [parts.exemplar, parts.catchphrase, parts.fingerprint].filter(Boolean).join('\n\n') || undefined,
    formatBlock: platformFormatBlock(input.platform),
    providerId: input.providerId,
  });
}
