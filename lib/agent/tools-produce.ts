import { prisma } from '../db';
import { fmtDate } from '../format';
import { platformName } from '../constants';
import { listPlans, buildPublishPlan } from '../publish/plan';
import { TASK_STATUS_LABEL, capOf, channelLabel } from '../publish/capability';
import { runCover } from '../cover/run';
import { convene } from '../advisor/panel';
import type { AgentTool } from './tool-types';
import { clamp, num, str } from './tool-types';

// ── 产出与发布类工具 ────────────────────────────────────────────────────────
//
// 这一组会**花钱**或**改数据**，所以每一个都要走确认闸（write / costly）。
//
// 【发布这条线上的红线，一个字都不能松】
//   · 建计划 ≠ 发出去。这里只建计划，真正发布永远是用户在发布面板上逐个确认。
//   · 「已填进后台」与「已发布」是两个词，绝不许合并——插件只能把内容填进去，
//     点不点发布是用户的事。合并的后果是用户以为稿子已经出去了。


const listPublishPlans: AgentTool = {
  name: 'list_publish_plans',
  label: '查发布计划',
  action: 'content.view',
  write: false,
  def: {
    name: 'list_publish_plans',
    description:
      '列出当前账号最近的发布计划，以及每个平台那条任务走到哪一步了。'
      + '用户问「我今天要发什么」「那篇发出去了吗」时用。'
      + '⚠️ 状态里「已填进后台，等你点发布」**不等于**「已发布」——转述时别合并这两个说法。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'done'], description: 'open=还没走完的（默认），done=已完成的' },
        limit: { type: 'number', description: '默认 8，上限 20' },
      },
    },
  },
  async run(ctx, args) {
    const status = str(args.status) === 'done' ? 'done' : 'open';
    const take = clamp(num(args.limit, 8), 1, 20);
    const plans = await listPlans({ workspaceId: ctx.workspaceId, accountId: ctx.accountId }, { status, take });

    if (plans.length === 0) {
      return {
        ok: true,
        data: [],
        summary: status === 'open' ? '没有待处理的发布计划' : '还没有已完成的发布计划',
      };
    }

    return {
      ok: true,
      data: plans.map((p) => ({
        planId: p.id,
        draftId: p.draftId,
        稿子: p.draftTitle,
        建于: fmtDate(p.createdAt),
        各平台: p.tasks.map((t) => ({
          平台: t.platformLabel,
          // 状态一律用人话映射，别把原始枚举丢给模型自己翻译——它会把 filled 讲成「已发布」
          状态: TASK_STATUS_LABEL[t.status] ?? t.status,
          发布链接: t.publishedUrl,
          出错: t.error,
        })),
        // content 是整篇稿子，绝不塞进给模型的结果里（几千字 × 几个平台）
      })),
      summary: `${plans.length} 份${status === 'open' ? '待处理' : '已完成'}的发布计划`,
    };
  },
};

const createPublishPlan: AgentTool = {
  name: 'create_publish_plan',
  label: '建发布计划',
  action: 'content.create',
  write: true,
  // 影响不止这一次执行：计划摆在那儿等着被发出去
  contract: true,
  def: {
    name: 'create_publish_plan',
    description:
      '给一篇草稿建一份发布计划：选中的每个平台各排一条任务。'
      + '⚠️ 它**只是建计划，不会把内容发出去**——真正发布要用户自己在发布面板上逐个确认。'
      + '先用 list_drafts 拿 draftId。',
    parameters: {
      type: 'object',
      properties: {
        draftId: { type: 'string', description: '要发的草稿 id' },
        platforms: {
          type: 'array',
          items: { type: 'string' },
          description: '平台键数组，如 ["xiaohongshu","wechat"]，1-8 个',
        },
      },
      required: ['draftId', 'platforms'],
    },
  },
  async run(ctx, args) {
    const draftId = str(args.draftId);
    const platforms = Array.isArray(args.platforms)
      ? args.platforms.map((p) => str(p)).filter(Boolean)
      : [];
    if (!draftId) return { ok: false, error: '要先说清楚发哪篇（先调 list_drafts）', summary: '缺少 draftId' };
    if (platforms.length === 0) return { ok: false, error: '至少要选一个平台', summary: '没选平台' };

    const r = await buildPublishPlan({
      workspaceId: ctx.workspaceId,
      accountId: ctx.accountId,
      draftId,
      memberId: ctx.memberId,
      platforms,
      // 与工作流里 publish 步同一个口径：**建计划不是对外发布**，
      // 真正发出去时用户还要在发布面板上再确认一次（那里才是声明生效的地方）
      aigcConfirmed: true,
    });
    if (!r.ok) return { ok: false, error: r.error, summary: '计划没建成' };

    // 顺手告诉用户哪些平台只能手动发——不说的话他会以为排好了就会自动出去
    const manual = platforms.filter((p) => capOf(p).channel !== 'api');
    return {
      ok: true,
      data: {
        planId: r.planId,
        平台: platforms.map((p) => ({ 平台: platformName(p), 发布方式: channelLabel(capOf(p).channel) })),
      },
      summary:
        `发布计划已建好（${platforms.length} 个平台）。稿子还没有发出去——`
        + `要去「发布中心」逐个确认${manual.length > 0 ? `；其中 ${manual.map(platformName).join('、')} 只能由用户自己点发布` : ''}`,
      artifacts: [{
        kind: 'publish_plan' as const,
        refId: r.planId,
        // 标签里也要说清「还没发出去」：产物清单是用户扫一眼就走的地方，
        // 只写「发布计划」会被读成「已经发了」
        label: `发布计划（${platforms.length} 个平台，还没发出去）`,
      }],
    };
  },
};

const generateImage: AgentTool = {
  name: 'generate_image',
  label: '出一张封面图',
  action: 'content.create',
  write: true,
  costly: true,
  // 抽标题一次文本调用 + 每张图一次生图调用，串行
  timeoutMs: 8 * 60_000,
  def: {
    name: 'generate_image',
    description:
      '按一句主标题直接出一张 AI 封面图（会按平台自动选比例）。用户说「给这篇出个封面」时用。'
      + '⚠️ 每张图都是真实付费调用。要出正文配图（不上字的那种）请让用户去「AI 出图」页，这里只出封面。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '印在封面上的主标题，短句最好（十来个字）' },
        platform: { type: 'string', description: '目标平台，决定比例。如 xiaohongshu / wechat / bilibili' },
        subtitle: { type: 'string', description: '可选：副标题' },
        draftId: { type: 'string', description: '可选：这张图属于哪篇草稿' },
      },
      required: ['title', 'platform'],
    },
  },
  async run(ctx, args) {
    const title = str(args.title);
    const platform = str(args.platform);
    if (!title) return { ok: false, error: '封面上要印什么字？', summary: '缺少主标题' };
    if (!platform) return { ok: false, error: '要出给哪个平台用（比例不一样）', summary: '缺少平台' };

    // 草稿 id 是模型给的，必须校验归属再往下传
    const draftId = str(args.draftId);
    if (draftId) {
      const owned = await prisma.draft.findFirst({
        where: { id: draftId, account: { workspaceId: ctx.workspaceId } },
        select: { id: true },
      });
      if (!owned) return { ok: false, error: '这篇草稿不存在或不属于当前工作区', summary: '草稿对不上' };
    }

    // 【直接给 mainTitle，不走 instruction】instruction 那条路要先查内置技能、
    // 拼账号上下文、渲染模板，是「封面工位」那一整套；这里只要一张图，
    // 给了 mainTitle 就能跳过抽标题那次文本调用（也省一次配额）
    const r = await runCover({
      tenantId: ctx.tenantId,
      workspaceId: ctx.workspaceId,
      accountId: ctx.accountId,
      draftId: draftId || null,
      platform,
      // 给了 mainTitle 就不会去抽标题，fallbackTitle 只是签名要求的兜底位
      fallbackTitle: title,
      meta: { mainTitle: title, subTitle: str(args.subtitle) || undefined },
    });

    if (!r.ok) {
      // reason 分档给出不同的指引：配额用完与没配渠道，用户要做的事完全不同
      const hint =
        r.reason === 'quota' ? '（额度用完了，明天再来或去「套餐」页看看）'
          : r.reason === 'not_configured' ? '（还没配置生图渠道，去「接入与密钥」页配一个）'
            : r.reason === 'redline' ? '（标题命中了合规红线，换个说法）'
              : '';
      return { ok: false, error: `${r.error}${hint}`, summary: '这张图没出成' };
    }

    return {
      ok: true,
      data: {
        张数: r.images.length,
        // 图片字节绝不进模型上下文（一张几百 KB 的 base64 会把窗口撑爆）——只给 id 与去哪看
        资产id: r.images.map((i) => i.id).filter(Boolean),
        比例: r.spec.label,
        风格: r.styleKey,
      },
      summary: `封面出好了（${r.images.length} 张，${r.spec.label}），去「AI 出图」或创作工坊的封面区看`,
      artifacts: r.images
        .filter((i) => i.id)
        .map((i) => ({ kind: 'image' as const, refId: i.id!, label: `封面图（${r.spec.label}）` })),
    };
  },
};

const runAdvisor: AgentTool = {
  name: 'run_advisor',
  label: '开一场选题会诊',
  action: 'content.create',
  write: true,
  costly: true,
  // 十几位专家并行发言，每人一次模型调用
  timeoutMs: 8 * 60_000,
  def: {
    name: 'run_advisor',
    description:
      '召集智囊团给一个题目会诊：十来位不同立场的专家各给一个切入角与理由。'
      + '用于「这个选题该怎么切」「帮我想几个不一样的角度」。'
      + '⚠️ 一次会诊 = 十几次模型调用，很贵。用户只是想要几条选题时用 generate_topics 更划算。',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '要会诊的题目/方向' },
        draftId: { type: 'string', description: '可选：针对某篇已有草稿会诊' },
      },
    },
  },
  async run(ctx, args) {
    const seed = str(args.topic);
    const draftId = str(args.draftId);
    if (!seed && !draftId) return { ok: false, error: '要会诊什么题目？', summary: '没给题目' };

    if (draftId) {
      const owned = await prisma.draft.findFirst({
        where: { id: draftId, account: { workspaceId: ctx.workspaceId } },
        select: { id: true },
      });
      if (!owned) return { ok: false, error: '这篇草稿不存在或不属于当前工作区', summary: '草稿对不上' };
    }

    let sessionId: string;
    try {
      // 【第五个参数必须传】convene 不传租户时会去翻会话，而这里是后台跑的——
      // 翻不到就是 null，于是一场十几席的会诊一个配额都不计、演示租户也拦不住
      sessionId = await convene(ctx.accountId, ctx.workspaceId, seed || undefined, draftId || undefined, ctx.tenantId);
    } catch (err) {
      return { ok: false, error: (err as Error).message.slice(0, 200), summary: '会诊没开成' };
    }

    const session = await prisma.advisorSession.findUnique({
      where: { id: sessionId },
      include: { opinions: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) return { ok: false, error: '会诊记录读不回来', summary: '会诊没开成' };

    // summary 以 ⚠ 开头 = 这一场里有人是 Mock 兜底的内容。必须原样说破，
    // 否则就是拿演示文案冒充专家结论
    const partlyMocked = (session.summary ?? '').startsWith('⚠');

    return {
      ok: true,
      data: {
        会诊id: session.id,
        题目: session.topicSeed,
        结论: session.summary,
        各方意见: session.opinions.slice(0, 12).map((o) => ({
          专家: o.personaName,
          切入角: o.suggestion,
          理由: o.rationale,
        })),
      },
      summary: partlyMocked
        ? `会诊开完了（${session.opinions.length} 位专家），但其中有人是示例内容——转述时要说清楚哪些不算真结论`
        : `会诊开完了：${session.opinions.length} 位专家给了角度，详情在「选题智囊团」页`,
    };
  },
};

export const PRODUCE_TOOLS: AgentTool[] = [
  listPublishPlans,
  createPublishPlan,
  generateImage,
  runAdvisor,
];
