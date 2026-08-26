import { prisma } from '@/lib/db';
import type { RunStatus } from './badge';
import { platformName } from '@/lib/constants';
import { TASK_STATUS_LABEL } from '@/lib/publish/capability';
import { KIND_LABEL as BROWSER_KIND_LABEL } from '@/lib/browser-task/kinds';

// ── 运行中心：把「我现在有什么在跑 / 有什么在等我」收成一处 ──────────────────
//
// 【为什么要有】此前系统里有五类会跑起来的东西，各自散在不同页面：
//   · AI 执行器 AgentRun ——**一个页面都没有**，只在 lib/agent/run.ts 写库。
//     用户根本看不到 AI 替他调过哪些工具、改过什么，这是「写了没接」的老形状。
//   · 工作流模板 WorkflowRun → 只在 /workflows 页尾列最近 8 条
//   · 采集台账 CollectionRun → 埋在 /data 里
//   · 发布任务 PublishTask  → 只在 /publish
//   · 定时任务 JobRun       → /settings 与 /ops
// 于是「有没有什么在等我处理」这个问题，用户要翻四个页面才能回答。
//
// 【JobRun 刻意不收】它没有 workspaceId（只有可选 tenantId），track 是
// broadcast / batch_tenant——那是**平台替所有租户跑**的定时作业，不是这个用户发起的。
// 混进来会让用户以为是自己的任务，而且他既停不掉也重跑不了。它在「运行设置」里
// 以「上次跑成功没」的形态呈现，那才是用户对它唯一该关心的事。
//
// 【刻意不按 accountId 过滤】/data 与 /publish 都按当前账号过滤，这一页**不**。
// 理由是这一页回答的是「有什么在跑」——跨账号的也必须看得见，否则就是
// 「回填成功但看板空白」那个坑的翻版：任务明明在跑，切错账号就以为没跑。
// 代价是必须**每条都标明归属账号**，这个在下面用 accountName 兜住。

// 五类原始状态归一后的统一状态（waiting = 系统跑完了它那部分，**在等人**）与那枚徽章的算法，
// 都定义在 ./badge —— 那个文件零依赖，客户端组件也能 import 而不会把 prisma 打进浏览器包。
// 这里 re-export，几十处调用点一个都不用改。
export { activeBadge } from './badge';
export type { RunStatus } from './badge';

export type RunKind = 'agent' | 'workflow' | 'collect' | 'publish' | 'browser';

export type RunEntry = {
  id: string;
  kind: RunKind;
  /** 一句话说清这是在跑什么（用户那句话 / 模板名 / 采了谁 / 发哪篇） */
  title: string;
  status: RunStatus;
  /** 排序用：这条记录最近一次有动静的时刻 */
  at: Date;
  /** 副标题：跑到第几步、收了多少条、为什么失败 */
  detail?: string;
  /** 点进去看详情的页面 */
  href: string;
  /** 属于哪个创作账号。跨账号可见的前提是每条都标明归属。 */
  accountName?: string;
  /**
   * 谁发起的。**只有 AI 执行有**（那是唯一「只有发起人能推进」的一类）。
   *
   * 【为什么要带上它】这一页是工作区级的，同事的运行你也看得见——这是刻意的
   * （见「刻意不按 accountId 过滤」那条）。但「等你确认」只有发起人点得动：
   * 把同事的运行也印成第二人称「等你处理」，等于叫他去点一个必定报错的按钮。
   */
  memberId?: string;
  /** 发起人的名字。同事的那条要说清是在等谁，而不是含糊地「等你」。 */
  memberName?: string;
  /**
   * AI 执行的步骤明细。这是**唯一**能看到「AI 替我调了哪些工具」的地方——
   * 此前 AgentStep 写了库但没有任何页面读它。展开就地看，不跳转：
   * 跳到 /assistant 只会到一个看不见这次运行的页面（指路指到空页面）。
   */
  steps?: RunStep[];
};

/** 一步 AI 执行。只收「做了什么」那几类，tool_result 太长且对用户无意义。 */
export type RunStep = { seq: number; kind: string; tool: string; ok: boolean; result: string };

/** 步骤结果只用来给人扫一眼，超长就截断——整段塞进页面既拖慢渲染也没人读。 */
export const STEP_RESULT_MAX = 160;

/**
 * 工作流是谁跑起来的。`manual` 不给标签——页面手点是默认路径，
 * 每条都印一个「手动」只是噪音；要区分的是**另外两条不是你当场点的**。
 */
export const TRIGGER_LABEL: Record<string, string> = {
  schedule: '定时触发',
  agent: 'AI 派的',
};

export const KIND_LABEL: Record<RunKind, string> = {
  agent: 'AI 执行',
  workflow: '工作流',
  collect: '采集',
  publish: '发布',
  browser: '浏览器任务',
};

export const STATUS_LABEL: Record<RunStatus, string> = {
  running: '进行中',
  waiting: '等你处理',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

// ── 状态归一 ────────────────────────────────────────────────────────────────
// 四类表各有各的 status 取值，这里收敛成同一套。**纯函数，用例直接测**——
// 归一表写错不会红也不会 404，只会让用户在「等你处理」里看不到真在等他的那条。

/** AgentRun: running | awaiting_confirm | waiting_browser | waiting_quota | done | failed | cancelled */
export function agentStatus(s: string): RunStatus {
  // awaiting_confirm = 模型要做写操作、停下来等用户点确认 —— 这正是最该被看见的一类
  if (s === 'awaiting_confirm') return 'waiting';
  // waiting_browser = 派了活给插件、停下来等它。归 waiting 而不是 running 的理由与
  // 浏览器任务的 pending 一样：**没有任何机器在推进它**，它在等那台浏览器打开。
  // 归成 running 会让用户以为等着就行，而实际上不打开浏览器它永远不动。
  if (s === 'waiting_browser') return 'waiting';
  // waiting_quota = 今日额度用尽，等北京时间 0 点重置。**归 running 而不是 waiting**——
  // 这一桶的语义是「在等人」（STATUS_LABEL 写着「等你处理」），而这里用户什么也做不了、
  // 也不用做：到点了定时会自己把它接着跑。摆进「等你处理」是叫人去做一件根本不存在的事。
  // 到底在等什么由 detail 说清楚。
  if (s === 'waiting_quota') return 'running';
  // queued = 同时在跑的满了，在排队等前面的让位。同样是**机器在等**，用户不用做任何事。
  if (s === 'queued') return 'running';
  if (s === 'running' || s === 'done' || s === 'failed' || s === 'cancelled') return s;
  return 'running';
}

/**
 * 一条 AI 执行的一句话现状。**在等什么必须说出来**：
 * 只写「已执行 N 步」的话，用户看到的是一条停着不动的任务，既不知道卡在哪，
 * 也不知道该不该做点什么——而这两种等待里，一种要他去开浏览器，另一种他什么都不用做。
 */
export function agentDetail(r: { status: string; steps: number; error: string | null }): string {
  if (r.status === 'waiting_quota') {
    // 额度这条**不把 error 摆出来**：库里存的是配额那句长文案（含升级引导），
    // 摆在列表行里既挤又像报错，而这次运行并没有失败。
    return `已执行 ${r.steps} 步，今日 AI 额度用完了，北京时间 0 点重置后自动接着跑`;
  }
  // 排队中的一步都还没跑，说「已执行 0 步」等于什么都没说
  if (r.status === 'queued') return '在排队，等前面的任务跑完就自动开始';
  if (r.error) return r.error;
  if (r.status === 'waiting_browser') return `已执行 ${r.steps} 步，在等你的浏览器插件把活干完`;
  return `已执行 ${r.steps} 步`;
}

/** WorkflowRun: running | done | failed | cancelled */
export function workflowStatus(s: string): RunStatus {
  if (s === 'running' || s === 'done' || s === 'failed' || s === 'cancelled') return s;
  return 'running';
}

/**
 * PublishTask: pending | ready | filled | submitted | published | failed | skipped
 *
 * 中间那四个都是 waiting 而不是 running，因为**没有任何机器在推进它们**：
 * ready/filled 等用户去平台点发布，submitted 等用户在公众号后台群发，pending 等插件接手。
 * 归成 running 会让用户以为「等着就行」，实际上不点它永远不动。
 */
export function publishStatus(s: string): RunStatus {
  if (s === 'published') return 'done';
  if (s === 'failed') return 'failed';
  if (s === 'skipped') return 'cancelled';
  return 'waiting';
}

/**
 * BrowserTask: pending | claimed | done | failed | expired | cancelled
 *
 * `pending` 归 **waiting** 而不是 running：没有任何机器在推进它——
 * 它在等用户的浏览器打开。这跟发布任务那四个中间态是同一个道理。
 * `expired` 归 cancelled：「没做」不是「做失败」，用户该做的事不一样
 *（前者是「把插件打开」，后者是「看看为什么采不到」）。
 */
export function browserTaskStatus(s: string): RunStatus {
  if (s === 'done') return 'done';
  if (s === 'failed') return 'failed';
  if (s === 'expired' || s === 'cancelled') return 'cancelled';
  if (s === 'claimed') return 'running';
  return 'waiting';
}

/**
 * CollectionRun 没有 status 字段：它是**已完成批次**的台账（空批不记，见 lib/ingest/collection-run.ts）。
 * 所以一律 done；note 非空表示有降级/节流，作为 detail 显示出来，不改状态——
 * 「采到了但少采了」不是失败，标成 failed 会让用户以为数据没进来。
 */
export const collectStatus = (): RunStatus => 'done';

/** 采集批次的一句话结果：收了多少、其中新增多少。 */
export function collectDetail(r: { items: number; created: number; updated: number; note: string | null }): string {
  const base = `收到 ${r.items} 条（新增 ${r.created} · 更新 ${r.updated}）`;
  return r.note ? `${base} · ${r.note}` : base;
}

/** 「等你处理」优先，然后按时间倒序。同状态内新的在前。 */
export function sortRuns(rows: RunEntry[]): RunEntry[] {
  const rank: Record<RunStatus, number> = { waiting: 0, running: 1, failed: 2, done: 3, cancelled: 4 };
  return [...rows].sort((a, b) => rank[a.status] - rank[b.status] || b.at.getTime() - a.at.getTime());
}

// ── 查询 ────────────────────────────────────────────────────────────────────

export type ListRunsOpts = {
  /** 每一类各取多少条（默认 20）。四类分别取再合并，避免某一类刷屏把别的挤没。 */
  takePerKind?: number;
};

export async function listRuns(workspaceId: string, opts: ListRunsOpts = {}): Promise<RunEntry[]> {
  const take = opts.takePerKind ?? 20;

  const [agents, workflows, collects, plans, accounts, browserTasks] = await Promise.all([
    prisma.agentRun.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
      take,
      select: {
        id: true, goal: true, status: true, error: true, steps: true, updatedAt: true, accountId: true,
        // memberId：这一页是工作区级的，同事的运行也在列。而「等你确认」只有发起人点得动，
        // 界面要据此把第二人称收回去（否则同事看到的是一个点了必定报错的按钮）
        memberId: true,
        agentSteps: {
          // 只要「做了什么」：tool_call 是调了哪个工具，rejected 是用户拒了哪次写操作，error 是哪一步炸的。
          // tool_result 不收——它是工具返回的原始数据，动辄几 KB，对用户没有阅读价值。
          where: { kind: { in: ['tool_call', 'rejected', 'error'] } },
          orderBy: { seq: 'asc' as const },
          take: 12,
          select: { seq: true, kind: true, tool: true, ok: true, result: true },
        },
      },
    }),
    prisma.workflowRun.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
      take,
      select: {
        id: true, status: true, stepIndex: true, error: true, updatedAt: true, accountId: true, trigger: true,
        template: { select: { name: true, emoji: true } },
      },
    }),
    prisma.collectionRun.findMany({
      where: { workspaceId },
      orderBy: { ranAt: 'desc' },
      take,
      select: {
        id: true, scope: true, platform: true, targetName: true, channel: true,
        ranAt: true, items: true, created: true, updated: true, note: true,
      },
    }),
    // 发布任务挂在 PublishPlan 下，workspaceId 在 plan 上——必须 join 才拿得到，
    // 直接查 PublishTask 会把别的工作区的任务也捞进来。
    prisma.publishPlan.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
      take,
      select: {
        accountId: true,
        tasks: {
          select: { id: true, platform: true, status: true, title: true, error: true, updatedAt: true },
          orderBy: { updatedAt: 'desc' },
        },
      },
    }),
    prisma.creatorAccount.findMany({ where: { workspaceId }, select: { id: true, name: true } }),
    prisma.browserTask.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
      take,
      select: { id: true, kind: true, status: true, result: true, error: true, updatedAt: true, accountId: true, origin: true },
    }),
  ]);

  const nameOf = new Map(accounts.map((a) => [a.id, a.name]));
  // 发起人的名字：同事那条要说清是在等谁。只查这一批运行涉及到的人，不拉全量成员表。
  const memberIds = [...new Set(agents.map((r) => r.memberId).filter(Boolean))];
  const members = memberIds.length
    ? await prisma.member.findMany({ where: { id: { in: memberIds } }, select: { id: true, name: true } })
    : [];
  const memberNameOf = new Map(members.map((m) => [m.id, m.name]));

  const rows: RunEntry[] = [
    ...agents.map((r) => ({
      id: r.id,
      kind: 'agent' as const,
      title: r.goal,
      status: agentStatus(r.status),
      at: r.updatedAt,
      // 「等浏览器」要说清楚在等谁：只写「已执行 N 步」的话，用户看到的是一条
      // 停着不动的任务，既不知道卡在哪，也不知道该做什么（答案是：把浏览器打开）
      detail: agentDetail(r),
      // 【必须带上 runId】此前这里是光秃秃的 '/assistant'，而助手页只有本地 state、
      // 看不见任何一次已存在的运行——一条停在「等你确认」的执行，用户点「去 AI 助手」
      // 落到一个空白输入框，那次执行就永远确认不了（刷新一次浏览器也是同样的下场）。
      // 这是「指路指到空页面」的最坏形态：不 404、页面也正常，事情却永远做不完。
      // query 不是新路由（同一页同一份数据），助手页据此把那次运行读回来。
      href: `/assistant?run=${r.id}`,
      accountName: r.accountId ? nameOf.get(r.accountId) : undefined,
      memberId: r.memberId,
      memberName: memberNameOf.get(r.memberId),
      steps: r.agentSteps.map((st) => ({
        seq: st.seq,
        kind: st.kind,
        tool: st.tool,
        ok: st.ok,
        result: st.result.length > STEP_RESULT_MAX ? `${st.result.slice(0, STEP_RESULT_MAX)}…` : st.result,
      })),
    })),
    ...workflows.map((r) => ({
      id: r.id,
      kind: 'workflow' as const,
      // 模板被删了也要有个能读的标题（那条运行记录本身仍然有价值）
      title: r.template ? `${r.template.emoji} ${r.template.name}` : '（这个智能体已经被删了）',
      status: workflowStatus(r.status),
      at: r.updatedAt,
      // 来源要写在脸上：定时跑失败意味着「那条计划可能正在连续失败、快被自动停用」，
      // 手点失败只是这一次的事——同一个红字，用户该做的事完全不同
      detail: [TRIGGER_LABEL[r.trigger] ?? null, r.error ?? `跑到第 ${r.stepIndex + 1} 步`]
        .filter(Boolean)
        .join(' · '),
      // 落到运行中心而不是 /workflows：后者是「有哪些模板」，看不到**这一次**跑了什么。
      // 用户 2026-08-26 反馈「最近的内容都是没有效果的」——点 6 条不同的行，
      // 全都落在同一个模板列表页上，确实等于没反应。
      href: '/runs',
      accountName: nameOf.get(r.accountId),
    })),
    ...collects.map((r) => ({
      id: r.id,
      kind: 'collect' as const,
      title: `${platformName(r.platform)} · ${r.targetName}`,
      status: collectStatus(),
      at: r.ranAt,
      detail: collectDetail(r),
      // 竞对的采集结果在竞对监控页，自有的在数据看板——指错地方等于指路指到空页面
      href: r.scope === 'rival' ? '/competitors' : '/data',
      accountName: r.scope === 'rival' ? undefined : r.targetName,
    })),
    ...plans.flatMap((p) =>
      p.tasks.map((t) => ({
        id: t.id,
        kind: 'publish' as const,
        title: `${t.title} → ${platformName(t.platform)}`,
        status: publishStatus(t.status),
        at: t.updatedAt,
        detail: t.error ?? TASK_STATUS_LABEL[t.status] ?? t.status,
        href: '/publish',
        accountName: nameOf.get(p.accountId),
      })),
    ),
    ...browserTasks.map((r) => ({
      id: r.id,
      kind: 'browser' as const,
      title: BROWSER_KIND_LABEL[r.kind as keyof typeof BROWSER_KIND_LABEL] ?? r.kind,
      status: browserTaskStatus(r.status),
      at: r.updatedAt,
      // pending 时要说清「在等什么」——用户看到「等你处理」却不知道自己该干嘛最糟
      detail: [
        r.origin === 'agent' ? 'AI 派的' : r.origin === 'schedule' ? '定时派的' : null,
        r.status === 'pending' ? '等你的浏览器打开插件' : null,
        r.result ?? r.error ?? null,
      ]
        .filter(Boolean)
        .join(' · '),
      // 落运行中心，不落插件页：用户 2026-08-26 问「为什么点最近是跳到插件里去呢」。
      // 浏览器任务是「有什么在跑」，跟「怎么装扩展」是两件事；而 /runs 本来就收这一类，
      // 还带取消按钮（app/(app)/runs/page.tsx 的 kind==='browser' 分支）。
      href: '/runs',
      accountName: r.accountId ? nameOf.get(r.accountId) : undefined,
    })),
  ];

  return sortRuns(rows);
}

/** 顶部四个计数格。 */
export function countByStatus(rows: RunEntry[]): Record<RunStatus, number> {
  const out: Record<RunStatus, number> = { running: 0, waiting: 0, done: 0, failed: 0, cancelled: 0 };
  for (const r of rows) out[r.status] += 1;
  return out;
}
