import { prisma } from '../../db';
import { toJson } from '../../json';
import { readPersona, type PersonaCard } from '../../persona';
import { buildAccountContext } from '../../account-context';
import { finePrompt, type Candidate } from '../scoring';

// 候选源：赛道常青储备。
//
// 【为什么必须有这一队】选题引擎此前 100% 依赖外部热度（热榜 + 竞对）。这意味着两个必然的空窗：
//   1) 新用户第一天——竞对还没订阅、账号还没数据，热榜又未必撞上他的赛道；
//   2) 没热点的日子——赛道冷清时，一个只会追热点的引擎就是停摆的引擎。
// 常青题不依赖任何外部信号，它依赖的是「这个赛道永远有人在问的问题」。
//
// 【为什么题目由模板出，不由 LLM 编】让模型「想 8 个选题」听起来更聪明，实际是把可审计的产品逻辑
// 换成了一次不可复现的即兴发挥：同样的人设两次调用给出两套题，你无法判断哪次更好，也无法在它变差时
// 定位原因。这里的模板库是**内容行业公认的常青形式**（新手误区 / 对比选择 / 答疑 / 复盘…），
// 确定性、可 review、可版本化——LLM 只负责它真正擅长的那部分：给出差异化切入角和六维评分。
//
// 【与热点队列的边界】常青题**不参与每日 topN 名额竞争**（见 queue.ts）。它是独立维护的储备池：
// 存量低于水位线才补，补一次能用很久。热点多的日子它安静待着，热点断供的日子它是唯一的产出。

// 常青形式库。{n} 会被替换成账号赛道词。
// 改这张表等于改产品供给，属于需要 review 的产品决策——所以刻意写成显式常量而不是模型即兴。
const EVERGREEN_FORMULAS: { key: string; title: (n: string) => string; why: string }[] = [
  { key: 'pitfall', title: (n) => `刚开始做${n}，最容易踩的几个坑`, why: '新人持续涌入，入门避坑类内容的搜索需求常年不衰减' },
  { key: 'compare', title: (n) => `${n}里那几个常见选择，到底该怎么挑`, why: '决策类内容有明确搜索意图，长尾流量稳定' },
  { key: 'faq', title: (n) => `关于${n}，被问得最多的问题一次讲清`, why: '评论区高频问题即真实需求，答疑内容复用率高' },
  { key: 'retro', title: (n) => `我做${n}这一路，走过的弯路和现在的做法`, why: '个人经历不可复制，是差异化最强的常青素材' },
  { key: 'counter', title: (n) => `关于${n}，大多数人其实搞反了的一件事`, why: '反常识钩子天然高完播，且不依赖时效' },
  { key: 'restart', title: (n) => `如果重新开始做${n}，我会怎么走这条路`, why: '路径类内容对新人价值密度高，易被收藏转发' },
  { key: 'toolkit', title: (n) => `做${n}我真正在用的工具和方法`, why: '工具清单是典型的收藏型内容，长期带来自然流量' },
  { key: 'standard', title: (n) => `判断${n}做得好不好，我看这几个标准`, why: '标准/判据类内容建立专业信任，利于人设沉淀' },
];

// 储备水位线：低于这个数就补货。设 3 是因为一屏能看完的储备才像「储备」，
// 攒一大堆没人看的常青题只是让列表更难读。
export const EVERGREEN_MIN_RESERVE = 3;
// 单次补货上限（也即一次补货最多打多少次精排——成本上界写死在这里，别让它悄悄长大）
export const EVERGREEN_REFILL = 4;

// 赛道词：优先用 niche，退到 identity。两个都空 → 不产出。
// 宁可这个源沉默，也不生成「刚开始做，最容易踩的几个坑」这种缺主语的废话选题。
export function nicheWord(persona: PersonaCard): string {
  const raw = (persona.niche || persona.identity || '').trim();
  return raw.length >= 2 && raw.length <= 20 ? raw : '';
}

// 纯函数：人设 → 常青候选（不含评分）。exclude 传已存在/已被拒的标题，避免反复推同一条。
export function evergreenTemplates(persona: PersonaCard, exclude: Set<string> = new Set()): Candidate[] {
  const niche = nicheWord(persona);
  if (!niche) return [];
  return EVERGREEN_FORMULAS.map((f) => ({
    title: f.title(niche),
    // 常青题没有外部热度。给 0 是**如实**：它的价值不在热度，在于零时效压力和稳定的长尾。
    // 给个假热度会让它在粗排里和真热点混着比，那才是把没数据伪装成有数据。
    heat: 0,
    sourceType: 'evergreen',
    sourceRef: f.key,
    queue: 'evergreen' as const,
    evidence: f.why,
    windowHint: '无时效压力，任何时候做都成立；适合排进产能空档',
  })).filter((c) => !exclude.has(c.title));
}

// 补货：储备低于水位线时生成若干条常青选题落库。
// 返回实际新增条数（已达水位/无赛道词/全部重复 → 0，且不发起任何 LLM 调用）。
export async function replenishEvergreen(input: {
  accountId: string;
  workspaceId: string;
  limit?: number;
}): Promise<{ created: number; reason?: string }> {
  const { accountId, workspaceId } = input;

  const account = await prisma.creatorAccount.findUnique({
    where: { id: accountId },
    select: { personaCard: true, styleFingerprint: true, workspaceId: true },
  });
  if (!account) return { created: 0, reason: '账号不存在' };

  // 已在库的常青储备（未被处理掉的）
  const reserve = await prisma.topicIdea.count({
    where: { accountId, queue: 'evergreen', state: { in: ['candidate', 'recommended'] } },
  });
  if (reserve >= EVERGREEN_MIN_RESERVE) return { created: 0, reason: `储备充足（${reserve} 条）` };

  const persona = readPersona(account.personaCard);
  if (!nicheWord(persona)) return { created: 0, reason: '人设未填赛道/身份，无法生成常青题' };

  // 排除该账号历史上出现过的同名选题：被拒过的题不该换个日子再端上来。
  const existing = await prisma.topicIdea.findMany({ where: { accountId }, select: { title: true } });
  const templates = evergreenTemplates(persona, new Set(existing.map((t) => t.title)));
  if (templates.length === 0) return { created: 0, reason: '常青题库已全部推荐过' };

  const need = Math.min(input.limit ?? EVERGREEN_REFILL, EVERGREEN_MIN_RESERVE - reserve + 1, templates.length);
  const picked = templates.slice(0, need);

  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { tenantId: true } });
  const tenantId = ws?.tenantId ?? null;

  // 与每日推荐同一套上下文口径：常青题也该按这个账号的指纹和基线来打分，
  // 而不是拿一套通用标准给所有人打一样的分。
  const ctx = await buildAccountContext({
    workspaceId,
    accountId,
    account,
    blocks: ['fingerprint', 'baseline', 'material'],
  });
  const extra = [ctx.parts.fingerprint, ctx.parts.baseline, ctx.parts.material].filter(Boolean).join('\n\n');

  // 逐条精排：条数上限已在 EVERGREEN_REFILL 写死，且补货本身低频（水位线触发），成本可控。
  // 单条失败不拖累其余——常青补货是后台维护任务，不该因为一条超时就整批不落库。
  const scored = await Promise.all(
    picked.map((c) =>
      finePrompt(tenantId, c, persona, '', extra)
        .then((s) => ({ ...s, evidence: c.evidence, windowHint: c.windowHint, queue: 'evergreen' as const }))
        .catch(() => null),
    ),
  );
  const rows = scored.filter((s): s is NonNullable<typeof s> => s !== null);
  if (rows.length === 0) return { created: 0, reason: '精排全部失败' };

  const created = (
    await prisma.topicIdea.createMany({
      data: rows.map((s) => ({
        accountId,
        title: s.title,
        angle: s.angle,
        rationale: s.rationale,
        scores: toJson(s.scores),
        totalScore: s.totalScore,
        sourceType: 'evergreen',
        sourceRef: s.sourceRef,
        queue: 'evergreen',
        evidence: s.evidence,
        windowHint: s.windowHint,
        state: 'recommended',
        mocked: s.mocked,
      })),
    })
  ).count;
  return { created };
}
