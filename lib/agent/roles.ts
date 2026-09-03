// ── 系统里「能干活的东西」只有四类 ──────────────────────────────────────────
//
// 【为什么要有这个文件】2026-08-20 之前，这四类的说法散在六处各写各的：
// 智能体的定义写在 /workflows 的 PageHead，技能的写在 /skills 的 PageHead，
// 能力的写在 AgentTools.tsx 的注释里，助手的写在 AssistantTabs 的页签文案里，
// 而**模型看到的那一份**（systemPrompt）是第五份、任务台侧栏的 hint 是第六份。
// 六份互相不引用，于是用户在界面上读到的分工与 AI 实际的派活逻辑可以完全对不上——
// 而这种不一致既不会红也不会 404，只会让用户觉得「这个 AI 不听话」。
//
// 现在这里是唯一真相源：页面渲染它，systemPrompt 也拼它。改一句话，两头一起变。
//
// 【四类的分界不是「大小」，是「谁决定怎么做」】按这个维度排下来正好是一条粒度递增的线：
//   能力＝系统决定（写死的一个动作）→ 技能＝模板作者决定（一次生成）
//   → 智能体＝模板作者决定（一串步骤）→ 助手＝模型现场决定（用上面哪几样）
// 「智能体」这个名字容易让人以为它会思考，其实不会：它的步骤是写死的。
// 真正会思考的是助手。这一点必须在界面上说出来，否则用户会对智能体抱有错误期待。

export type AgentRoleKey = 'ability' | 'skill' | 'agent' | 'assistant';

export type AgentRole = {
  key: AgentRoleKey;
  /** 界面上叫什么。**术语只有这一处定义**，别的地方一律引用 */
  name: string;
  /** 一句话说清它是什么 */
  oneLine: string;
  /** 谁决定「怎么做」——四类真正的分界线 */
  decidedBy: string;
  /** 用户在哪儿看/配它。必须是 lib/nav.ts 里已有的地址（用例逐条核） */
  href: string;
  /** 什么时候该用它。**这句同时喂给模型**（见 dispatchOrderBlock） */
  when: string;
};

/**
 * 顺序即粒度：一个动作 → 一次生成 → 一串步骤 → 编排前三样。
 * 界面上按这个顺序列，模型看到的派活次序也是它的**倒序**（先看大的，再退到小的）。
 */
export const AGENT_ROLE_LIST: AgentRole[] = [
  {
    key: 'ability',
    name: '能力',
    oneLine: '一个动作：查选题、建草稿、采竞对、派浏览器任务',
    decidedBy: '系统写死（每个都带权限、确认与配额闸）',
    href: '/skills?view=abilities',
    when: '只要做一件很具体的事，或者上面几样都不合适时，用单个能力自己做',
  },
  {
    key: 'skill',
    name: '技能',
    oneLine: '一次生成：把一篇正文变成某个平台的成品',
    decidedBy: '提示词模板（你自己能改、能新建）',
    href: '/skills',
    when: '用户只要一次成品（排成公众号 / 改成小红书语气 / 拆成口播脚本），先看技能',
  },
  {
    key: 'agent',
    name: '智能体',
    // 【为什么不是「加一句『或』」】这一整份阶梯建立在「智能体不会思考、会思考的是助手」上。
    // 自主型智能体确实会思考，硬塞一个「或」进去，读的人分不清它跟助手差在哪。
    // 分界改讲成**什么时候用它**：预先设定好、可反复派、可挂定时（助手是现场听你说、当场授权）。
    oneLine: '预先设定好、可反复派的干活单位。两种：流水线（步骤定死，跑法可预期）／自主（给它目标和授权范围，自己安排怎么做）',
    decidedBy: '模板作者——要么定死步骤，要么划定授权范围',
    href: '/workflows',
    when: '这件事你会反复要（每天一篇、每周一次复盘），先看智能体：它可以挂定时，也可以一句话派',
  },
  {
    key: 'assistant',
    name: '助手',
    oneLine: '会思考的那一个：现场听你说、当场决定用上面哪几样，写操作默认逐条问你（也可在派发时一次授权）',
    decidedBy: '模型 + 你的人设与记忆',
    href: '/assistant',
    when: '就是你自己',
  },
];

export const AGENT_ROLES: Record<AgentRoleKey, AgentRole> = Object.fromEntries(
  AGENT_ROLE_LIST.map((r) => [r.key, r]),
) as Record<AgentRoleKey, AgentRole>;

/**
 * 给 systemPrompt 用的「派活次序」段落。
 *
 * 【为什么要显式教次序】光在工具清单里列出 list_agents / list_skills 是不够的——
 * 模型的默认倾向是**自己一步步做**，于是用户装好的智能体和技能全成了摆设
 *（2026-08-19 加 run_agent 时已经踩过一次，所以那一版就写了这一段）。
 *
 * 次序是粒度**从大到小**：先问「有没有现成的一整套」，再问「有没有现成的一次成品」，
 * 都没有才自己拿单个能力拼。反过来的话模型会先把活干完，再也想不起来还有智能体。
 */
export function dispatchOrderBlock(authMode: string = 'confirm_each'): string {
  const ordered = [AGENT_ROLES.agent, AGENT_ROLES.skill, AGENT_ROLES.ability];
  return [
    '这个系统里能干活的东西分三层，**从大到小依次考虑**，别一上来就自己动手：',
    ...ordered.map((r, i) => `${i + 1}. ${r.name}——${r.oneLine}。${r.when}。`),
    '现成的智能体/技能里没有合适的，或者用户明确只要其中一步，就用单个能力做，不要硬套。',
    // 【这句必须跟着这次执行的授权档走】写死「会先停下来问用户」的话，
    // 预授权的运行里模型会照着这句对用户说「这一步我会先问你」——然后直接做了。
    // 那不是提示词不准，是**让模型替我们撒谎**。
    confirmLine(authMode),
  ].join('\n');
}

function confirmLine(authMode: string): string {
  if (authMode === 'preauthorized') {
    return '这次执行用户已经**提前授权**了一批动作：授权范围内的直接做，不用再问；'
      + '不在范围内的仍会停下来等他点头。别对用户说「我会先问你」——授权过的那些你不会问。';
  }
  if (authMode === 'unattended') {
    return '这次执行**不逐步问用户**：派智能体、跑技能和别的写操作一样直接做，做完汇报。'
      + '但建发布计划、写长期记忆、配定时、拼新智能体这几样仍然会停下来等他确认——'
      + '那些影响不止这一次，不能替他签。';
  }
  return '派智能体、跑技能都会花较长时间并消耗额度，所以跟别的写操作一样，会先停下来问用户。';
}
