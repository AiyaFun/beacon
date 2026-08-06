import { llmComplete } from '../llm/gateway';
import { stripMemoryTags } from '../memory/core';
import { parseJson } from '../json';
import { personaPromptBlock, type PersonaCard } from '../persona';
import { timeDecayFactor } from '../hot/lifecycle';
// queue.ts 从本文件只取 Candidate **类型**（type-only，编译后擦除），故这里正常 import 值不构成运行时循环。
import { resolveQueue, type TopicQueue } from './queue';
import { saturationCenter } from './bluesea';

// 两阶段选题打分（PRD §6 F4）：
// 阶段一 特征粗排（免费、规则）：热度 × 人设关键词匹配 × 竞争饱和度 × 时效衰减，快速筛候选。
// 阶段二 LLM 精排（对 top N 才调用，控成本）：输出差异化切入角 + 六维评分。

export type Candidate = {
  title: string;
  heat: number; // 归一化 0-1
  sourceType: string;
  sourceRef?: string;
  lifecycle?: string;
  firstSeenAt?: Date;
  platform?: string; // 真实平台（热榜 = 榜单源，竞对 = 作品平台）；用于主战平台亲和度加权
  // ── 以下三个字段由延伸候选源（lib/topic/sources/）产出，热榜/竞对候选不填 ──
  // 时间队列归属；不填则由 queue.ts 按 lifecycle 推断（热榜 rising/peak → today，其余 → week）
  queue?: TopicQueue;
  // 「为什么是你 / 为什么是现在」的事实证据。**必须是查库查出来的事实**（你哪条旧作、
  // 哪个平台几点上的榜），不是模型编的话术——它会原样进精排 prompt 并落库给用户看，
  // 编造的证据比没有证据更糟。
  evidence?: string;
  // 时间窗口人话提示，如「微博已上榜 6 小时，抖音尚未出现 · 抢跑窗口约 30 小时」
  windowHint?: string;
  // 蓝海度 0-1（P2，lib/topic/bluesea.ts）：需求代理已验证 × 供给还空着。
  // 拿不到热榜时间线的候选（竞对/自搬运/常青/日历）没有这个值，缺席即 0。
  blueSea?: number;
};

export type ScoredTopic = {
  title: string;
  angle: string;
  rationale: string;
  scores: {
    traffic: number;
    personaFit: number;
    cost: number;
    monetization: number;
    compliance: number;
    differentiation: number;
  };
  totalScore: number;
  sourceType: string;
  sourceRef?: string;
  // 模型判定这条热点确实能跟本账号接上（而不是硬凑）。false → 不进「今日推荐」，
  // 退到候选区留痕（见 pipeline.ts）。字段缺席按 true 处理，保持老模型/老回包的行为不变。
  relevant: boolean;
  mocked: boolean; // 精排是否由 Mock LLM 产生（与 HotItem.isMock 同约定，落库到 TopicIdea.mocked）
  // mocked 的成因：true=接了真模型但这次调用失败/超时被兜底；false=压根没接真模型。
  // 两者在界面上是完全不同的两句话，也决定「重试」按不按得动（落库到 TopicIdea.degraded）。
  llmDegraded: boolean;
  // 候选源产出的事实字段，原样透传落库（不经 LLM 改写：它们是查库查出来的证据，模型无权改）
  queue: TopicQueue;
  evidence?: string;
  windowHint?: string;
  blueSea?: number;
};

// 文本 → 中文 2-gram 指纹（中文无词边界，整词 includes 命中率低，用二字切片更稳）。
// 人设匹配与竞争饱和度（saturation.ts）共用这一把尺子，保证「相关」的判定口径一致。
export function textShingles(text: string): Set<string> {
  const cleaned = text.replace(/[\s、,，。/·|]+/g, '').toLowerCase();
  const shingles = new Set<string>();
  for (let i = 0; i < cleaned.length - 1; i++) shingles.add(cleaned.slice(i, i + 2));
  return shingles;
}

// 从人设文本抽取指纹
export function personaShingles(persona: PersonaCard): Set<string> {
  const source = [
    persona.niche,
    persona.identity,
    persona.valueProp,
    ...(persona.canDo ?? []),
  ]
    .filter(Boolean)
    .join('');
  return textShingles(source);
}

// 标题对人设指纹的匹配分（0-1，命中指纹数 cap 3）——粗排与探索位选取共用
export function titleMatchScore(title: string, shingles: Set<string>): number {
  const t = title.toLowerCase();
  let match = 0;
  for (const sh of shingles) if (t.includes(sh)) match++;
  return Math.min(match / 3, 1);
}

// 主战平台亲和度加成上限（加权而非过滤：只温和上抬本平台原生候选，绝不压过强热点跨平台趋势）。
// 刻意小于热度权重(0.30)：一条外平台强热点仍能压过一条本平台弱选题——热点是跨平台的，不该被埋。
const PLATFORM_AFFINITY_BONUS = 0.08;

// 候选是否命中账号主战平台（缺 platform 或人设未填平台时恒 0，即退化为原公式，保证既有行为不变）
function platformAffinity(candidate: Candidate, persona: PersonaCard): number {
  if (!candidate.platform) return 0;
  return (persona.platforms ?? []).includes(candidate.platform) ? 1 : 0;
}

// 阶段一：粗排打分（热度 × 人设匹配 × 竞争饱和度倒U × 时效衰减 + 主战平台亲和度）。
// semantic（P2-5）：标题与人设的语义相似度（0-1），只在配了**真** embedding key 时才有值。
// 与词形分取 max 而不是替换——「只加不减」：语义只负责捞回「AI绘画 vs 生成式艺术」这类同义漏配，
// 绝不因为模型没读懂而把词形明确命中的候选压下去。这是权重 0.40 的最大因子，改错影响面大，
// 所以词形分永远是地板。
// demand（P2 蓝海度）：站内可观测的需求代理信号（在榜时长 × 跨平台扩散，见 bluesea.ts）。
// 它**不新增权重项**，只把竞争饱和度倒U的最优点往「低供给」方向推：
// 倒U惩罚低饱和的理由是「没人做可能是因为没流量」，而一旦需求被独立验证，这个理由就不成立了。
// 缺省空表 → 中心恒为 0.5，公式与接入前逐字相同。
export function coarseRank(
  candidates: Candidate[],
  persona: PersonaCard,
  saturation: Record<string, number> = {},
  semantic: Record<string, number> = {},
  demand: Record<string, number> = {},
): Candidate[] {
  const shingles = personaShingles(persona);
  const scored = candidates.map((c) => {
    const sat = saturation[c.title] ?? 0;
    const satFactor = 1 - Math.abs(sat - saturationCenter(demand[c.title] ?? 0)) * 0.6;
    const timeFactor = c.lifecycle && c.firstSeenAt
      ? timeDecayFactor({ lifecycle: c.lifecycle, firstSeenAt: c.firstSeenAt, source: c.sourceType })
      : 1;
    const fit = Math.max(titleMatchScore(c.title, shingles), semantic[c.title] ?? 0);
    const coarse =
      c.heat * 0.30 +
      fit * 0.40 +
      satFactor * 0.15 +
      timeFactor * 0.15 +
      platformAffinity(c, persona) * PLATFORM_AFFINITY_BONUS;
    return { c, coarse };
  });
  return scored.sort((a, b) => b.coarse - a.coarse).map((s) => s.c);
}

// 精排重试的超时预算（首次用 provider 默认 30s）。见 finePrompt 里那段说明。
const RETRY_TIMEOUT_MS = 15_000;

// 阶段二：LLM 精排（对 topN 逐条打分）。
// tenantId 必传：精排是「租户主动生成推荐」烧的钱，必须落到该租户头上走配额与成本归属；
// 传 null 等于把这笔账记到平台自己名下、还绕过配额——那是只有全局广播型任务才允许的姿势。
// extraContext：账号的风格指纹 + 真实数据基线（被数据验证的擅长切入角、各平台真实流量水平）。
// 传空则退化为原「人设 + 记忆」两块，保证既有行为不变。这让 learn.ts 沉淀的「验证过的切入角」
// 与账号真实流量终于进入每日推荐主链路——traffic/personaFit 打分从空谈变有据。
export async function finePrompt(
  tenantId: string | null,
  candidate: Candidate,
  persona: PersonaCard,
  memory: string,
  extraContext = '',
): Promise<ScoredTopic> {
  // 候选源查库查出来的事实（你哪条旧作跑赢过、话题在哪个平台几点上的榜）。
  // 它和人设/记忆的区别是**这条选题专属**，所以放在 user 消息里贴着选题走，而不是混进 system 背景块。
  const evidenceBlock = [
    candidate.evidence ? `已知事实（来自账号历史数据/热榜时间线/读者评论，不是推测）：${candidate.evidence}` : '',
    candidate.windowHint ? `时间窗口：${candidate.windowHint}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const messages = [
    {
      role: 'system' as const,
      content: [
        '你是资深内容选题策划。请对给定热点/选题，结合账号人设、风格指纹、真实数据基线与记忆，输出一个"差异化切入角"和六维评分(0-100)。',
        '差异化切入角是强制字段：必须给出一个避开同质化红海的独特角度。',
        // ⚠️ 上面那条「强制给角度」单独存在时有个恶果：模型对**任何**题都会硬造一座桥。
        // 真机 2026-07-30，一个「家庭理财与保险避坑」账号收到的推荐里有：
        //   「唐朝不存在？伪史论歪风一定要刹住」→ 切入角「从保险与理财角度探讨伪史论对家庭资产规划的长远影响」，人设匹配 85
        //   「中共中央召开党外人士座谈会」    → 切入角「解读对普通家庭理财和民生政策的影响」，人设匹配 90
        // 高热度的时政条目靠 heat 权重挤进精排，再被这条指令逼出一个拉郎配的角度和虚高的
        // personaFit。用户看到这种推荐，丢掉的是对整个推荐系统的信任——比少推一条贵得多。
        // 所以必须给模型一条**体面的退出通道**，并明说「拒绝是正确答案」。
        '但在给角度之前先判定关联度：如果这条热点跟这个账号只能靠**硬凑**才联系得上',
        '（要绕两层才扯到账号的领域，或者只能泛泛谈"对普通人的启示"），就把 relevant 设为 false。',
        'relevant=false 是被鼓励的正确答案，不是失败——宁可这一轮少推一条，也不要为了凑数编一个牵强的切入角。',
        'relevant=false 时其余字段照常填（格式要完整），并在 rationale 里一句话说明为什么不适合这个账号。',
        '评分要参考账号真实数据基线：若该方向贴近账号已被数据验证的擅长切入角，personaFit/traffic 应相应上调；反之保守。',
        'personaFit 要如实反映「这条跟这个账号有多贴」——不要因为你已经想出了一个角度就把它调高。',
        // 这条指令**只在真有证据时才注入**。实测（接真实模型）：无条件写进 system prompt 后，
        // 模型会在根本没给证据的候选上自己编一段「已知事实：……」——把它的推测包装成数据背书，
        // 正是本项目最不能出的那类错。没有证据时，这句话必须整条消失。
        // 条件挂在 candidate.evidence 上，不是挂在 evidenceBlock 上——
        // 后者只有时间窗口时也非空，那时并没有任何「事实」可供引用。
        candidate.evidence
          ? '用户消息里给出的「已知事实」来自账号历史数据、热榜时间线与读者评论，必须在 rationale 里引用它来解释评分，不得无视；也不得编造事实里没有的数据。'
          : '',
        personaPromptBlock(persona),
        extraContext,
        memory,
        '严格输出 JSON：{"relevant":true,"angle":"...","scores":{"traffic":0,"personaFit":0,"cost":0,"monetization":0,"compliance":0,"differentiation":0},"rationale":"..."}',
      ].filter(Boolean).join('\n\n'),
    },
    { role: 'user' as const, content: [`选题：${candidate.title}`, evidenceBlock].filter(Boolean).join('\n') },
  ];
  let res = await llmComplete(tenantId, 'scoring', messages, { json: true, temperature: 0.5 });
  // 超时重试一次，但给一个**更紧的预算**。
  // 第一次已经等掉 30s 了，重试再给 30s 等于把最坏墙钟翻倍——真机 2026-07-30 实测 60.6s，
  // 那已经是「用户以为页面卡死」的量级。正常一次精排约 5-8s，15s 是 2 倍余量，
  // 够接住绝大多数瞬时抖动；真赶上供应商持续慢，第二次也救不回来，不该让所有人陪等。
  // 最坏墙钟因此收敛到 30+15=45s。
  // res.degraded=true 表示「真 provider 失败，被 Mock 兜底」（真机那次 6 条里 3 条超时）。
  // 不重试的代价是**永久**的：那条选题的六维分从此就是编的，用户没有任何补救入口。
  //
  // 只在 degraded 时重试，不在 mocked 时重试：没配 Key 的环境每条都会 mocked=true，
  // 那里重试纯属把每次生成的耗时翻倍且必然拿到同样的 Mock 结果。
  // 精排是 Promise.all 并发的，所以重试只加一个来回的墙钟，不是 N 个。
  if (res.degraded) {
    const retry = await llmComplete(tenantId, 'scoring', messages, { json: true, temperature: 0.5, timeoutMs: RETRY_TIMEOUT_MS })
      .catch(() => null); // 重试本身再炸就认了，用第一次的降级结果，别把整条生成拖挂
    if (retry && !retry.degraded) res = retry;
  }
  const parsed = parseJson<Partial<ScoredTopic>>(res.text, {});
  // AI 没给出可用评分 → 回退默认分。默认分只是占位，不能装成真判断：rationale 里明说
  const degraded = !parsed.scores;
  const scores = {
    traffic: 60,
    personaFit: 60,
    cost: 55,
    monetization: 50,
    compliance: 75,
    differentiation: 55,
    ...(parsed.scores ?? {}),
  };
  const total = Math.round(
    scores.traffic * 0.25 +
      scores.personaFit * 0.25 +
      scores.differentiation * 0.2 +
      scores.monetization * 0.15 +
      scores.compliance * 0.1 +
      scores.cost * 0.05,
  );
  return {
    title: candidate.title,
    angle: parsed.angle ?? '差异化切入角（待补充）',
    // stripMemoryTags：模型会把记忆行的 `[人设记忆 · 今天]` 标注原样抄进理由（真机 6 条中 5 条），
    // prompt 三轮加码都没治住，只能在出口确定性地洗掉（见 lib/memory/core.ts 那段注释）。
    rationale: stripMemoryTags(parsed.rationale ?? '') + (degraded ? '（默认分：AI 返回异常，本条排序参考性低）' : ''),
    scores,
    totalScore: total,
    sourceType: candidate.sourceType,
    sourceRef: candidate.sourceRef,
    // 缺席即 true：Mock provider 和任何不认识这个字段的模型都照旧走原路径，
    // 只有模型**明确说 false** 才判定为硬凑。
    relevant: parsed.relevant !== false,
    mocked: res.mocked,
    llmDegraded: !!res.degraded,
    queue: resolveQueue(candidate),
    evidence: candidate.evidence,
    windowHint: candidate.windowHint,
    blueSea: candidate.blueSea,
  };
}

// 完整管线：粗排 → 取 topN → 精排 → 按总分排序。
// saturation 由 pipeline 从近 72h 竞对作品算出（见 saturation.ts），不传视为全 0（新账号无竞对数据）。
export async function runScoring(
  tenantId: string | null,
  candidates: Candidate[],
  persona: PersonaCard,
  memory: string,
  topN = 8,
  saturation: Record<string, number> = {},
  extraContext = '',
  semantic: Record<string, number> = {},
  demand: Record<string, number> = {},
): Promise<ScoredTopic[]> {
  const ranked = coarseRank(candidates, persona, saturation, semantic, demand).slice(0, topN);
  const scored = await Promise.all(ranked.map((c) => finePrompt(tenantId, c, persona, memory, extraContext)));
  return scored.sort((a, b) => b.totalScore - a.totalScore);
}
