import type { WorkflowStep } from './steps';
import type { AgentConfig } from '../agent/autonomous';

// 内置工作流模板。三条现实中最常跑的流水线，装上即用。
//
// 【为什么内置的第一条不是「全自动一条龙」】把选题→初稿→技能→封面→配图→发布六步全串上，
// 一次点击就是六次付费调用，而中间任何一步不满意都得整条重来。所以内置模板刻意做小：
// 一条 3-4 步、跑完就有可用产物，用户自己想串更长的，模板市场里可以自建。

export type BuiltinWorkflow = {
  slug: string;
  name: string;
  description: string;
  emoji: string;
  category: string;
  /**
   * 职责说明：**写给模型看的**「什么时候该派我上」。
   *
   * 内置模板必须自带它。用户改不了内置模板（要改先复制成自建的），
   * 所以留空就等于「AI 永远派不了任何一个内置智能体」——开箱即用的那三条全成了摆设。
   * 写法要点：说**触发场景**（用户可能怎么开口），不要夸能力。
   */
  persona: string;
  /**
   * 跑之前得先有什么。空 = 装上就能直接跑。
   *
   * 【为什么需要它】「小红书日更三件套」的第一步是**从最高分选题写初稿**，
   * 而新账号一条选题都没有——用户装上、点「跑一遍」，第一步就撞
   * 「没有可用选题」。三条内置模板里有两条是这样。
   * 那句失败信息虽然指了路，但用户是在**花了一次点击之后**才知道的；
   * 而这件事在他点之前就该写在卡片上。
   */
  requires?: string;
  steps: WorkflowStep[];
  /** pipeline（缺省，步骤定死）| autonomous（给目标与工具白名单，自己安排怎么做） */
  mode?: 'pipeline' | 'autonomous';
  /** 只有 autonomous 用：人设补充 + 工具白名单 + 预算 + 缺省授权档（见 lib/agent/autonomous.ts） */
  agentConfig?: AgentConfig;
};


// ── 按职能分的机器人（2026-09-05，用户点名「不同职能的 bot」）──────────────────
//
// 上面三条是**流水线**（步骤定死）。职能型机器人要临场判断（采哪个号、写哪条选题、发不发），
// 所以是**自主型**：一段职责说明 + 一份工具白名单 + 预算 + 缺省授权档，没有步骤。
// 它们同时出现在四个地方：/workflows 装与跑、助手按职责说明挑（agent-pick）、群机器人绑定或
// 「换成 X」出面、定时派活。**白名单是这个 bot 的职能边界**：情报员没有 create_publish_plan，
// 发布官没有 generate_topics——绑到群里之后它真的只做自己那摊事（lib/bot/dispatch.ts 会把
// 白名单接进运行，不只是把职责说明拼进提示）。
// 【三条不进任何白名单】run_shell / write_file / run_agent：前两个是整机版的本机执行，
// 后一个会让一个 bot 派另一个 bot（嵌套只许一层，内置的不该用掉这一层）。
const ROLE_BOTS: BuiltinWorkflow[] = [
  {
    slug: 'bot-scout',
    name: '情报员',
    description: '盯竞对、采数据：采竞对主页、回填我自己的 X/TikTok 主页、读网页、看热榜、看评论区在问什么。只读，不发不改。',
    emoji: '🔭',
    category: 'role',
    persona: '要**采集或监控**时派我。用户说「采一下 / 抓一下 / 回填我的 X / 看看某某最近发了什么 / 把这个号加进监控 / 热榜有什么 / 评论区在问什么」都算。我只读不写：不建稿、不发布、不改设置。派活给浏览器执行器后我会如实说是排队还是当场跑完。',
    steps: [],
    mode: 'autonomous',
    agentConfig: {
      systemPrompt: '你是情报员，只负责把数据采回来并如实汇报。采不到就说采不到、为什么、用户该做什么；绝不编数字。不建草稿、不发布、不改任何设置。'
        + '汇报新帖/热榜/评论之前先用 mark_seen 把它们的链接或 id 过一遍，只报 fresh 的，报过的一句带过。盯哪些号、哪些话题记在台账「盯单」里（ledger_write），下次先看台账再动手。',
      tools: ['list_competitors', 'add_competitor', 'collect_competitor', 'dispatch_browser_task', 'list_browser_tasks', 'list_hot', 'clip_url', 'search_library', 'list_comments', 'work_metrics', 'list_recipes', 'mark_seen', 'ledger_read', 'ledger_write'],
      callBudget: 12,
      routines: [
        { title: '每天早上盯一遍竞对与热榜', goal: '把监控中的竞对主页和热榜过一遍，只报昨天以来新出现的、值得看的条目（先用 mark_seen 去重），每条带链接和一句为什么值得看；没有新东西就一句话说明。', atHour: 8 },
      ],
    },
  },
  {
    slug: 'bot-topic',
    name: '选题官',
    description: '从热榜、竞对爆款、评论区问题和你的人设里挑今天该写什么，给出理由与切入角。',
    emoji: '💡',
    category: 'role',
    persona: '要**定选题**时派我。用户说「今天写什么 / 给我几条选题 / 这个热点能不能蹭 / 哪条更值得做」都算。我给的是选题与理由，不动手写稿——写稿找「写手」。',
    steps: [],
    mode: 'autonomous',
    agentConfig: {
      systemPrompt: '你是选题官。先看已有选题与热榜，再结合人设与爆款基因给建议；每条选题都要带理由和切入角。不写正文、不出图、不发布。'
        + '推荐前把热榜条目过一遍 mark_seen，昨天推过的今天不再推；用户否掉的方向记在台账「不做的方向」里，以后绕开。',
      tools: ['generate_topics', 'list_topics', 'list_hot', 'genes_summary', 'algorithm_hint', 'run_advisor', 'read_persona_memory', 'search_library', 'list_comments', 'mark_seen', 'ledger_read', 'ledger_write'],
      callBudget: 12,
      routines: [
        { title: '每天早上给三条选题', goal: '结合今天的热榜、竞对爆款和我的人设，给 3 条今天值得写的选题，每条带理由与切入角；昨天推过的不再推。', atHour: 9 },
      ],
    },
  },
  {
    slug: 'bot-writer',
    name: '写手',
    description: '按选题和人设写初稿、改稿、套平台技能（公众号排版 / 小红书语气 / 口播脚本），写完过一遍合规。',
    emoji: '✍️',
    category: 'role',
    persona: '要**写或改稿**时派我。用户说「写一篇 / 改成小红书的语气 / 拆成口播 / 第二段太平了换个说法 / 帮我改标题」都算。我只产出稿子，不发布、不出图、不选题（没选题就让用户先找「选题官」）。',
    requires: '要有一条可用选题或一句明确的题目',
    steps: [],
    mode: 'autonomous',
    agentConfig: {
      systemPrompt: '你是写手。按用户人设与记忆写，写完自己过一遍合规检查再交。改稿时保留用户原句风格，不要整段重写。不发布、不出图。',
      tools: ['create_draft', 'read_draft', 'list_drafts', 'list_topics', 'run_skill', 'list_skills', 'read_persona_memory', 'search_library', 'list_materials', 'compliance_check'],
      callBudget: 16,
      skills: [
        { slug: 'wechat-format', when: '用户要发公众号、要排版、要「改成公众号那种」时' },
        { slug: 'xhs-format', when: '用户要发小红书、要小红书语气或排版、要「像小红书那样」时' },
        { slug: 'douyin-script', when: '用户要口播稿、抖音脚本、「拆成口播」时' },
        { slug: 'shipinhao-script', when: '用户要视频号脚本时' },
        { slug: 'zhihu-format', when: '用户要发知乎、要长文排版时' },
      ],
    },
  },
  {
    slug: 'bot-designer',
    name: '出图师',
    description: '给稿子出封面与配图：按平台尺寸、按你的形象与风格库来，公众号成对出。',
    emoji: '🎨',
    category: 'role',
    persona: '要**出图**时派我。用户说「出张封面 / 配几张图 / 换个风格 / 公众号头图」都算。我只出图，不写稿、不发布。',
    requires: '要有一篇草稿，或一句明确的画面描述',
    steps: [],
    mode: 'autonomous',
    agentConfig: {
      systemPrompt: '你是出图师。先读稿子和用户的形象/风格库再出图；平台尺寸按规矩来（小红书 3:4，公众号头图+次图成对）。不写稿、不发布。',
      tools: ['generate_image', 'list_drafts', 'read_draft', 'list_materials', 'read_persona_memory'],
      callBudget: 8,
    },
  },
  {
    slug: 'bot-publisher',
    name: '发布官',
    description: '把定稿排进发布计划、定时、看已排的计划——建计划这一步会停下来等你点头。',
    emoji: '🚀',
    category: 'role',
    persona: '要**安排发布**时派我。用户说「排个发布 / 明早八点发 / 看看排了哪些 / 这篇定了发出去」都算。我会先过合规再建计划；**建发布计划一定停下来等用户确认**，不替用户点发。',
    requires: '要有一篇定稿',
    steps: [],
    mode: 'autonomous',
    agentConfig: {
      systemPrompt: '你是发布官。发之前必须先 compliance_check；建发布计划前把平台、时间、稿子说清楚再建。真正发出去永远由用户自己点。',
      tools: ['list_drafts', 'read_draft', 'compliance_check', 'create_publish_plan', 'list_publish_plans', 'draft_schedule', 'list_schedules'],
      callBudget: 10,
      defaultAuthMode: 'confirm_each',
    },
  },
  {
    slug: 'bot-analyst',
    name: '复盘官',
    description: '看数据、找规律：哪条好哪条差、为什么、下次怎么改；能把结论记进长期记忆。',
    emoji: '📈',
    category: 'role',
    persona: '要**看数据、复盘**时派我。用户说「最近数据怎么样 / 哪条表现最差为什么 / 给我周复盘 / 记住这个结论」都算。我只分析和记录，不采集（找「情报员」）、不写稿。',
    steps: [],
    mode: 'autonomous',
    agentConfig: {
      systemPrompt: '你是复盘官。结论要落到具体作品和数字上；没有数据就说没有，不要编。值得长期记住的规律用 write_memory 记下，写清依据。'
        + '每次复盘完把「复盘到哪天、上次的主要结论」记进台账（ledger_write），下次从那里接着看，不重复上次说过的话。',
      tools: ['account_performance', 'work_metrics', 'genes_summary', 'algorithm_hint', 'list_comments', 'run_advisor', 'search_past_runs', 'write_memory', 'read_persona_memory', 'ledger_read', 'ledger_write'],
      callBudget: 12,
      routines: [
        { title: '每周一复盘上周', goal: '复盘上周发布的所有作品：哪条好哪条差、为什么、这周怎么改；对比台账里上次的结论说说有没有变化。', atHour: 9, weekdays: [1] },
      ],
    },
  },
  {
    slug: 'bot-compliance',
    name: '合规官',
    description: '发之前过一遍：广告法、平台红线、敏感词、事实漂移；只给结论和改法，不改稿。',
    emoji: '🛡️',
    category: 'role',
    persona: '要**查合规**时派我。用户说「这篇能不能发 / 有没有踩红线 / 帮我看看敏感词」都算。我只检查、给改法，不动稿子、不发布。',
    requires: '要有一篇草稿',
    steps: [],
    mode: 'autonomous',
    agentConfig: {
      systemPrompt: '你是合规官。逐条指出问题在哪一句、违反了什么、建议怎么改；能发就明确说能发。不改稿、不发布。',
      tools: ['compliance_check', 'read_draft', 'list_drafts', 'list_publish_plans', 'search_library'],
      callBudget: 8,
    },
  },
];

export const ROLE_BOT_SLUGS = ROLE_BOTS.map((b) => b.slug);

export const BUILTIN_WORKFLOWS: BuiltinWorkflow[] = [
  {
    slug: 'daily-xhs',
    name: '小红书日更三件套',
    description: '从最高分选题写初稿 → 小红书风格改写 → 出封面。跑完就有一篇能发的笔记。',
    persona: '要发小红书笔记时派我。用户说「今天的小红书」「写篇小红书」「日更一条」都算。我会挑分最高的选题起稿、按小红书的调性改写、再出一张 3:4 封面。**要求先有一条可用选题**——没有的话让用户先跑一轮选题推荐，或改派「选题 → 图文组图」。',
    requires: '先得有一条可用选题（去「选题引擎」跑一轮推荐或采纳一条）。没有的话用「选题 → 图文组图」，那条自己会先跑选题。',
    emoji: '📕',
    category: 'daily',
    steps: [
      { kind: 'draft', platform: 'xiaohongshu' },
      // slug 必须是**真实存在的内置技能**（prisma/system-data.ts 的 BUILTIN_SKILLS）。
      // 这里曾经写成 'xhs-note'——库里根本没有这条，于是内置的第一条模板第二步
      // 每次都停在「找不到技能」，而模板本身看起来一切正常。
      // tests/workflow/market.test.ts 有守卫逐条核对，别再凭印象写 slug。
      { kind: 'skill', slug: 'xhs-format' },
      { kind: 'cover', specKey: 'xhs-3-4' },
    ],
  },
  {
    slug: 'wechat-longform',
    name: '公众号长文流水线',
    description: '写初稿 → 公众号排版 → 出头图，然后建一份公众号发布计划（发不发你自己决定）。',
    persona: '要出公众号长文时派我。用户说「写篇公众号」「长文」「推文准备一下」都算。我会起稿、按公众号排版、出头图，最后建好发布计划——真正发出去仍然要用户自己点。**要求先有一条可用选题**。',
    requires: '先得有一条可用选题（去「选题引擎」跑一轮推荐或采纳一条）。没有的话用「选题 → 图文组图」，那条自己会先跑选题。',
    emoji: '📰',
    category: 'daily',
    steps: [
      { kind: 'draft', platform: 'wechat' },
      { kind: 'skill', slug: 'wechat-format' },
      { kind: 'cover', specKey: 'wechat-235-1' },
      { kind: 'publish', platforms: ['wechat'] },
    ],
  },
  {
    slug: 'topic-to-carousel',
    name: '选题 → 图文组图',
    description: '先跑一轮选题推荐，再按最高分那条写稿，最后拆出一组风格统一的配图。',
    persona: '没想好写什么、要连选题一起搞定时派我。用户说「不知道写啥」「来一组图文」「帮我从头做一条」都算。我会先跑一轮选题推荐再起稿配图。',
    emoji: '🖼️',
    category: 'weekly',
    steps: [
      { kind: 'topic', count: 6 },
      { kind: 'draft', platform: 'xiaohongshu' },
      { kind: 'illustration', count: 4 },
    ],
  },
  ...ROLE_BOTS,
];
