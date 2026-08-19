import { prisma } from '../db';
import { parseJson, toJson, type Metrics } from '../json';
import { can, type Action as RbacAction } from '../rbac';
import { platformName } from '../constants';
import { parseCompetitorUrl } from '../competitor-url';
import { generateRecommendations, crawlOneCompetitor } from '../pipeline';
import { fmtDate } from '../format';
import type { ToolDef } from '../llm/types';

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
  tenantId: string;
  workspaceId: string;
  accountId: string;
  memberId: string;
  role: string;
};

export type ToolResult = { ok: boolean; data?: unknown; error?: string; summary: string };

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
  run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;
};

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

const accountPerformance: AgentTool = {
  name: 'account_performance',
  label: '查我的作品表现',
  action: 'content.view',
  write: false,
  def: {
    name: 'account_performance',
    description: '当前账号最近发布作品的数据表现（播放/点赞/评论等，缺席的指标会如实标为「无此数据」）。',
    parameters: { type: 'object', properties: { limit: { type: 'number', description: '默认 10，上限 30' } } },
  },
  async run(ctx, args) {
    const limit = clamp(num(args.limit, 10), 1, 30);
    const posts = await prisma.ownPost.findMany({
      where: { accountId: ctx.accountId },
      orderBy: { publishedAt: 'desc' },
      take: limit,
      select: { title: true, platform: true, publishedAt: true, metrics: true },
    });
    return {
      ok: true,
      data: posts.map((p) => {
        const m = parseJson<Metrics>(p.metrics, {});
        return {
          title: p.title,
          platform: p.platform,
          publishedAt: p.publishedAt ? fmtDate(p.publishedAt) : null,
          // 缺席就是缺席：这里绝不能把 undefined 补成 0，那会让模型算出一堆假的「互动率 0%」
          views: m.views ?? null,
          likes: m.likes ?? null,
          comments: m.comments ?? null,
        };
      }),
      summary: posts.length ? `最近 ${posts.length} 条作品` : '还没有回流的作品数据',
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
    return { ok: true, data: { draftId: draft.id }, summary: `已创建草稿《${title}》` };
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

export const AGENT_TOOLS: AgentTool[] = [
  listTopics,
  listDrafts,
  readDraft,
  listHot,
  listCompetitors,
  accountPerformance,
  createDraft,
  addCompetitor,
  collectCompetitor,
  generateTopics,
];

export function toolByName(name: string): AgentTool | null {
  return AGENT_TOOLS.find((t) => t.name === name) ?? null;
}

/** 这个角色能用哪些工具。**权限在这里收口一次，执行前还会再查一次**（防止列表与执行漂移）。 */
export function toolsForRole(role: string): AgentTool[] {
  return AGENT_TOOLS.filter((t) => can(role, t.action));
}

/** 要不要停下来问用户：写操作、或者花钱的操作。 */
export function needsConfirm(tool: AgentTool): boolean {
  return tool.write || tool.costly === true;
}

/** 把工具结果压成给模型看的一段文本（控制长度，避免一次工具调用把上下文撑爆）。 */
export function resultForModel(r: ToolResult): string {
  if (!r.ok) return toJson({ ok: false, error: r.error ?? '执行失败' }).slice(0, 2000);
  return toJson({ ok: true, summary: r.summary, data: r.data }).slice(0, 6000);
}
