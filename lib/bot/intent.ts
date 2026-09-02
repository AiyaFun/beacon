import { prisma } from '../db';
import { llmComplete } from '../llm/gateway';
import { parseJson } from '../json';
import { looksActionable, wantsExecution } from '../agent/intent';

// 自然语言 → 指令意图（需求④增强）。
//
// 群里没人愿意背斜杠命令，「今天有什么热点」应该和 /热点 等价。
// 但这里有个必须守住的默认值：**拿不准就当选题收录**——那是原有行为，
// 也是唯一无副作用的兜底（只进候选池，不发布、不改配置）。
//
// 三层，越靠前越确定：
//   ① 斜杠命令      —— 调用方处理，不进这里
//   ② 确定性短语匹配 —— 免费、瞬时、可预测，只认高置信度的完整问法
//   ③ LLM 分类      —— 兜住剩下的自由表达；降级/Mock 时不信它，退回收录

export type Intent =
  | { cmd: 'help' }
  | { cmd: 'hot' }
  | { cmd: 'topic'; arg: string }
  | { cmd: 'crawl'; arg: string }
  | { cmd: 'optimize' }
  | { cmd: 'analyze'; arg: string } // 账号体检（arg=账号名，可空=本群当前账号）
  | { cmd: 'chat' } // 自由对话（原文即问题）
  // ── 2026-09-02 加的四种（用户真机反馈：「给我今天的选题」被听成了「查看帮助」）──
  | { cmd: 'brief' } // 今日选题晨报（本群账号的最新一轮推荐）
  | { cmd: 'competitor'; arg: string } // 看监控中的竞对近期高热作品（arg=名字，可空=全部）
  | { cmd: 'run' } // 让 AI 执行器**真去做**这句话说的事（等价 /执行 原文）
  | { cmd: 'agent'; arg: string } // 看/切换本会话的智能体（arg=名字，可空=列出）
  | { cmd: 'ingest' }; // 默认：当作选题候选收录

// ── ② 确定性短语 ──
// 刻意只匹配「明显在对机器人说话」的问法，不做裸关键词匹配：
// 「秋季穿搭热点盘点」是个好选题，不该因为含「热点」二字就被当成查热榜。
const PHRASES: { re: RegExp; intent: Intent }[] = [
  { re: /^(帮助|help|你能(做什么|干嘛|干什么)|怎么用|有(什么|哪些)(功能|指令|命令))[?？。!！]*$/i, intent: { cmd: 'help' } },
  { re: /^(今天|最近|现在)?(看看|查看|查(一下|下)?|来点|给我来?点?|有(什么|啥)?)?(热点|热榜|热搜)(吗|呢|有哪些|是什么|榜)?[?？。!！]*$/, intent: { cmd: 'hot' } },
  { re: /^(跑|做|来|触发|执行)?(一次|下)?(记忆)?优化[一下]*[?？。!！]*$/, intent: { cmd: 'optimize' } },
  // 账号体检：只认「对着账号本身提要求」的说法。含「账号/号」二字是硬条件——
  // 「分析一下这个选题」不该被劫持成体检。
  {
    re: /^(帮我|帮忙|给我)?(分析|诊断|体检|看看|看下|复盘|评估)(一下|下)?(我的|我们的|本群|当前)?(账号|号)(数据|情况|表现)?(怎么样|如何|好不好)?[?？。!！]*$/,
    intent: { cmd: 'analyze', arg: '' },
  },
  {
    re: /^(我的|我们的|当前)?(账号|号)(最近|近期|这周|这个月)?(数据|表现|情况)?(怎么样|如何|好不好|有什么问题)[?？。!！]*$/,
    intent: { cmd: 'analyze', arg: '' },
  },
  // 今日选题晨报：「给我今天的选题」「今日选题」「晨报」「今天推荐什么」。
  // 这句话此前被 LLM 归成 help（真机 2026-09-02），而它恰恰是机器人最该秒回的一句。
  {
    re: /^(帮我|给我|来|看看|查看|看下|看一下|发|推|说说)?(一下|下|点)?(今天|今日|本日|当天)的?(选题|推荐|晨报|选题推荐|推荐选题)(有哪些|有什么|是什么|吧|呢)?[?？。!！]*$/,
    intent: { cmd: 'brief' },
  },
  { re: /^(晨报|今日晨报|选题晨报|今日选题|今天的选题|今天推荐什么|今天做什么选题|今天写什么)[?？。!！]*$/, intent: { cmd: 'brief' } },
  // 竞对动态：「看看竞对」「对手最近怎么样」。必须含「竞对/对手/竞品」；「竞品分析怎么做」是问法论，不匹配（有「怎么」）。
  {
    re: /^(帮我|给我|看看|查看|看下|看一下)?(一下|下)?(监控中的|监控的)?(竞对|对手|竞品|对标)(们)?(最近|近期|这周)?(有什么|的)?(作品|动态|表现|爆款|新动作)?(如何|怎样)?[?？。!！]*$/,
    intent: { cmd: 'competitor', arg: '' },
  },
  // 智能体：「有哪些智能体」「切换智能体」→ 列出；具体切到谁在 router 里按名字查（见 matchAgentSwitch）
  { re: /^(智能体|智能体列表|有哪些智能体|你有哪些智能体|都有什么智能体|切换智能体|换个智能体|换一个智能体|当前智能体|现在是哪个智能体)[?？。!！]*$/, intent: { cmd: 'agent', arg: '' } },
];

/**
 * 「换成 X」「切换到 X 智能体」「用 X 来」→ 候选名字。**只给出候选**，不在这里判真伪：
 * router 拿名字去已装智能体里查，查不到就当这句话不是在切换（照常往下走），
 * 免得「用 3 个字概括」这种句子被劫持。
 */
const AGENT_SWITCH = /^(?:请)?(?:切换到|切换成|切到|换成|换到|换到|改用|改成|用|使用|让|叫)\s*[「『"“]?(.{1,30}?)[」』"”]?\s*(?:这个)?(?:智能体)?(?:来|出面|接手|回答|来回答|上)?[。!！]*$/;
export function matchAgentSwitch(text: string): string | null {
  const m = AGENT_SWITCH.exec(text.trim());
  if (!m) return null;
  const name = m[1].trim();
  return name.length >= 2 ? name : null;
}

export function matchPhrase(text: string): Intent | null {
  const t = text.trim();
  for (const { re, intent } of PHRASES) if (re.test(t)) return intent;
  return null;
}

// ── ②′ 确定性「这是在跟我说话」判定 ──
//
// 群里 @机器人 说的话，多数时候是在问它，而不是在丢选题。但这两者只差一个语气，
// 判错的代价不对称：把问题当选题收录，用户只是白等一句回执；把选题当问题聊，
// 他丢进来的灵感就丢了。所以这里只认**含人称的求助句式**——
//   「我这条为什么没火？」→ 对话（有「我」+ 疑问词）
//   「为什么年轻人不买房了」→ 不匹配，交给 LLM（这更像一个好标题）
// 剩下的模糊地带一律往下走 LLM 分类，LLM 也拿不准就还是收录（无副作用兜底）。
const ASK_OPENERS = /^(帮我|帮忙|请问|问[一下下]|想问|你(觉得|认为|怎么看|会怎么|能不能|可以|建议|说说|讲讲)|您(觉得|认为|怎么看))/;
const FIRST_PERSON = /(^|[^\p{L}])(我|我们|咱们|咱|俺|本号|这个号)/u;
const QUESTION_WORD = /(怎么|为什么|为啥|如何|该不该|要不要|能不能|可不可以|值不值|好不好|行不行|哪个|哪些|多少|是不是|有没有|吗[?？]?$|呢[?？]?$)/;

export function looksLikeChat(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (ASK_OPENERS.test(t)) return true;
  return FIRST_PERSON.test(t) && (QUESTION_WORD.test(t) || /[?？]$/.test(t));
}

// ── ③ LLM 分类 ──
const SYSTEM = `你是内容运营助手的指令路由器。把用户在群里说的一句话，判断成下面某一个操作：

- hot：想看当前热榜/热点榜单
- topic：想把某个想法/关键词收录成选题候选（arg=选题标题）
- crawl：想采集/监控某个竞争对手账号（arg=对方主页链接或账号名）
- optimize：想触发一次记忆学习优化/复盘
- analyze：想让助手分析/体检自己的账号数据与内容表现（arg=账号名，没提到就留空）
- chat：在向助手提问、请教、要建议，或就某个话题跟它讨论（原话就是问题本身）
- brief：想看今天的选题推荐/晨报（「今天做什么」「今日选题」）
- competitor：想看监控中的竞争对手最近的作品/动态（arg=对手名字，没提到就留空）
- run：让助手**去做**一件具体的事——写一篇、生成几条、采一遍、整理、盯着、排一下……
  说的是「做」不是「问」（「帮我写一篇秋季穿搭笔记」「把这三个号采一遍」「整理一下本周数据」）
- agent：想看有哪些智能体、或想切换到某个智能体（arg=名字，没提到就留空）
- help：想知道机器人能做什么
- ingest：以上都不是——这句话本身就是一条内容素材/选题灵感

判断要点：
1. 用户在「向助手提要求」才算 hot/topic/crawl/optimize/analyze/help；
   用户在「问助手一个问题、要一段建议」是 chat；
   用户只是「抛出一个内容点子」就是 ingest。
2. chat 与 ingest 的分界看有没有在问：「短视频开头怎么写才留得住人？」是 chat；
   「短视频开头的三种写法」是 ingest（这是个选题）。
3. analyze 与 chat 的分界看对象：矛头指向「我的账号/数据/最近表现」是 analyze；
   泛泛的方法论问题是 chat。
4. run 与 chat 的分界看动词：「帮我写一篇」是 run；「这篇该怎么写」是 chat。
   run 与 topic 的分界看有没有动作：「秋季穿搭」「记一下：秋季穿搭」是 topic/ingest；「写一篇秋季穿搭」是 run。
5. 拿不准一律选 ingest。ingest 无副作用，选错代价最小。
6. 只输出 JSON：{"cmd":"hot|topic|crawl|optimize|analyze|chat|brief|competitor|run|agent|help|ingest","arg":"","confidence":0.0}
   arg 只有 topic/crawl/analyze/competitor/agent 需要；confidence 是 0~1 的把握程度。`;

const VALID = new Set(['hot', 'topic', 'crawl', 'optimize', 'analyze', 'chat', 'brief', 'competitor', 'run', 'agent', 'help', 'ingest']);

/**
 * 自然语言 → 意图。
 * 兜底口径：任何不确定（LLM 不可用、降级成 Mock、置信度低、格式不对）都返回 ingest，
 * 也就是保持这个功能上线前的老行为。宁可少认一次，不可乱执行一次。
 */
export type ClassifyOptions = {
  /**
   * 这个群开了「派任务」吗。开了，像「帮我写一篇…」「把这三个号采一遍」这种**让它去做**的句子
   * 直接判成 run（等价 /执行 原文）；没开就不判 run——判了也执行不了，还不如让对话或收录接住。
   * 判据复用站内助手那两个纯函数（lib/agent/intent.ts），两边对「什么算派活」的口径一致。
   */
  canRun?: boolean;
};

export async function classifyIntent(workspaceId: string, text: string, opts: ClassifyOptions = {}): Promise<Intent> {
  const phrase = matchPhrase(text);
  if (phrase) return phrase;
  // 让它去做的句子 → 直接派给执行器。排在「对话」判定之前：「帮我写一篇…」既有「帮我」也有动作词，
  // 用户要的是那篇稿子落在草稿箱里，不是一段 250 字的建议（2026-09-02 用户原话：希望通过自然语言直接执行任务）。
  if (opts.canRun && (wantsExecution(text) || looksActionable(text))) return { cmd: 'run' };
  // 含人称的求助句式 → 直接对话。放在 LLM 之前，是为了让「AI 分类器降级时」这条路仍然通：
  // 群里问一句话得到的是回答，而不是被默默收录成一条选题。
  if (looksLikeChat(text)) return { cmd: 'chat' };

  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { tenantId: true } });
  if (!ws) return { cmd: 'ingest' };

  let res;
  try {
    res = await llmComplete(ws.tenantId, 'scoring', [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: text.slice(0, 500) },
    ], { json: true, temperature: 0 });
  } catch {
    return { cmd: 'ingest' }; // 配额超限等 —— 不该因为意图识别把收录功能也弄挂
  }

  // Mock / 降级结果不可信：它不是真的在理解这句话，照着执行会误触发命令
  if (res.mocked || res.degraded) return { cmd: 'ingest' };

  const parsed = parseJson<{ cmd?: string; arg?: string; confidence?: number }>(res.text, {});
  const cmd = String(parsed.cmd ?? '');
  if (!VALID.has(cmd)) return { cmd: 'ingest' };
  if ((parsed.confidence ?? 0) < 0.6) return { cmd: 'ingest' };

  const arg = String(parsed.arg ?? '').trim();
  if (cmd === 'topic') return arg ? { cmd: 'topic', arg } : { cmd: 'ingest' };
  if (cmd === 'crawl') return arg ? { cmd: 'crawl', arg } : { cmd: 'ingest' };
  if (cmd === 'analyze') return { cmd: 'analyze', arg }; // arg 可空=本群当前账号
  if (cmd === 'chat') return { cmd: 'chat' };
  if (cmd === 'brief') return { cmd: 'brief' };
  if (cmd === 'competitor') return { cmd: 'competitor', arg };
  // 派任务没开的群，LLM 说 run 也不算数：退成对话让它至少答一句（router 里会附上怎么开）
  if (cmd === 'run') return opts.canRun ? { cmd: 'run' } : { cmd: 'chat' };
  if (cmd === 'agent') return { cmd: 'agent', arg };
  if (cmd === 'hot') return { cmd: 'hot' };
  if (cmd === 'optimize') return { cmd: 'optimize' };
  if (cmd === 'help') return { cmd: 'help' };
  return { cmd: 'ingest' };
}
