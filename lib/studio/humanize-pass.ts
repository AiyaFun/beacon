import { humanizeReport, humanizeProblemBlock, type HumanizeReport } from '../humanize/score';
import { aiFlavorBanBlock } from '../humanize/lexicon';
import { checkFactDrift } from '../humanize/factcheck';
import { llmComplete } from '../llm/gateway';
import type { ChatMessage } from '../llm/types';
import { personaPromptBlock, type PersonaCard } from '../persona';
import type { AccountContext } from '../account-context';
import { platformFormatBlock, tidyDraft } from './platform-format';
import { checkPlatformFit, formatProblemBlock, fitSummary, type FormatFitReport } from './format-check';
import { checkVoiceFit, voiceProblemBlock, type VoiceSpec, type VoiceViolation } from '../humanize/voice';

// 成稿收口（2026-09-16 起）：**像不像人写的** + **合不合这个平台**，两把尺子一次量完、一次改完。
//
// 【为什么是出口这一道，不是把提示词再写长】提示词只降概率——本项目在「提示词泄漏」上栽过三次，
// 结论一直是同一条：**出口清洗才是保证**。这里把两份零 LLM 的确定性体检
// （lib/humanize/score.ts 人味分 + lib/studio/format-check.ts 平台格式）挪到每个起稿出口的
// 落库之前：测出问题就再调一次模型，把**被检出的那几处**改掉，其余一字不动；改完再测一遍，
// 没变好就用原稿。
//
// 【2026-09-17 这一版改了什么，为什么】用户：「就地起稿得内容，还是不符合各个平台的意思，
// 还是很强的 ai 味」。拿真机那份初稿回测，发现这一道**对最典型的 AI 稿从来没触发过**——
// 旧的人味分给它打了 90 分（详见 humanize/structure.ts 顶部）。同时平台格式只在提示词里
// 说过一遍，落库前没有任何检查。所以：
//   ① 判定加上结构性 AI 指纹（栏目名/装饰 emoji/分点模板/讨好收尾）与平台格式违规；
//   ② 修复那一次调用同时收到「套话清单」和「不合平台的清单」，一次改两样；
//   ③ 允许**最多两轮**：第二轮只在第一轮改完仍有硬伤时才跑，且每一轮都必须证明变好。
//
// 【三条纪律】
//   ① 只在测出问题时才多调模型（干净的稿子一次都不调，不白烧额度）；
//   ② 改稿不许添事实：改完过 checkFactDrift，冒出原文没有的数字/引语/来源就整篇作废用原稿；
//   ③ 永远不因为这一道失败而让起稿失败：模型没返回/被拒/超时，都回原稿并在 note 里说明。

/** 人味分低于它就再改一遍（score 是 20-100，80 以上读者基本认不出 AI） */
export const HUMANIZE_TARGET_SCORE = 80;

/** 最多调几次模型修。第二次只在第一次改完仍有硬伤（bad 级）时才发生。 */
export const MAX_FIX_ROUNDS = 2;

export type HumanizeVerdict = {
  needed: boolean;
  reasons: string[];
  report: HumanizeReport;
  /** 平台格式体检（2026-09-17 加）。判定与修复都要用它。 */
  fit: FormatFitReport;
  /** 跟这个账号平时说法对不上的地方（没有说话方式规格时恒为空） */
  voiceIssues: VoiceViolation[];
};

/**
 * 判这篇要不要再改一遍。三把尺子：像不像人（humanizeReport）、合不合平台（checkPlatformFit）、
 * 是不是**他**在说（checkVoiceFit，只在量得出说话方式时才判）。
 */
export function judgeDraft(text: string, platform: string, voice?: VoiceSpec | null): HumanizeVerdict {
  const report = humanizeReport(text, platform);
  const fit = checkPlatformFit(text, platform);
  const voiceIssues = checkVoiceFit(text, voice);
  const reasons: string[] = [];
  if (report.hits.length > 0) reasons.push(`命中 ${report.hits.length} 处套话`);
  for (const f of report.findings) if (f.severity === 'bad') reasons.push(f.dimension);
  if (report.sufficient && report.score < HUMANIZE_TARGET_SCORE) reasons.push(`人味分 ${report.score} 低于 ${HUMANIZE_TARGET_SCORE}`);
  // 格式：bad 级（缺标题 / 残留 markdown / 栏目名 / 语言不对 / 字数超一大截）一定要改；
  // warn 级（标签少了几个、某段偏长）单独出现时也值得顺手改——反正只要有一样要改，
  // 这一次调用就已经发生了，多带几条几乎不增加成本。
  // **但「字数偏短」不算理由**：那只能靠编内容来补，见 REPAIR_EXEMPT_CODES。
  if (fit.repairable.length > 0) reasons.push(fitSummary(fit));
  for (const v of voiceIssues) reasons.push(v.finding);
  return { needed: reasons.length > 0, reasons: [...new Set(reasons)], report, fit, voiceIssues };
}

export type HumanizePassInput = {
  text: string;
  platform: string;
  report: HumanizeReport;
  /** 平台格式违规清单。不传 = 只修 AI 味（老调用方仍可用） */
  fit?: FormatFitReport;
  /** 与账号平时说法对不上的地方 */
  voiceIssues?: VoiceViolation[];
  personaBlock?: string;
  /** 原句样本 + 口头禅 + 指纹：改成「他的说法」而不是「另一种 AI 的说法」 */
  voiceBlock?: string;
  formatBlock?: string;
};

/** 与工坊「一键去 AI 味」（actDeflavor）同一套口径，外加：逐条列出命中位置、不许破坏平台格式。 */
export function buildHumanizePassMessages(input: HumanizePassInput): ChatMessage[] {
  const hitLines = input.report.hits.slice(0, 20).map((h, i) => `${i + 1}. 「${h.word}」→ ${h.suggestion}`);
  const fitBlock = input.fit ? formatProblemBlock(input.fit) : '';
  return [
    {
      role: 'system',
      content: [
        '你的任务是把一篇带着「AI 腔」的稿子改成像真人写的，同时改成这个平台该有的样子。**信息一个不许少、一个不许加**——不是重写，是换一种说法；没被点名的句子尽量一字不动。',
        input.personaBlock || '',
        input.voiceBlock || '',
        voiceProblemBlock(input.voiceIssues ?? []),
        humanizeProblemBlock(input.report),
        hitLines.length ? ['【被点名的套话（每一处都要处理）】', ...hitLines].join('\n') : '',
        fitBlock,
        input.formatBlock || '',
        aiFlavorBanBlock(),
        [
          '【怎么改】',
          '- 套话整句删掉，或换成具体的人、事、数字、时间；换个同义套话等于没改；',
          '- 栏目名（【xx】）、每段一个 emoji、「关键词：解释」式分点，全部拆掉改成连着说的话——这几样是读者一眼认出 AI 的地方；',
          '- 打散节奏：让几句话变短，短到只剩半句也行；再让一两句放长。不要句句等长；',
          '- 拆掉排比对仗（不仅…而且 / 不是…而是 / 既…又），留最有力的一组就够；去掉「首先/其次/最后」这类路标词；',
          '- 段落不要等长，允许一段只有一句话；关键的一句可以单独成段；',
          '- 结尾不要「欢迎在评论区」「你怎么看」「那么问题来了」；换成一句立得住的判断，或一个具体到能直接回答的问题；',
          '- 保留原文的事实、数据、结论与顺序，不要新增任何未经核实的内容。',
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
  /** 改前/改后的平台格式硬伤数（UI 与测试按它断言） */
  fitBefore?: number;
  fitAfter?: number;
  /** 实际调了几次模型（0 = 稿子本来就干净） */
  rounds?: number;
};

function scoreOf(r: HumanizeReport): number | null {
  return r.sufficient ? r.score : null;
}

/** 这一版比那一版好吗？先看硬伤数，再看套话数，最后看人味分。 */
function isBetter(
  cand: { fit: FormatFitReport; report: HumanizeReport },
  base: { fit: FormatFitReport; report: HumanizeReport },
): { ok: boolean; why: string } {
  if (cand.fit.badCount > base.fit.badCount) return { ok: false, why: '平台格式硬伤反而更多' };
  if (cand.report.hits.length > base.report.hits.length) return { ok: false, why: '套话反而更多' };
  const a = scoreOf(base.report);
  const b = scoreOf(cand.report);
  if (a !== null && b !== null && b < a) return { ok: false, why: `人味分 ${a} → ${b}` };
  return { ok: true, why: '' };
}

/**
 * 跑一遍成稿收口。没测出问题 → 原样返回（不调模型）；测出问题 → 最多调两次模型改，
 * 每一次都要比上一版更好才采用。绝不抛：这一道失败不该让起稿失败。
 */
export async function humanizePass(
  tenantId: string | null,
  text: string,
  platform: string,
  opts: { personaBlock?: string; voiceBlock?: string; formatBlock?: string; providerId?: string; timeoutMs?: number; voice?: VoiceSpec | null } = {},
): Promise<HumanizePassResult> {
  const body = (text ?? '').trim();
  const verdict = judgeDraft(body, platform, opts.voice);
  const before = scoreOf(verdict.report);
  const fitBefore = verdict.fit.badCount;
  if (!body || !verdict.needed) {
    return { text: body, changed: false, before, after: before, reasons: [], fitBefore, fitAfter: fitBefore, rounds: 0 };
  }

  // 「当前最好的一版」。第一轮的基准是原稿；被采纳后基准就换成新的那版。
  let best = { text: body, report: verdict.report, fit: verdict.fit, voiceIssues: verdict.voiceIssues };
  let rounds = 0;
  let improved = false;
  let lastNote = '';
  // true = lastNote 已经是一句完整的交代（抛错/未接模型），不要再套「不如原稿」的壳
  let hardFail = false;
  let attempted = false;

  for (let round = 0; round < MAX_FIX_ROUNDS; round++) {
    // 第二轮的门开得很小，因为它要多花一次额度：
    //   ① 上一轮**确实改好了**（改不动的稿子，同一份提示词再来一次也改不动——
    //      本项目在「成稿顽固带『### 标题：』」上验证过两次，最后是靠代码剥掉的）；
    //   ② 而且剩下的是**平台格式硬伤**（缺标题 / 语言不对 / 字数差一大截）——
    //      这类是模型能一次改对、且不改就交付不了的；节奏、对仗这些偏好级问题不值得再烧一次。
    if (round > 0 && !(improved && (best.fit.repairBadCount > 0 || best.voiceIssues.length > 0))) break;

    const messages = buildHumanizePassMessages({
      text: best.text, platform, report: best.report, fit: best.fit, voiceIssues: best.voiceIssues,
      personaBlock: opts.personaBlock, voiceBlock: opts.voiceBlock,
      formatBlock: opts.formatBlock ?? platformFormatBlock(platform),
    });
    let raw: { text: string; mocked: boolean };
    attempted = true;
    try {
      raw = await llmComplete(tenantId, 'generation', messages, {
        temperature: 0.7,
        timeoutMs: opts.timeoutMs ?? 90_000,
        ...(opts.providerId ? { providerId: opts.providerId } : {}),
      });
    } catch (e) {
      lastNote = `去 AI 味这一步没跑成（${(e as Error).message.slice(0, 80)}），用的是${rounds > 0 ? '上一版' : '原稿'}`;
      hardFail = true;
      break;
    }
    rounds += 1;
    if (raw.mocked) { lastNote = '没接真实模型，去 AI 味这一步跳过'; hardFail = true; break; }

    const candidate = tidyDraft(raw.text, platform);
    if (!candidate) { lastNote = '模型没返回内容'; break; }
    // 长度始终对**原稿**比：连着两轮各缩 40% 也是失控。
    if (candidate.length < body.length * 0.5 || candidate.length > body.length * 1.6) { lastNote = '长度变化太大'; break; }
    // 事实漂移也始终对原稿比：第二轮编的数字不能因为第一轮的稿子里有就放行。
    const drift = checkFactDrift(body, candidate);
    if (drift.level !== 'none') { lastNote = `冒出了原文没有的${drift.level === 'number' ? '数字' : '引语或来源'}`; break; }

    const candReport = humanizeReport(candidate, platform);
    const candFit = checkPlatformFit(candidate, platform);
    const candVoice = checkVoiceFit(candidate, opts.voice);
    const verdictBetter = isBetter({ fit: candFit, report: candReport }, best);
    if (!verdictBetter.ok) { lastNote = verdictBetter.why; break; }
    if (candidate === best.text) { lastNote = '模型原样退回，没有可改的了'; break; }

    improved =
      candFit.badCount < best.fit.badCount ||
      candReport.hits.length < best.report.hits.length ||
      (scoreOf(candReport) ?? 0) > (scoreOf(best.report) ?? 0);
    best = { text: candidate, report: candReport, fit: candFit, voiceIssues: candVoice };
  }

  const after = scoreOf(best.report);
  const fitAfter = best.fit.badCount;
  if (best.text === body) {
    return {
      text: body, changed: false, before, after: before, reasons: verdict.reasons, rounds, fitBefore, fitAfter: fitBefore,
      note: !attempted ? undefined : hardFail ? lastNote : `去 AI 味改出来的一版不如原稿（${lastNote || '没有变好'}），用的是原稿`,
    };
  }

  const bits: string[] = [];
  if (before !== null && after !== null && after !== before) bits.push(`人味分 ${before} → ${after}`);
  const cleared = verdict.report.hits.length - best.report.hits.length;
  if (cleared > 0) bits.push(`去掉 ${cleared} 处套话`);
  if (fitBefore > fitAfter) bits.push(`平台格式硬伤 ${fitBefore} → ${fitAfter}`);
  const voiceFixed = verdict.voiceIssues.length - best.voiceIssues.length;
  if (voiceFixed > 0) bits.push(`口吻对齐 ${voiceFixed} 处`);
  if (bits.length === 0) bits.push('已按平台格式与人味体检修过一遍');
  return {
    text: best.text, changed: true, before, after, reasons: verdict.reasons, rounds, fitBefore, fitAfter,
    note: `已自动去 AI 味并对齐平台格式：${bits.join('，')}${rounds > 1 ? `（改了 ${rounds} 轮）` : ''}`,
  };
}

/** 各起稿出口共用的收尾：拼上人设/语感/格式再跑 humanizePass。 */
export async function finishDraft(input: {
  tenantId: string | null;
  text: string;
  platform: string;
  persona?: PersonaCard;
  /** 传整份 accountCtx 就行：voice 规格随它一起来，各出口不用各自再算一遍 */
  accountCtx?: Pick<AccountContext, 'parts'> & Partial<Pick<AccountContext, 'voice'>>;
  providerId?: string;
}): Promise<HumanizePassResult> {
  const parts = input.accountCtx?.parts ?? {};
  return humanizePass(input.tenantId, input.text, input.platform, {
    personaBlock: input.persona ? personaPromptBlock(input.persona) : undefined,
    // voice 排在最前：改写时先定「谁在说、怎么称呼读者」，再谈句子长短
    voiceBlock: [parts.voice, parts.exemplar, parts.catchphrase, parts.fingerprint].filter(Boolean).join('\n\n') || undefined,
    formatBlock: platformFormatBlock(input.platform),
    providerId: input.providerId,
    voice: input.accountCtx?.voice ?? null,
  });
}
