import { buildAccountContext } from '../account-context';
import { finePrompt, type ScoredTopic } from '../topic/scoring';

// P1-8 智囊团提案进精排。
//
// 此前采纳一条人物提案直接拍 totalScore=75 落库，于是选题池里 advisor 来源的选题与
// hot/competitor 来源的选题分数不可比——一个是拍的，一个是六维算的，排序混在一起没有意义。
// 这里让提案也走一次 finePrompt 单条评分（带同一套账号上下文），分数口径与每日推荐对齐。
//
// 失败一律返回 null 交调用方兜底：采纳这个动作本身不能因为一次 LLM 抖动就失败。

export type ProposalScore = {
  angle: string;
  rationale: string;
  scores: ScoredTopic['scores'];
  totalScore: number;
  mocked: boolean;
};

export async function scoreAdvisorProposal(input: {
  tenantId: string | null;
  workspaceId: string;
  accountId: string;
  suggestion: string;
  rationale: string;
}): Promise<ProposalScore | null> {
  try {
    const ctx = await buildAccountContext({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      blocks: ['fingerprint', 'baseline', 'audience', 'memory'],
      memoryQuery: input.suggestion,
      maxChars: 3000,
    });
    const scored = await finePrompt(
      input.tenantId,
      {
        title: input.suggestion.slice(0, 60),
        // 提案不是榜单热点，没有外部热度可言：给中性值，不伪造热度。
        // heat 只影响粗排，单条精排用不到它，这里仅为满足 Candidate 契约。
        heat: 0.5,
        sourceType: 'advisor',
      },
      ctx.persona,
      ctx.parts.memory ?? '',
      [ctx.parts.fingerprint, ctx.parts.baseline].filter(Boolean).join('\n\n'),
    );
    return {
      angle: scored.angle,
      rationale: [input.rationale, scored.rationale].filter((x) => x && x.trim()).join('\n\n'),
      scores: scored.scores,
      totalScore: scored.totalScore,
      mocked: scored.mocked,
    };
  } catch {
    return null;
  }
}
