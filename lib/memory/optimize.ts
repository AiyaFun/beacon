import { prisma } from '../db';
import { backfillMissingEmbeddings } from '../vector/store';
import { MEMORY_TYPES } from '../constants';

// 记忆的「持续学习·优化」通道（需求②）。定时 + 手动 + bot /优化 三入口共用。
//
// 设计守住 PRD §8 两条红线：
//   1. 数据只提议、人设由用户定 —— 本 pass 只做「可见可回退的记忆卫生」：去重合并、
//      到阈值的推断结论生效、老旧低信度的单次观察降权停用（遗忘不清零）。
//      任何触及「人设卡」的改动一律只生成**建议**（personaLearningProposals），由用户在页面确认。
//   2. 遗忘是降权不是删除 —— retire = active:false，条目仍在、仍可被语义召回/用户恢复，绝不 delete
//      （唯一会 delete 的只有「与另一条完全重复」的冗余副本，且其 hitCount 已并入存活条目）。

const ACTIVATION_HITS = 2;
const DECAY_HALF_LIFE_DAYS = 30;
const DECAY_FLOOR = 0.2;

// 遗忘停用阈值（三条同时满足才停，刻意保守，避免误杀好记忆）：
const RETIRE_AGE_DAYS = 45; // 45 天没再被验证
const RETIRE_MAX_HITS = 1; // 只被观察过一次
const RETIRE_MAX_CONF = 0.35; // 且置信度很低

function recencyFactor(updatedAt: Date, now: number): number {
  const ageDays = Math.max(0, (now - updatedAt.getTime()) / 86_400_000);
  return Math.max(DECAY_FLOOR, Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS));
}

// 归一化用于去重：去空白 + 去首尾标点。中文无大小写，够用。
function normContent(s: string): string {
  return s.trim().replace(/\s+/g, '').replace(/[。，、；：！？.,;:!?]+$/g, '');
}

export type OptimizeResult = {
  scanned: number;
  merged: number; // 合并掉的重复副本数
  promoted: number; // 达阈值新生效（学到并采纳）
  retired: number; // 降权停用（遗忘）
  embedded: number; // 本轮补算的向量条数（换嵌入模型后的自愈）
  active: number; // 优化后生效总数
  total: number; // 优化后总条数
  summaryText: string; // 给 bot/UI 的一句话小结
};

// 对某工作区跑一次优化。accountId 省略=全工作区（含共享记忆）。
export async function optimizeWorkspaceMemory(workspaceId: string): Promise<OptimizeResult> {
  const now = Date.now();
  const all = await prisma.memoryEntry.findMany({ where: { workspaceId } });
  const scanned = all.length;

  // ── 1) 去重合并：同 (accountId, type, 归一化内容) 只留一条，hitCount 求和、confidence 取最大 ──
  const groups = new Map<string, typeof all>();
  for (const m of all) {
    const k = `${m.accountId ?? 'ws'}|${m.type}|${normContent(m.content)}`;
    const g = groups.get(k);
    if (g) g.push(m);
    else groups.set(k, [m]);
  }
  let merged = 0;
  const survivors: typeof all = [];
  for (const g of groups.values()) {
    if (g.length === 1) {
      survivors.push(g[0]);
      continue;
    }
    // 存活者：置信度最高 → hitCount 最高 → 建立最早
    g.sort((a, b) => b.confidence - a.confidence || b.hitCount - a.hitCount || a.createdAt.getTime() - b.createdAt.getTime());
    const keep = g[0];
    const dups = g.slice(1);
    const sumHits = g.reduce((n, m) => n + m.hitCount, 0);
    const maxConf = Math.min(1, g.reduce((c, m) => Math.max(c, m.confidence), 0));
    await prisma.memoryEntry.update({
      where: { id: keep.id },
      data: { hitCount: sumHits, confidence: maxConf, active: keep.type === 'persona' ? true : sumHits >= ACTIVATION_HITS || maxConf >= 0.7 },
    });
    await prisma.memoryEntry.deleteMany({ where: { id: { in: dups.map((d) => d.id) } } });
    merged += dups.length;
    survivors.push({ ...keep, hitCount: sumHits, confidence: maxConf });
  }

  // ── 2) 生效/遗忘 ──
  let promoted = 0;
  let retired = 0;
  for (const m of survivors) {
    // 生效：达阈值但还没 active
    const shouldActive = m.type === 'persona' || m.hitCount >= ACTIVATION_HITS || m.confidence >= 0.7;
    if (shouldActive && !m.active) {
      await prisma.memoryEntry.update({ where: { id: m.id }, data: { active: true } });
      promoted++;
      continue;
    }
    // 遗忘：老 + 单次 + 低信度的推断类，降权停用（不删）
    if (
      m.active &&
      m.type !== 'persona' &&
      m.hitCount <= RETIRE_MAX_HITS &&
      m.confidence < RETIRE_MAX_CONF &&
      (now - m.updatedAt.getTime()) / 86_400_000 > RETIRE_AGE_DAYS &&
      recencyFactor(m.updatedAt, now) <= DECAY_FLOOR
    ) {
      await prisma.memoryEntry.update({ where: { id: m.id }, data: { active: false } });
      retired++;
    }
  }

  const total = survivors.length;
  const active = survivors.filter((m) => {
    if (m.type === 'persona' || m.hitCount >= ACTIVATION_HITS || m.confidence >= 0.7) return true;
    return false;
  }).length;

  const parts: string[] = [];
  if (merged) parts.push(`合并重复 ${merged} 条`);
  if (promoted) parts.push(`新生效 ${promoted} 条`);
  if (retired) parts.push(`降权遗忘 ${retired} 条`);
  // 换嵌入模型后的自愈：把缺向量的生效记忆补算回来（用应用自己的嵌入器，见 backfillMissingEmbeddings）。
  // 放在这里而不是单独任务：它天然是「记忆卫生」的一部分，且每天跑一次的节奏正合适。
  // 失败不影响本轮其余结论——补不上明天接着补。
  // ⚠️ 结果只进结构化字段，**不进 summaryText**：补向量是内部卫生，不是用户眼里的「记忆变更」。
  // 混进小结会让「这周记忆有什么变化」这句话里冒出一条用户看不懂也不关心的信息
  //（既有用例断言的正是「无实质变更时要说已是最优」）。要看它去 job detail / 日志。
  const embedded = await backfillMissingEmbeddings(workspaceId).catch(() => 0);

  const summaryText = parts.length
    ? `${parts.join('，')}；当前 ${active}/${total} 条记忆生效。`
    : `记忆已是最优（共 ${total} 条，${active} 条生效），无需调整。`;

  return { scanned, merged, promoted, retired, active, total, embedded, summaryText };
}

// ── 人设改进建议（纯规则、零 LLM、只提议）──
// 从高频生效的偏好/绩效记忆里，提炼「可以固化进人设卡」的建议，供用户在人设页确认。
export type LearningProposal = { kind: string; text: string; evidence: string };

export function personaLearningProposals(
  memories: { type: string; content: string; confidence: number; hitCount: number; active: boolean }[],
): LearningProposal[] {
  const proposals: LearningProposal[] = [];
  const strong = memories.filter((m) => m.active && m.hitCount >= ACTIVATION_HITS);

  const prefs = strong.filter((m) => m.type === 'preference');
  if (prefs.length >= 2) {
    proposals.push({
      kind: 'persona',
      text: '你的改稿口味已稳定成形，考虑把这些偏好写进人设卡的「风格」，让每次生成默认就对味。',
      evidence: prefs.slice(0, 3).map((p) => p.content).join('；'),
    });
  }
  const perf = strong.filter((m) => m.type === 'performance');
  if (perf.length >= 2) {
    proposals.push({
      kind: 'direction',
      text: '有几类内容你的数据反复验证跑得好，考虑把它固化成账号的「擅长方向」，选题引擎会更聚焦。',
      evidence: perf.slice(0, 3).map((p) => p.content).join('；'),
    });
  }
  const facts = strong.filter((m) => m.type === 'fact');
  if (facts.length >= 3) {
    proposals.push({
      kind: 'audience',
      text: '沉淀了不少行业/粉丝画像事实，考虑核对并补进人设卡的「目标受众」，会诊与生成会更精准。',
      evidence: facts.slice(0, 3).map((p) => p.content).join('；'),
    });
  }
  return proposals;
}

export function memoryTypeName(type: string): string {
  return (MEMORY_TYPES as Record<string, { name: string }>)[type]?.name ?? type;
}
