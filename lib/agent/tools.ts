import { prisma } from '../db';
import { parseJson, toJson, type Metrics } from '../json';
import { can, type Action as RbacAction } from '../rbac';
import { platformName } from '../constants';
import { parseCompetitorUrl } from '../competitor-url';
import { generateRecommendations, crawlOneCompetitor } from '../pipeline';
import { runWorkflow, createWorkflowRun } from '../workflow/run';
import { isAutonomous, parseAgentConfig } from './autonomous';
import { kickWorkflowRun } from '../workflow/kick';
import { workflowWaitToken } from './wake';
import { listTemplates } from '../workflow/market';
import { listInstalledSkills, runSkill, skillPlatformName } from '../skills';
import { persistDraftVersion } from '../studio/draft-core';
import { parseWeekdays } from '../workflow/schedule';
import { scheduleWhen, scheduleTargetLabel } from '../workflow/schedule-format';
import { enqueueBrowserTask, hasCollector, KIND_LABEL as BROWSER_KIND_LABEL } from '../browser-task';
import { browserWaitToken } from './wake';
import { isReadAllowed, readAllowlistLabels } from '../browser-task/read-allowlist';
import { fmtDate } from '../format';
import type { ToolDef } from '../llm/types';
import { INSIGHT_TOOLS } from './tools-insight';
import { CONTENT_TOOLS } from './tools-content';
import { PRODUCE_TOOLS } from './tools-produce';
import { PLANNING_TOOLS } from './tools-draft-plan';

// ── AI 能调用的系统能力清单 ────────────────────────────────────────────────
//
// 【边界，先说死】这里注册的**就是** AI 能做的全部事情。没注册的它做不了，
// 也不存在「让 AI 写段代码执行一下」的通道——那等于把任意代码执行挂在对话框里。
// 想让 AI 会一件新事，唯一的路是在这张表里加一个工具（于是它天然带着权限、审计、确认）。
//
// 【每个工具三个必答问题】
//   ① 它要哪个 RBAC 动作？—— 按**发起人**的角色判，不是按工作区里权限最大的人判；
//   ② 它是不是写操作？—— 写操作一律先停下来问用户（lib/agent/run.ts 的确认闸）；
//   ③ 它花不花钱？—— costly=true 的即使是「读」也要确认（模型调用/生图都是真金白银）。
//
// 【返回值给谁看】工具返回的是**给模型看的结构化摘要**，不是给人看的界面文案。
// 所以要短、要有 id（模型下一步可能要用）、要如实说「没有」而不是编一个空壳。

export type ToolContext = {
  /**
   * 这次执行的 id。**产物登记与嵌套判定都靠它**。
   *
   * 可空是因为工具也会被别的地方直接调（页面上的按钮、定时任务）——
   * 那些场景没有「一次 AI 执行」这个上下文，产物自然也不必挂到谁头上。
   */
  runId?: string;
  tenantId: string;
  workspaceId: string;
  accountId: string;
  memberId: string;
  role: string;
};

export type ToolResult = {
  ok: boolean;
  data?: unknown;
  error?: string;
  summary: string;
  /**
   * 这一步做完之后，把整次运行**停下来等一件外部的事**，格式 `<类型>:<id>`
   *（目前只有 `browser:<BrowserTask.id>`，见 lib/agent/wake.ts）。
   *
   * 只有「结果要等别人给」的工具才该填它。填了就意味着：这一轮不再往下推理，
   * 那件事有结局（成功/失败/过期/取消）时才继续——所以**必须保证有人会来叫醒**，
   * 否则就是一次永远醒不来的运行。
   */
  waitFor?: string;
  /**
   * 这一步做出了什么东西（草稿、版本、图、发布计划…）。
   *
   * 【为什么要工具自己报，而不是执行器去猜】只有工具知道自己刚写了哪一行：
   * create_draft 知道新草稿的 id，run_skill 知道存成了第几版。
   * 执行器那边看到的只是一段 JSON summary，从里面反解 id 是猜——猜错了
   * 用户点过去会打开别人的东西。
   */
  artifacts?: { kind: ArtifactKind; refId: string; label: string }[];
};

/** 产物的种类。加新种类时记得让界面知道它该跳到哪一页（lib/agent/artifacts.ts）。 */
export type ArtifactKind =
  | 'draft'
  | 'draft_version'
  | 'topic'
  | 'image'
  | 'publish_plan'
  | 'schedule'
  | 'browser_task';

export type AgentTool = {
  name: string;
  /** 给人看的中文名（确认弹层与步骤列表用） */
  label: string;
  def: ToolDef;
  action: RbacAction;
  /** 会改变系统状态吗 */
  write: boolean;
  /** 会花钱吗（模型调用 / 生图 / 采集配额）。写操作与花钱操作都要确认。 */
  costly?: boolean;
  /**
   * 这一步是**替用户签一份以后会自己生效的东西**吗。
   *
   * 建发布计划、写进长期记忆、配一条定时、拼一个新智能体——它们的共同点是
   * **影响不止于这一次执行**：定时会在他睡着时按时花钱，记忆会改变以后每一次生成，
   * 发布计划摆在那儿等着被发出去。
   *
   * 【为什么用标记而不是写死一张工具名清单】清单会漏。新加一个「配点什么」的工具时，
   * 作者会记得填 write（不填连基本的确认都没有，测试会红），却很难想起去另一个文件里
   * 的排除表补一行——而漏掉的后果是无人值守时它被静默执行。
   * 标记跟着工具定义走，加工具时就在眼前。
   *
   * 效果：**无人值守下照样停下来问人**（机制级，不看提示词也不看授权档）；
   * 预授权的派发卡上**缺省不勾**（用户可以主动勾，那是他知情的选择）。
   */
  contract?: boolean;
  /**
   * 这一步最多等多久（毫秒）。不填走 DEFAULT_TOOL_TIMEOUT_MS。
   *
   * 【填的时候想什么】它不是「预期耗时」，是「超过这个数就该认为外面卡住了」。
   * 因为超时**掐不断**已经跑起来的活（JS 做不到），只是不再等——填小了的代价是
   * 模型收到一次假的失败，而那件事还在后台继续。宁可给足。
   */
  timeoutMs?: number;
  run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;
};

/** 没单独声明时的等待上限：查数据库、调一次模型都远在这个数以内。 */
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

export function toolTimeoutMs(tool: AgentTool): number {
  return tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v.trim() : fallback);
const num = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// ── 读工具 ──────────────────────────────────────────────────────────────────

const listTopics: AgentTool = {
  name: 'list_topics',
  label: '查选题',
  action: 'content.view',
  write: false,
  def: {
    name: 'list_topics',
    description: '列出当前账号的选题（按总分从高到低）。用于回答「我今天写什么」「有哪些推荐选题」。',
    parameters: {
      type: 'object',
      properties: {
        state: { type: 'string', description: '选题状态过滤：candidate/recommended/accepted/rejected/drafting/published。不传=全部' },
        limit: { type: 'number', description: '最多返回几条，默认 10，上限 30' },
      },
    },
  },
  async run(ctx, args) {
    const limit = clamp(num(args.limit, 10), 1, 30);
    const state = str(args.state);
    const rows = await prisma.topicIdea.findMany({
      where: { accountId: ctx.accountId, ...(state ? { state } : {}) },
      orderBy: { totalScore: 'desc' },
      take: limit,
      select: { id: true, title: true, angle: true, totalScore: true, state: true, queue: true, mocked: true },
    });
    return {
      ok: true,
      data: rows,
      summary: rows.length ? `${rows.length} 条选题` : '这个账号还没有选题',
    };
  },
};

const listDrafts: AgentTool = {
  name: 'list_drafts',
  label: '查草稿',
  action: 'content.view',
  write: false,
  def: {
    name: 'list_drafts',
    description: '列出当前账号的草稿。返回 id / 标题 / 平台 / 状态，id 可用于 read_draft。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'editing/checking/ready/published/abandoned，不传=全部' },
        limit: { type: 'number', description: '默认 10，上限 30' },
      },
    },
  },
  async run(ctx, args) {
    const limit = clamp(num(args.limit, 10), 1, 30);
    const status = str(args.status);
    const rows = await prisma.draft.findMany({
      where: { accountId: ctx.accountId, ...(status ? { status } : {}) },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      select: { id: true, title: true, platform: true, status: true, updatedAt: true },
    });
    return { ok: true, data: rows, summary: rows.length ? `${rows.length} 篇草稿` : '还没有草稿' };
  },
};

const readDraft: AgentTool = {
  name: 'read_draft',
  label: '读草稿正文',
  action: 'content.view',
  write: false,
  def: {
    name: 'read_draft',
    description: '读取一篇草稿的最新版本正文。先用 list_drafts 拿 id。',
    parameters: {
      type: 'object',
      properties: { draftId: { type: 'string', description: '草稿 id' } },
      required: ['draftId'],
    },
  },
  async run(ctx, args) {
    const draftId = str(args.draftId);
    // 归属校验绝不能省：模型可能把别处看到的 id 直接拿来用（它并不知道那是别人的）。
    const draft = await prisma.draft.findFirst({
      where: { id: draftId, account: { workspaceId: ctx.workspaceId } },
      include: { versions: { orderBy: { seq: 'desc' }, take: 1 } },
    });
    if (!draft) return { ok: false, error: '草稿不存在或不属于当前工作区', summary: '没找到这篇草稿' };
    const latest = draft.versions[0];
    return {
      ok: true,
      data: {
        id: draft.id,
        title: draft.title,
        platform: draft.platform,
        status: draft.status,
        content: latest?.content?.slice(0, 4000) ?? '',
        hasContent: !!latest,
      },
      summary: latest ? `《${draft.title}》正文 ${latest.content.length} 字` : `《${draft.title}》还没有正文`,
    };
  },
};

const listHot: AgentTool = {
  name: 'list_hot',
  label: '查热榜',
  action: 'content.view',
  write: false,
  def: {
    name: 'list_hot',
    description: '查看各平台实时热榜条目。用于「现在有什么热点」。返回条目会标出是否为示例数据。',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: '来源平台：douyin/weibo/bilibili/zhihu/baidu/toutiao/x/youtube/xiaohongshu。不传=全部' },
        limit: { type: 'number', description: '默认 10，上限 30' },
      },
    },
  },
  async run(_ctx, args) {
    const limit = clamp(num(args.limit, 10), 1, 30);
    const source = str(args.source);
    const rows = await prisma.hotItem.findMany({
      where: source ? { source } : {},
      orderBy: [{ fetchedAt: 'desc' }, { rank: 'asc' }],
      take: limit,
      select: { title: true, source: true, rank: true, heat: true, lifecycle: true, isMock: true },
    });
    // isMock 必须原样带给模型：不标的话它会把示例数据当真热点写进建议里。
    return {
      ok: true,
      data: rows,
      summary: rows.length ? `${rows.length} 条热榜${rows.some((r) => r.isMock) ? '（含示例数据）' : ''}` : '当前没有热榜数据',
    };
  },
};

const listCompetitors: AgentTool = {
  name: 'list_competitors',
  label: '查对标账号',
  action: 'content.view',
  write: false,
  def: {
    name: 'list_competitors',
    description: '列出本工作区正在监控的对标（竞对）账号。',
    parameters: { type: 'object', properties: { limit: { type: 'number', description: '默认 20，上限 50' } } },
  },
  async run(ctx, args) {
    const limit = clamp(num(args.limit, 20), 1, 50);
    const rows = await prisma.watchlistItem.findMany({
      where: { workspaceId: ctx.workspaceId },
      take: limit,
      orderBy: { addedAt: 'desc' },
      include: { competitor: { select: { id: true, name: true, platform: true, handle: true, followers: true } } },
    });
    return {
      ok: true,
      data: rows.map((r) => ({ ...r.competitor, platformName: platformName(r.competitor.platform) })),
      summary: rows.length ? `${rows.length} 个对标账号` : '还没有添加对标账号',
    };
  },
};

// ── 写工具（一律要用户确认）──────────────────────────────────────────────────

const createDraft: AgentTool = {
  name: 'create_draft',
  label: '新建草稿',
  action: 'content.create',
  write: true,
  def: {
    name: 'create_draft',
    description: '创建一篇草稿。如果提供 content 就一并写入第一版正文（会标记为 AI 生成）。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '标题' },
        platform: { type: 'string', description: '目标平台：douyin/xiaohongshu/wechat/bilibili/x/youtube/tiktok/shipinhao' },
        content: { type: 'string', description: '正文（可选）' },
      },
      required: ['title', 'platform'],
    },
  },
  async run(ctx, args) {
    const title = str(args.title).slice(0, 60);
    const platform = str(args.platform, 'douyin');
    const content = str(args.content);
    if (!title) return { ok: false, error: '标题是空的', summary: '没建成：标题为空' };

    const draft = await prisma.draft.create({
      data: { accountId: ctx.accountId, title, platform, status: 'editing' },
    });
    if (content) {
      // authorType 记 ai：记错会污染「AI 初稿 vs 人工终稿」的偏好学习（与 studio 同口径）
      await prisma.draftVersion.create({
        data: { draftId: draft.id, seq: 1, authorType: 'ai', content, diffFromPrev: 'AI 助手按你的要求创建' },
      });
    }
    return {
      ok: true,
      data: { draftId: draft.id },
      summary: `已创建草稿《${title}》`,
      artifacts: [{ kind: 'draft' as const, refId: draft.id, label: `新建草稿《${title}》` }],
    };
  },
};

const addCompetitor: AgentTool = {
  name: 'add_competitor',
  label: '添加对标账号',
  action: 'competitor.manage',
  write: true,
  def: {
    name: 'add_competitor',
    description: '把一个对标账号加入监控列表。需要该账号的主页链接。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '对标账号主页链接' },
        label: { type: 'string', description: '备注（可选）' },
      },
      required: ['url'],
    },
  },
  async run(ctx, args) {
    const url = str(args.url);
    const parsed = parseCompetitorUrl(url);
    // 认不出就报错，绝不猜：猜错平台/handle 会去采**别人的**账号，比「没加上」严重得多。
    if (!parsed) return { ok: false, error: '这个链接认不出是哪个平台的哪个账号', summary: '链接无法识别，没有添加' };

    const competitor = await prisma.competitorAccount.upsert({
      where: { platform_handle: { platform: parsed.platform, handle: parsed.handle } },
      create: { platform: parsed.platform, handle: parsed.handle, name: parsed.handle },
      update: {},
    });
    await prisma.watchlistItem.upsert({
      where: { workspaceId_competitorId: { workspaceId: ctx.workspaceId, competitorId: competitor.id } },
      create: { workspaceId: ctx.workspaceId, competitorId: competitor.id, label: str(args.label) || null },
      update: {},
    });
    return {
      ok: true,
      data: { competitorId: competitor.id, platform: parsed.platform, handle: parsed.handle },
      summary: `已监控 ${platformName(parsed.platform)} 的 ${parsed.handle}`,
    };
  },
};

const collectCompetitor: AgentTool = {
  name: 'collect_competitor',
  label: '采集对标账号',
  action: 'competitor.manage',
  write: true,
  costly: true,
  // 服务端去平台抓一轮，网络慢的时候几分钟都正常
  timeoutMs: 5 * 60_000,
  def: {
    name: 'collect_competitor',
    description: '立即抓取一个对标账号的最新公开作品数据。先用 list_competitors 拿 id。',
    parameters: {
      type: 'object',
      properties: { competitorId: { type: 'string', description: '对标账号 id' } },
      required: ['competitorId'],
    },
  },
  async run(ctx, args) {
    const competitorId = str(args.competitorId);
    const watched = await prisma.watchlistItem.findFirst({ where: { workspaceId: ctx.workspaceId, competitorId } });
    if (!watched) return { ok: false, error: '这个对标账号不在本工作区的监控列表里', summary: '没采：不在监控列表' };
    const r = await crawlOneCompetitor(competitorId, { workspaceId: ctx.workspaceId, channel: 'manual' });
    return {
      ok: true,
      data: r,
      summary: r.posts > 0 ? `采到 ${r.posts} 条作品${r.degraded ? '（数据源降级）' : ''}` : '这次没采到新作品',
    };
  },
};

const generateTopics: AgentTool = {
  name: 'generate_topics',
  label: '生成选题推荐',
  action: 'topic.manage',
  write: true,
  costly: true,
  // 一轮选题推荐 = 采集 + 打分 + 多次模型调用
  timeoutMs: 5 * 60_000,
  def: {
    name: 'generate_topics',
    description: '按账号人设与当前热点，跑一轮选题推荐（会调用 AI，消耗额度）。',
    parameters: { type: 'object', properties: { count: { type: 'number', description: '要几条，默认 6，上限 12' } } },
  },
  async run(ctx, args) {
    const topN = clamp(num(args.count, 6), 1, 12);
    const r = await generateRecommendations(ctx.accountId, ctx.workspaceId, topN);
    return { ok: true, data: r, summary: `生成了 ${r.created} 条选题推荐` };
  },
};

// ── 派活给浏览器 ───────────────────────────────────────────────────────────
//
// 有些事**服务端做不了**：进创作后台看自己的完播率、在竞对主页把作品翻到底，
// 都要用户已登录的浏览器。这两个工具让 AI 在发现「我需要的数据服务端拿不到」时
// 能把活排给插件，而不是编一个数字或者干说「我拿不到」。
//
// 【为什么是排队不是等】插件是浏览器扩展，服务端推不动它，用户的浏览器还可能整天关着。
// 所以 dispatch_browser_task 的语义是**排队**：它立刻返回，AI 要如实告诉用户
// 「已排给插件，等它下次醒来跑」，不能说成「已经采好了」。

const dispatchBrowserTask: AgentTool = {
  name: 'dispatch_browser_task',
  label: '派活给浏览器插件',
  action: 'competitor.manage',
  write: true,
  def: {
    name: 'dispatch_browser_task',
    description:
      '把一件**只有浏览器能做**的事排给用户的采集插件：collect_competitor（去某个竞对主页采作品）、'
      + 'collect_self（去用户自己的创作后台回填数据，要指定 platform）。'
      + '用在服务端拿不到数据时，比如需要完播率/粉丝画像这些只有创作后台才有的指标，或竞对数据太旧要刷新。'
      + '⚠️ 它只是**排队**：插件要等下次醒来（用户打开浏览器时）才会执行，不会立刻有数据。'
      + '排完就如实告诉用户「已排给插件」，不要说成已经采到了。'
      + 'open_and_read（让浏览器打开一个网页并把正文读回来——服务端抓不到的平台走这条）。'
      + '如果你**没有这份数据就没法回答**用户的问题，把 wait_for_result 设成 true：'
      + '这次执行会挂起，等插件把活干完（或没干成）自动继续，用户不用管。',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['collect_competitor', 'collect_self', 'open_and_read'],
          description: '要做哪件事',
        },
        url: {
          type: 'string',
          description:
            'kind=open_and_read 时必填：要读的网页地址。**只能是这些站点**：'
            + readAllowlistLabels().join('、')
            + '。别的网址请改用 clip_url（服务端直接抓，不动用户的浏览器）。',
        },
        competitor_id: { type: 'string', description: 'kind=collect_competitor 时必填，来自 list_competitors' },
        platform: { type: 'string', description: 'kind=collect_self 时必填，如 douyin / xiaohongshu' },
        limit: { type: 'number', description: '采几条作品，默认 20，最多 50' },
        wait_for_result: {
          type: 'boolean',
          description:
            '默认 false=排完就继续，你接着回答用户「已排给插件」。'
            + '设成 true=这次执行停下来等结果，插件干完才继续——'
            + '只在「拿不到这份数据就答不了」时才用，因为可能要等到用户下次打开浏览器。',
        },
      },
      required: ['kind'],
    },
  },
  async run(ctx, args) {
    // 没装插件就别排：那条活会一直 pending 到 48 小时后过期，而 AI 已经说过「已排给插件」，
    // 用户等两天什么都没发生也没人告诉他为什么。当场说清、并指路，比排一个没人领的活有用
    if (!(await hasCollector(ctx.workspaceId))) {
      return {
        ok: false,
        error: '这个工作区还没有装采集插件（没有可用的采集令牌），派下去也没有浏览器会执行。请先到「采集助手」页装插件并填入采集令牌。',
        summary: '还没装采集插件',
      };
    }
    const kind = str(args.kind);

    // 「让浏览器去读一个网页」是唯一一个由服务端指定 URL 的动作，所以多两道闸：
    // ① 工作区必须显式打开过这个开关（**默认关**）；② URL 必须在白名单里。
    // 插件端另有一份硬编码的同款清单——那份才是真正的防线，这里只是早失败早说清楚
    if (kind === 'open_and_read') {
      const ws = await prisma.workspace.findUnique({
        where: { id: ctx.workspaceId },
        select: { browserReadEnabled: true },
      });
      if (!ws?.browserReadEnabled) {
        return {
          ok: false,
          error: '这个团队还没有打开「让插件替我读网页」这个开关（默认是关的）。要用的话去「采集助手」页打开它。',
          summary: '读网页的开关没开',
        };
      }
      const url = str(args.url);
      if (!isReadAllowed(url)) {
        return {
          ok: false,
          error: `这个网址不在允许打开的站点清单里（只允许：${readAllowlistLabels().join('、')}）。别的网址用 clip_url 让服务端直接抓。`,
          summary: '网址不在白名单里',
        };
      }
    }

    const payload =
      kind === 'collect_competitor'
        ? { kind, competitorId: str(args.competitor_id), limit: clamp(num(args.limit, 20), 1, 50) }
        : kind === 'open_and_read'
          ? { kind, url: str(args.url), mode: 'article' as const }
          : { kind, platform: str(args.platform) };

    // 竞对必须已经在订阅列表里：不校验的话 AI 可以拿一个任意 id 让插件去访问
    if (kind === 'collect_competitor') {
      const watched = await prisma.watchlistItem.findFirst({
        where: { workspaceId: ctx.workspaceId, competitorId: str(args.competitor_id) },
        select: { id: true },
      });
      if (!watched) {
        return { ok: false, error: '这个竞对不在你的监控列表里，先用 add_competitor 加进来', summary: '竞对未订阅' };
      }
    }

    const r = await enqueueBrowserTask({
      workspaceId: ctx.workspaceId,
      accountId: ctx.accountId,
      payload,
      origin: 'agent',
      createdBy: ctx.memberId,
    });
    if (!r.ok) return { ok: false, error: r.error, summary: '任务没排上' };

    const label = BROWSER_KIND_LABEL[kind as keyof typeof BROWSER_KIND_LABEL] ?? kind;
    // 模型说「没这份数据我答不了」时，就把整次执行停在这儿等结果。
    // 叫醒由 lib/browser-task 在四种结局（完成/判死/过期/取消）上触发——
    // 只要有一种结局没人叫醒，这里就成了一次永远醒不来的运行，所以别在这里加新的等待类型。
    if (args.wait_for_result === true) {
      return {
        ok: true,
        data: { taskId: r.id, kind },
        waitFor: browserWaitToken(r.id),
        summary: `已排给插件：${label}。这次执行先停在这里等它的结果。`,
      };
    }
    return {
      ok: true,
      data: { taskId: r.id, kind },
      summary: `已排给插件：${label}。插件下次醒来会执行，现在还没有数据。`,
    };
  },
};

const listBrowserTasks: AgentTool = {
  name: 'list_browser_tasks',
  label: '看派给浏览器的活',
  action: 'content.view',
  write: false,
  def: {
    name: 'list_browser_tasks',
    description:
      '看最近派给插件的活跑到哪了：pending=还没被领走、claimed=插件正在做、done=做完了、'
      + 'failed=试了几次都失败、expired=超过有效期插件一直没打开。'
      + '用户问「上次让采的怎么样了」时调它。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  async run(ctx) {
    const rows = await prisma.browserTask.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, kind: true, status: true, error: true, result: true, createdAt: true },
    });
    return {
      ok: true,
      data: rows.map((r) => ({
        id: r.id,
        what: BROWSER_KIND_LABEL[r.kind as keyof typeof BROWSER_KIND_LABEL] ?? r.kind,
        status: r.status,
        note: r.result ?? r.error ?? null,
        at: fmtDate(r.createdAt),
      })),
      summary: rows.length ? `最近 ${rows.length} 个浏览器任务` : '还没派过浏览器任务',
    };
  },
};

// ── 智能体（= 工作流模板）───────────────────────────────────────────────────
//
// 「一步」是技能，「一串」是智能体。这两个工具让**对话**也能派智能体上工，
// 而不是只能去 /workflows 页面手点——用户说「用一键成稿跑一下」时，
// 模型先 list_agents 认人，再 run_agent 派活。

const listAgents: AgentTool = {
  name: 'list_agents',
  label: '看有哪些智能体',
  action: 'content.view',
  write: false,
  def: {
    name: 'list_agents',
    description:
      '列出本团队已安装的智能体（工作流模板）：id、名字、职责说明、共几步、以及**跑之前需要先有什么**（needsFirst）。'
      + '用户提到「用某某智能体/模板跑一下」时先调它认人。'
      + 'needsFirst 不为空的，先确认那个条件满足了再派——否则它第一步就会失败。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  async run(ctx) {
    // 「这个团队能派哪些智能体」只有一个判断处：listTemplates（/workflows 页用的同一个）。
    // 它顺手同步内置模板（补 persona 的那次升级，不调的话 AI 在有人访问过那一页之前
    // 读到的职责全是空的——一个内置智能体都派不动且不报错）。
    //
    // 【为什么不自己查 WorkflowInstall】曾经这里直接查安装表，与页面的规则悄悄分了叉，
    // 一次踩中两个洞：① 自建模板**不写安装行**（createTemplate 从来不写），
    // 于是用户自己建的智能体在页面上好好的、对 AI 永远不存在，run_agent 也派不动；
    // ② 卸载只是把 install.enabled 置 false，这里没过滤 enabled，卸载掉的内置智能体
    // 照样被列出来还能派。两处规则合一，这类静默失效才不会再长出来。
    const templates = await listTemplates(ctx.tenantId);
    const rows = templates
      .filter((t) => t.installed)
      .map((t) => ({
        id: t.id,
        name: `${t.emoji} ${t.name}`,
        // 没写职责的照样列出来，但如实说「没写」——模型才知道它只能靠名字猜，
        // 而不是以为这个智能体没能力
        duty: t.persona || '（未填写职责说明）',
        // 前置条件要一并给模型：不给的话它会派一条注定第一步就失败的智能体，
        // 然后把「没有可用选题」当成系统故障转述给用户
        needsFirst: t.requires || null,
        // 【自主型没有「步骤」这回事】照抄 steps.length 会把它印成「共 0 步」——
        // 模型看到 0 步会以为这是个空模板而不去派它，用户则会以为自己配坏了。
        // 两种形态各说各的话。
        ...(isAutonomous(t.mode)
          ? (() => {
              const cfg = parseAgentConfig(t.agentConfig);
              return {
                形态: '自主（给它目标，自己安排怎么做）',
                可用工具数: cfg.tools.length || '不限（受你自己的权限约束）',
                ...(cfg.callBudget ? { 调用预算: cfg.callBudget } : {}),
              };
            })()
          : { 形态: '流水线（步骤定死）', steps: t.steps.length }),
      }));
    return {
      ok: true,
      data: rows,
      summary: rows.length ? `已装 ${rows.length} 个智能体` : '这个团队还没装任何智能体，去「智能体」页安装',
    };
  },
};

const runAgent: AgentTool = {
  name: 'run_agent',
  label: '派智能体干活',
  action: 'content.create',
  write: true,
  // 一个模板里每一步都可能调模型/生图，是这批工具里最贵的一个。
  // costly 与 write 都为 true → 必定停下来问用户（needsConfirm）
  costly: true,
  // 一个智能体最多 10 步，每步可能是一次模型调用或一次生图。给足——
  // 超时掐不断它，只会让模型以为没跑成而想重来一次（那是两次真的执行）
  timeoutMs: 20 * 60_000,
  def: {
    name: 'run_agent',
    description:
      '派一个智能体（工作流模板）从头跑到尾：按它自己的步骤依次做选题/初稿/技能/封面/配图/发布计划。' +
      '要先用 list_agents 拿到 id。这一步会花较长时间并消耗 AI 配额，发布只建计划不会真的发出去。',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'list_agents 返回的 id' },
        draft_id: { type: 'string', description: '可选：从这篇已有草稿接着做；不给就由模板自己新建（只对流水线型有效）' },
        goal: { type: 'string', description: '可选：这次具体让它做什么（只对自主型有效；不给就按它自己的职责来）' },
      },
      required: ['agent_id'],
    },
  },
  async run(ctx, args) {
    const id = str(args.agent_id);
    if (!id) return { ok: false, error: '要先说清楚派哪个智能体（先调 list_agents）', summary: '缺少 agent_id' };

    const wfCtx = {
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      accountId: ctx.accountId,
      memberId: ctx.memberId,
      draftId: str(args.draft_id) || null,
      trigger: 'agent' as const,
    };

    try {
      // 【两种智能体，两条路】自主的那种没有「步骤」可跑——它是「给它目标和授权范围，
      // 它自己安排」。派它 = 起一次**子运行**（另一条 AI 执行循环），
      // 而不是把一串定死的步骤展开。
      const tpl = await prisma.workflowTemplate.findFirst({
        where: { id, enabled: true, OR: [{ isBuiltin: true }, { tenantId: ctx.tenantId }] },
        select: { id: true, name: true, mode: true, agentConfig: true, persona: true },
      });
      if (!tpl) return { ok: false, error: '这个智能体不存在或已停用', summary: '智能体对不上' };

      if (isAutonomous(tpl.mode)) {
        const { startChildRun } = await import('./child-run');
        return startChildRun(ctx, {
          templateId: tpl.id,
          templateName: tpl.name,
          config: parseAgentConfig(tpl.agentConfig),
          goal: str(args.goal) || `按你的职责做这件事：${tpl.persona || tpl.name}`,
        });
      }

      // 【为什么不再在这里一口气跑完】原来这里是 `await runWorkflow(...)` 到底：
      // 一条十步的流水线要跑几十分钟，而这几十分钟里**整个 AI 执行都被钉在这一个
      // 工具调用上**——用户看到的是一条不动的任务，超时闸到点了还会让模型以为没跑成、
      // 想再派一次（那是两次真的执行）。
      //
      // 现在改成：先建行 → 交回一个「已经派出去了」的挂起令牌 → 执行器把这次运行挂起
      // → 流水线跑完时叫醒它。次序不能反：**先建行拿到 id，才挂得住**。
      const runId = await createWorkflowRun(wfCtx, id);

      // 触发执行：fire-and-forget，**绝不能走 getQueue().enqueue**——
      // 进程内队列的 enqueue 是同步 await，那等于原地跑完，白改一场
      //（同 lib/agent/kick.ts 的理由，那边踩过）。
      kickWorkflowRun(wfCtx, runId);

      return {
        ok: true,
        waitFor: workflowWaitToken(runId),
        data: { runId },
        summary: '已经派出去了，正在跑（跑完会自动接着做）',
      };
    } catch (err) {
      // 「模板不存在/没有步骤」这类是模型给错了 id，如实回灌让它重来，不要当成系统故障
      return { ok: false, error: (err as Error).message.slice(0, 200), summary: '智能体没跑起来' };
    }
  },
};

// ── 技能（= 一次生成）─────────────────────────────────────────────────────
//
// 【为什么必须有这两个】在此之前 AI 只认得「能力」和「智能体」两类，
// 用户装好的技能（内置 6 个 + 自建的全部）**对模型完全不存在**：
// 说一句「按小红书的调性改一下」，它只能用通用提示词自己硬写，
// 用不上那条已经调好的模板——而用户会以为「我装的技能没生效」。
//
// 技能与智能体的分界见 lib/agent/roles.ts：技能是**一次生成**，智能体是**一串步骤**。
// 派活次序（先智能体、再技能、最后单个能力）写在 systemPrompt 里，也从那个文件生成。

const listSkills: AgentTool = {
  name: 'list_skills',
  label: '看有哪些技能',
  action: 'content.view',
  write: false,
  def: {
    name: 'list_skills',
    description:
      '列出本团队**已安装**的技能：id、名字、目标平台、说明。技能 = 把一篇正文一次性变成某个平台的成品'
      + '（排成公众号 / 改成小红书笔记 / 拆成口播脚本）。'
      + '用户只要一次成品、而不是一整套流程时，先调它认人，再用 run_skill。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  async run(ctx) {
    const rows = await listInstalledSkills(ctx.tenantId);
    return {
      ok: true,
      // 说明就是给模型的路由依据（技能没有单独的「职责说明」字段——description
      // 本来写的就是「这个技能拿来干什么」，再加一个字段等于让用户写两遍同一句话）
      data: rows.map((k) => ({
        id: k.id,
        name: `${k.emoji} ${k.name}`,
        platform: skillPlatformName(k.platform),
        what: k.description,
        // image 类技能产出的是图不是文字，调用方（和模型）要分得清
        outputKind: k.outputKind,
      })),
      summary: rows.length ? `已装 ${rows.length} 个技能` : '这个团队还没装任何技能，去「技能」页装上再用',
    };
  },
};

const runSkillTool: AgentTool = {
  name: 'run_skill',
  label: '跑一个技能',
  action: 'content.create',
  write: true,
  // 每次都是一次真实的模型调用（image 类还要生图），比读工具贵得多
  costly: true,
  // 一次技能 = 一次模型生成，长文可能要几分钟
  timeoutMs: 5 * 60_000,
  def: {
    name: 'run_skill',
    description:
      '拿一个技能去改写某篇草稿的正文，结果**存成这篇草稿的新版本**（不覆盖旧版，用户可以对比回退）。'
      + '要先用 list_skills 拿 skill_id、用 list_drafts 拿 draft_id。'
      + '这一步会消耗 AI 配额。只要一次成品时用它；要连着做完好几步就改用 run_agent。',
    parameters: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: 'list_skills 返回的 id' },
        draft_id: { type: 'string', description: 'list_drafts 返回的 id，技能作用在它的最新正文上' },
      },
      required: ['skill_id', 'draft_id'],
    },
  },
  async run(ctx, args) {
    const skillId = str(args.skill_id);
    const draftId = str(args.draft_id);
    if (!skillId || !draftId) {
      return { ok: false, error: '要先说清楚用哪个技能、改哪篇草稿（先调 list_skills 与 list_drafts）', summary: '缺参数' };
    }

    // 归属校验绝不能省：模型可能把别处看到的 id 直接拿来用（同 read_draft）
    const draft = await prisma.draft.findFirst({
      where: { id: draftId, account: { workspaceId: ctx.workspaceId } },
      include: { versions: { orderBy: { seq: 'desc' }, take: 1 } },
    });
    if (!draft) return { ok: false, error: '草稿不存在或不属于当前工作区', summary: '没找到这篇草稿' };
    const content = draft.versions[0]?.content ?? '';
    if (!content.trim()) return { ok: false, error: '这篇草稿还没有正文，技能没有可作用的内容', summary: '草稿是空的' };

    // image 类技能要在**花钱之前**挡掉：它产出的是封面图，`output` 只是印在图上的标题
    // 那几个字。照着存草稿版本，会把用户整篇正文替换成一行标题——一次静默的数据破坏。
    // 出图有自己的入口（创作工坊「标题与封面」/ AI 出图），AI 不从这条路走。
    const skill = await prisma.contentSkill.findFirst({
      where: { id: skillId, enabled: true, OR: [{ isBuiltin: true }, { tenantId: ctx.tenantId }] },
      select: { name: true, outputKind: true },
    });
    if (!skill) return { ok: false, error: '这个技能不存在或不属于当前团队', summary: '没找到这个技能' };
    if (skill.outputKind === 'image') {
      return {
        ok: false,
        error: `「${skill.name}」是出封面图的技能，不能用来改写正文。要封面请让用户去「AI 出图」或创作工坊的「标题与封面」。`,
        summary: '这是出图技能，不走这条路',
      };
    }

    // 安装与跨租户校验都在 runSkill 里（与创作工坊、工作流走同一条闸），这里不另开一条路
    const r = await runSkill({ tenantId: ctx.tenantId, skillId, content, title: draft.title });
    if (!r.ok) return { ok: false, error: r.error, summary: '技能没跑成' };
    // Mock 产出是示例文案。写进草稿会让用户拿着示例内容去发，比不写严重得多
    // （同工作流 skill 步的口径：mocked 一律不落库）
    if (r.mocked) {
      return {
        ok: false,
        error: '还没接入真实模型，这次只拿到示例内容，没有写进草稿',
        summary: '未接真实模型，没有保存',
      };
    }

    await persistDraftVersion({
      workspaceId: ctx.workspaceId,
      accountId: draft.accountId,
      draftId,
      topicTitle: draft.title,
      content: r.output,
      label: `AI 助手：${skill.name}`,
    });
    return {
      ok: true,
      data: { draftId, chars: r.output.length },
      summary: `${skill.name} 跑完，已存成《${draft.title}》的新版本（${r.output.length} 字）`,
      // 指向草稿本身而不是版本行：用户点过去要看的是「现在这篇长什么样」，
      // 而版本对比在那一页里就有
      artifacts: [{ kind: 'draft_version' as const, refId: draftId, label: `《${draft.title}》新增一版（${skill.name}）` }],
    };
  },
};

// ── 定时（只读）───────────────────────────────────────────────────────────
//
// 【为什么只给读、不给建】定时是**用户睡着时在花钱**：每工作区每天有次数上限、
// 连续失败会自动停用、跑不跑得成用户当时看不见。让模型替他建一条，等于让他在
// 不知情的情况下签一份每天扣额度的合约。读是安全的，而且能让 AI 回答
// 「你已经有一条每天 9 点的了，不用再配」——这才是它在这件事上真正的用处。

const listSchedules: AgentTool = {
  name: 'list_schedules',
  label: '看定时计划',
  action: 'content.view',
  write: false,
  def: {
    name: 'list_schedules',
    description:
      '列出这个工作区已配的定时计划：几点几分、周几、跑哪个智能体、上次跑得怎么样、是否已被自动停用。'
      + '用户说「以后每天帮我跑一遍」时**先调它看有没有重复的**，再用 draft_schedule 配新的。'
      + '（配新计划会先停下来让用户确认——那是一份会在他不在场时花钱的合约，不能由你一个人签。）',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  async run(ctx) {
    const rows = await prisma.scheduledAgent.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: [{ atHour: 'asc' }, { atMinute: 'asc' }],
      include: { template: { select: { name: true, emoji: true } } },
    });
    return {
      ok: true,
      data: rows.map((r) => ({
          id: r.id,
          agent: scheduleTargetLabel(r),
          // 说法与定时那张表同一个函数：空数组=每天这个口径只写在 schedule-format 里，
          // 在这儿另算一遍迟早跟界面对不上（而模型转述的是这一份）
          when: `${scheduleWhen(parseWeekdays(r.weekdays), r.atHour, r.atMinute)}（北京时间）`,
          enabled: r.enabled,
          // 停用的原因要说出来：用户问「怎么没跑」时，这一条就是答案
          note: !r.enabled && r.failStreak > 0 ? `连续失败 ${r.failStreak} 次已被自动停用` : (r.lastError ?? r.lastStatus ?? null),
      })),
      summary: rows.length ? `${rows.length} 条定时计划` : '还没有定时计划（要配的话去「定时任务」页）',
    };
  },
};

export const AGENT_TOOLS: AgentTool[] = [
  listTopics,
  listDrafts,
  readDraft,
  listHot,
  listCompetitors,
  createDraft,
  addCompetitor,
  collectCompetitor,
  generateTopics,
  listAgents,
  runAgent,
  listSkills,
  runSkillTool,
  listSchedules,
  dispatchBrowserTask,
  listBrowserTasks,
  // 数据与洞察类（查表现/单条作品/读者原声/爆款基因/算法诊断）。
  // 分文件只是为了这一份表不至于长到没人读得完——注册表仍然只有这一张，
  // 「没注册的 AI 就做不了」那条边界一点没变
  ...INSIGHT_TOOLS,
  // 内容与记忆类（合规检测/查资讯库/查素材/读写记忆/收藏链接）
  ...CONTENT_TOOLS,
  // 产出与发布类（查/建发布计划、出封面、开会诊）——全部会花钱或改数据，各自带确认闸
  ...PRODUCE_TOOLS,
  // 起草制（配定时/拼智能体）：AI 出草案，落库仍然要用户在确认卡上点头
  ...PLANNING_TOOLS,
];

export function toolByName(name: string): AgentTool | null {
  return AGENT_TOOLS.find((t) => t.name === name) ?? null;
}

// 【这里刻意没有 toolsForRole】曾经有过，只按角色过滤。加了工作区级的「插件开关」之后
// 它就成了一条**绕开开关的近路**：谁用它谁拿到的清单里就还有被关掉的工具，而且不报错。
// 唯一的入口是 lib/agent/tool-config.ts 的 toolsFor(role, disabled)——两个判据一起收口。

/** 要不要停下来问用户：写操作、或者花钱的操作。 */
/** 这次执行的授权状态。只从**库里**读，不接受对话里的任何声明。 */
export type RunAuth = {
  authMode: string;
  /** 派发时用户勾定的工具名 */
  preauthorizedTools: readonly string[];
};

export type AuthMode = 'confirm_each' | 'preauthorized' | 'unattended';

/**
 * 这一步要不要停下来问人。
 *
 * 【三档的分界】
 *   confirm_each（缺省）—— 会改数据或花钱的都问。这是旧行为，也是所有说不清的情况的落点。
 *   preauthorized       —— 派发时勾过的那些不再问；**没勾的照问**。
 *   unattended          —— 都不问，**除了 contract 工具**（那是机制级的，见下）。
 *
 * 【为什么 contract 工具在无人值守下也要停】它们签的东西影响不止这一次执行：
 * 定时会在用户睡着时按时花钱、记忆会改变以后每一次生成、发布计划摆着等被发出去。
 * 「用户不在场」恰恰是最不该替他签这些的时候——所以这一条不看授权档、不看提示词，
 * 是代码里的一道硬闸。碰到它的运行会停成 awaiting_confirm 进收件箱等人，而不是替他决定。
 *
 * 【run 缺省时按最保守的档】漏传的失败方向是「多问一次」，不是「悄悄执行」。
 */
export function needsConfirm(tool: AgentTool, run?: RunAuth | null): boolean {
  const risky = tool.write || tool.costly === true;
  if (!risky) return false;

  const mode = (run?.authMode ?? 'confirm_each') as AuthMode;

  // 机制级：签合约的那几样，任何档下都要人点头
  if (tool.contract) return true;

  if (mode === 'unattended') return false;
  if (mode === 'preauthorized') return !(run?.preauthorizedTools ?? []).includes(tool.name);
  return true; // confirm_each，以及任何没见过的档
}

/** 哪些工具能出现在派发卡上（会改数据或花钱的那些，只读工具没什么可授权的）。 */
export function authorizableTools(tools: readonly AgentTool[]): AgentTool[] {
  return tools.filter((t) => t.write || t.costly === true);
}

/** 把工具结果压成给模型看的一段文本（控制长度，避免一次工具调用把上下文撑爆）。 */
export function resultForModel(r: ToolResult): string {
  if (!r.ok) return toJson({ ok: false, error: r.error ?? '执行失败' }).slice(0, 2000);
  return toJson({ ok: true, summary: r.summary, data: r.data }).slice(0, 6000);
}
