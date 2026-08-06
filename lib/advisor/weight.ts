// 智囊团人物的「战绩 → 权重」纯函数层（无任何 IO 依赖）。
//
// 单独成文件而不是留在 panel.ts：learn.ts（发布回流）需要在数据校准人物战绩时复算权重，
// 而 panel.ts → account-context.ts → insight/learn.ts 已构成引用链，learn 再反向 import panel
// 就成了模块环。权重规则本身是纯计算，抽成叶子模块两边都能安全引用。

// verdict 语义：
//   adopted/rejected  用户手动检验（智囊团页逐条采纳/否决）
//   data_proven/data_failed  发布数据校准（W-5：该提案转成的选题发布后跑赢/跑输账号基线）
export type LearnedNote = {
  verdict: 'adopted' | 'rejected' | 'data_proven' | 'data_failed';
  text: string;
  at: string;
};

// 唱反调者与合规审查员豁免降权（他们的价值恰恰是说不中听的话）
export const DEMOTION_EXEMPT = new Set(['expert_contrarian', 'expert_compliance']);

// 数据校准的权重增量：数据说了算，但幅度刻意小于用户手动采纳（0.12），
// 因为单篇发布的表现噪声大——它是佐证，不是判决。上下各封顶 0.3，防一串爆款把某人物顶到天花板。
const DATA_PROVEN_STEP = 0.06;
const DATA_FAILED_STEP = 0.05;
const DATA_DELTA_CAP = 0.3;

export function dataDeltaFromNotes(notes: LearnedNote[]): number {
  let delta = 0;
  for (const n of notes) {
    if (n.verdict === 'data_proven') delta += DATA_PROVEN_STEP;
    else if (n.verdict === 'data_failed') delta -= DATA_FAILED_STEP;
  }
  return Math.max(-DATA_DELTA_CAP, Math.min(DATA_DELTA_CAP, Math.round(delta * 100) / 100));
}

// 自学习权重：采纳加权、否决减权，再叠加发布数据校准；豁免人物权重下限为 1
export function advisorWeight(
  adoptedCount: number,
  rejectedCount: number,
  key: string,
  dataDelta = 0,
): number {
  const raw = 1 + 0.12 * adoptedCount - 0.08 * rejectedCount + dataDelta;
  const lo = DEMOTION_EXEMPT.has(key) ? 1 : 0.3;
  return Math.min(2, Math.max(lo, Math.round(raw * 100) / 100));
}
