import { prisma } from '../db';
import { createTemplate } from '../workflow/market';
import { stepsSchema, stepLabel, stepCostly, STEP_KINDS } from '../workflow/steps';
import { createSchedule, clampScheduleTime, normalizeWeekdays, MAX_SCHEDULES } from '../workflow/schedule-create';
import { scheduleWhen } from '../workflow/schedule-format';
import { listInstalledSkills } from '../skills';
import type { AgentTool } from './tools';

// ── 起草制：AI 出草案，落库仍然要用户点头 ──────────────────────────────────
//
// 【为什么这两件事特殊】定时计划与工作流模板都是**会在用户不在场时花钱的合约**：
// 一条定时计划意味着以后每天自动跑一次、每次烧几笔额度。让模型替用户签这种合约，
// 哪怕只错一次，用户醒来面对的是一堆已经发生的消费。
//
// 所以这里不是「加两个写工具」，而是加一层**起草制**：
//   · 工具本身是 write:true → 一律停下来给用户看清楚参数再执行；
//   · 工具的描述里写明「你在起草，不是在替他决定」；
//   · 确认卡上呈现的就是「几点跑、跑哪个、每天几次」这些人能读懂的话。
//
// 这与之前 list_schedules 的「只读」不是矛盾：那时是**完全不给**，现在是
// **给了但必须过人这一关**。两者的共同点是：模型永远不能单独把这份合约签下去。

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v.trim() : fallback);
const num = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const draftSchedule: AgentTool = {
  name: 'draft_schedule',
  label: '配一条定时计划',
  action: 'content.create',
  write: true,
  // 一份会在用户睡着时按时花钱的合约
  contract: true,
  def: {
    name: 'draft_schedule',
    description:
      '给某个智能体配一条定时计划（每天/每周几的几点自动跑一次）。先用 list_agents 拿 agent_id。'
      + '⚠️ 这是一份**会在用户不在场时花钱的合约**：配好之后每次自动跑都消耗额度。'
      + '所以你只是在起草——用户会看到「几点跑、跑哪个」再决定要不要。'
      + '时间一律按北京时间，且只能是整十分（09:00 / 09:10 / 09:20…）。',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'list_agents 返回的 id' },
        hour: { type: 'number', description: '几点（0-23，北京时间）' },
        minute: { type: 'number', description: '几分，只能是整十分，默认 0' },
        weekdays: {
          type: 'array',
          items: { type: 'number' },
          description: '周几跑，0=周日 … 6=周六。**留空 = 每天**',
        },
      },
      required: ['agent_id', 'hour'],
    },
  },
  async run(ctx, args) {
    const templateId = str(args.agent_id);
    if (!templateId) return { ok: false, error: '要先说清楚定时跑哪个智能体（先调 list_agents）', summary: '缺少 agent_id' };

    const weekdays = normalizeWeekdays(Array.isArray(args.weekdays) ? args.weekdays.map((d) => num(d, -1)) : []);
    const { hour, minute } = clampScheduleTime(num(args.hour, 9), num(args.minute, 0));

    const r = await createSchedule({
      workspaceId: ctx.workspaceId,
      accountId: ctx.accountId,
      memberId: ctx.memberId,
      tenantId: ctx.tenantId,
      templateId,
      atHour: hour,
      atMinute: minute,
      weekdays,
    });
    if (!r.ok) return { ok: false, error: r.error, summary: '计划没配成' };

    const template = await prisma.workflowTemplate.findUnique({ where: { id: templateId }, select: { name: true } });
    // 「北京时间」四个字必须写出来：容器跑 UTC，只说数字用户会差 8 小时
    const when = scheduleWhen(weekdays, hour, minute);
    return {
      ok: true,
      data: { scheduleId: r.id, 智能体: template?.name, 什么时候跑: `${when}（北京时间）`, 每日上限: MAX_SCHEDULES },
      summary: `定时计划配好了：${when}（北京时间）自动跑「${template?.name ?? '这个智能体'}」。在「智能体」页可以随时停掉`,
    };
  },
};

const draftWorkflow: AgentTool = {
  name: 'draft_workflow',
  label: '拼一个新智能体',
  action: 'content.create',
  write: true,
  // 建出来之后可以被派、可以挂定时——影响远不止这一次执行
  contract: true,
  def: {
    name: 'draft_workflow',
    description:
      '把几个步骤拼成一个可复用的智能体（工作流模板），以后一句话就能整套跑。'
      + `步骤类型只有这几种：${STEP_KINDS.join(' / ')}，最多 10 步。`
      + 'topic{count 1-12} 跑选题推荐；draft{platform?,topicId?} 写初稿；skill{slug} 跑一个技能；'
      + 'cover{specKey?,styleKey?} 出封面；illustration{count 1-6} 出配图；publish{platforms} 只建发布计划（不会真发）。'
      + '⚠️ 用 list_skills 确认 slug 真实存在再写进 skill 步——写错的 slug 每次跑到那一步都会失败。'
      + '你是在起草，用户会看到完整步骤再决定要不要留下。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '智能体的名字，短一点（不超过 40 字）' },
        persona: { type: 'string', description: '什么时候该派它上（写给以后的你自己看，不写的话你以后不会主动派它）' },
        steps: {
          type: 'array',
          description: '步骤数组，每项形如 {"kind":"draft","platform":"xiaohongshu"}',
          items: { type: 'object' },
        },
      },
      required: ['name', 'steps'],
    },
  },
  async run(ctx, args) {
    const name = str(args.name);
    if (!name) return { ok: false, error: '这个智能体叫什么名字？', summary: '缺少名字' };

    const parsed = stepsSchema.safeParse(args.steps);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return {
        ok: false,
        error: `步骤配置不对（${first?.path.join('.') || '第一步'}：${first?.message ?? '格式错误'}）。步骤类型只有：${STEP_KINDS.join(' / ')}`,
        summary: '步骤形状不对',
      };
    }

    // skill 步引用的 slug 必须真实存在。**这一条不能省**：内置模板就因为引用了一个
    // 不存在的 slug，第二步每次都停在「找不到技能」，而模板本身看着一切正常
    const skillSlugs = parsed.data.filter((s) => s.kind === 'skill').map((s) => s.slug);
    if (skillSlugs.length > 0) {
      const installed = await listInstalledSkills(ctx.tenantId);
      const known = new Set(installed.map((s) => s.slug));
      const missing = skillSlugs.filter((slug) => !known.has(slug));
      if (missing.length > 0) {
        return {
          ok: false,
          error: `这些技能不存在或没安装：${missing.join('、')}。先用 list_skills 看看有哪些可用的`,
          summary: '引用了不存在的技能',
        };
      }
    }

    const r = await createTemplate(ctx.tenantId, ctx.memberId, {
      name,
      persona: str(args.persona) || undefined,
      description: `由 AI 助手按用户要求拼的：${parsed.data.map(stepLabel).join(' → ')}`,
      steps: parsed.data,
    });
    if (!r.ok) return { ok: false, error: r.error, summary: '没建成' };

    const costly = parsed.data.filter(stepCostly).length;
    return {
      ok: true,
      data: {
        agentId: r.id,
        名字: name,
        步骤: parsed.data.map(stepLabel),
        // 把「跑一次要花几次钱」说在前面：用户是靠这个数决定要不要配定时的
        花额度的步数: costly,
      },
      summary: `「${name}」拼好了（${parsed.data.length} 步，其中 ${costly} 步会消耗额度）。以后可以直接让我派它上，也可以给它配定时`,
    };
  },
};

export const PLANNING_TOOLS: AgentTool[] = [draftSchedule, draftWorkflow];