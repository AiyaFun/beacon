import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getSession, getSessionOrNull } from '@/lib/session';
import { redirect } from 'next/navigation';
import { edition } from '@/lib/edition';
import { Landing } from '@/components/landing/Landing';
import { parseJson } from '@/lib/json';
import { readPersona, isPersonaBlank } from '@/lib/persona';
import { fmtDateLong } from '@/lib/format';

import { Fold } from '@/components/ui';
import { ActionButton } from '@/components/ActionButton';
import { TaskList } from '@/components/TaskList';

import { TrialProgressCard } from '@/components/TrialProgressCard';
import { Icon } from '@/components/icons';
import { loadReadiness } from '@/lib/topic/readiness';
import { listRuns, KIND_LABEL } from '@/lib/runs';
import { TaskDeckHome } from '@/components/TaskDeckHome';
import { PresetCards } from '@/components/PresetCards';
import { availableTools } from '@/lib/agent/run';
import { disabledTools } from '@/lib/agent/tool-config';
import { trialProgress } from '@/lib/pay/trial';
import { buildBattleReport } from '@/lib/battle/report';
import { BattleReport } from '@/components/BattleReport';
import { actGenerateRecommendations, actCrawlCompetitors } from './actions';
import { WeekBattleHeader } from '@/components/WeekBattleHeader';
import { PersonaGuideBanner } from '@/components/PersonaGuideBanner';
import { getServerLang } from '@/lib/i18n/server';
import { listSelectableModels } from '@/lib/llm/selectable';

export const dynamic = 'force-dynamic';

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ goal?: string }>;
}) {
  // 公开首页（2026-09-05）：未登录的 SaaS 访客看到的是营销落地页，不再是登录框。
  // 布局层已对 `/` 放行游客（app/(app)/layout.tsx），这里只决定「给他看什么」。
  // 整机/私有化没有对外营销面：布局在那一步已经把游客送去 /login，这里再兜一次。
  const { goal } = await searchParams;
  const guest = await getSessionOrNull();
  if (!guest) {
    if (edition() !== 'saas') redirect('/login');
    return <Landing />;
  }
  const [s, lang] = await Promise.all([getSession(), getServerLang()]);
  const isEn = lang === 'en';
  const [account, topics, tasks, publishRecords, competitors, memories, sensitiveCount, readiness, tenant, newMemories, recommendedCount] = await Promise.all([
    prisma.creatorAccount.findUnique({ where: { id: s.accountId } }),
    prisma.topicIdea.findMany({ where: { accountId: s.accountId, state: 'recommended' }, orderBy: { totalScore: 'desc' }, take: 3 }),
    prisma.taskItem.findMany({ where: { workspaceId: s.workspaceId }, orderBy: { createdAt: 'desc' } }),
    prisma.publishRecord.findMany({ where: { accountId: s.accountId } }),
    prisma.watchlistItem.count({ where: { workspaceId: s.workspaceId } }),
    prisma.memoryEntry.count({ where: { workspaceId: s.workspaceId, active: true } }),
    prisma.sensitiveWord.count(),
    loadReadiness(s.workspaceId, s.accountId),
    prisma.tenant.findUnique({ where: { id: s.tenantId }, select: { plan: true, planExpiresAt: true } }),
    // 近 7 天新增记忆：把「越用越懂我」从静默变可感知（诚实：真实 count，滚动 7 天窗口）
    prisma.memoryEntry.count({
      where: { workspaceId: s.workspaceId, active: true, createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
    }),
    // 本周作战入口条的条数：待起稿的高潜选题总数（topics 只取了 top3，这里要全量）
    prisma.topicIdea.count({ where: { accountId: s.accountId, state: 'recommended' } }),
  ]);

  // 试用运营节奏：仅在「试用中且未过期」时得到 isTrial=true（纯函数，见 lib/pay/trial.ts）
  const trial = trialProgress(tenant?.plan, tenant?.planExpiresAt);

  // ── 首屏这四样互相不依赖，一次并发拿齐 ──
  //
  // 【为什么改】原来它们是**四段串行 await**：跑动记录 → 工具开关 → 一键任务卡 → 作战报告。
  // 四次数据库往返首尾相接，而后一次并不需要前一次的结果——纯粹的等待叠加。
  // 上面那个 Promise.all 已经把前 11 项并发了，这一段是漏网的尾巴。
  // （2026-08-29 量出来的：首页一共 13 处 prisma 调用 + 5 段串行 await。）
  //
  // 只有 presetCards 内部那次 workflowTemplate 查询是真依赖 taskPreset 的结果，
  // 所以它留在自己的 IIFE 里串着——**依赖是真的就不能并，不是能并的都要并**。
  const [runsRaw, wsToolCfg, presetCards, battleReport, models] = await Promise.all([
    // 任务台首屏那条「正在办的事」。listRuns 已按 (workspaceId, take) 做请求内记忆化，
    // 而 TenantShell 用同样的参数先调过一次 —— 这里实际上不再打库
    listRuns(s.workspaceId, { takePerKind: 8 }),

    // 派发卡要用的动作清单。与助手页同一个来源（availableTools），按角色与工作区开关过滤过
    prisma.workspace.findUnique({
      where: { id: s.workspaceId }, select: { agentToolConfig: true },
    }),

    // 一键任务卡
    (async () => {
      const rows = await prisma.taskPreset.findMany({
        where: { workspaceId: s.workspaceId, enabled: true },
        orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }],
        take: 8,
      });
      const tplIds = [...new Set(rows.map((r) => r.agentTemplateId).filter((v): v is string => !!v))];
      const tpls = tplIds.length
        ? await prisma.workflowTemplate.findMany({ where: { id: { in: tplIds } }, select: { id: true, name: true, emoji: true } })
        : [];
      const nameOf = new Map(tpls.map((t) => [t.id, `${t.emoji} ${t.name}`]));
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        goal: r.goal,
        agentName: r.agentTemplateId ? (nameOf.get(r.agentTemplateId) ?? (isEn ? '(Agent deleted)' : '（智能体已删除）')) : null,
        authorizedCount: parseJson<string[]>(r.preauthorizedTools, []).length,
      }));
    })(),

    // 任务台首页第一屏就是本周作战报告（渲染主体与 /battle 页共用 components/BattleReport）
    buildBattleReport(s.workspaceId, s.accountId),

    // 「先问问」可选的模型清单（2026-09-06 问 AI 并进首页那一框）
    listSelectableModels(s.tenantId, lang),
  ]);

  const activeRuns = runsRaw
    .filter((r) => r.status === 'waiting' || r.status === 'running')
    .slice(0, 8)
    .map((r) => ({
      id: r.id, kind: r.kind, kindLabel: KIND_LABEL[r.kind],
      title: r.title, status: r.status as 'waiting' | 'running', detail: r.detail, href: r.href,
      // 与 /api/runs/active 同一口径：「等你处理」只对自己发起的那条说。
      // 首屏这份是服务端快照，轮询那份是接口——两处都要判，否则第一眼是对的、
      // 15 秒后变了（或者反过来）
      mine: r.memberId ? r.memberId === s.memberId : true,
      waitingOn: r.memberId && r.memberId !== s.memberId ? r.memberName : undefined,
    }));

  const authTools = availableTools(s.role, disabledTools(wsToolCfg?.agentToolConfig))
    .filter((t) => t.write || t.costly)
    .map((t) => ({ name: t.name, label: t.label, costly: t.costly, contract: t.contract }));

  const persona = readPersona(account?.personaCard ?? '{}');
  // 人设完全空白时不再用小字提醒，改为页顶醒目引导卡（见下方 JSX）
  const personaBlank = isPersonaBlank(persona);

  return (
    <>
      {/* 任务台：说一句话就能派活的输入框必须是**上屏第一眼**，而不是四张统计卡之后。
          这一框就是全站唯一的派活入口，也是唯一的「问 AI」入口（2026-09-06：开始执行 / 先问问）。
          ?goal= 只预填不开跑——浮标助手的「让它直接去做」把话带到这儿，用户按了才真跑。 */}
      <TaskDeckHome
        memberName={s.memberName}
        initialActive={activeRuns}
        authorizableTools={authTools}
        initialGoal={goal ? goal.slice(0, 2000) : null}
        models={models}
      />
      {presetCards.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <PresetCards presets={presetCards} />
        </div>
      )}

      {/* 试用节奏卡与「AI 还不认识你」引导卡放在报告标题**之前**：它们说的是账号状态，
          夹在「本周作战」标题和报告正文之间会把标题和它的内容拆开 */}
      <TrialProgressCard trial={trial} />
      {personaBlank && <PersonaGuideBanner />}

      <WeekBattleHeader competitors={competitors} personaBlank={personaBlank} />

      {/* 任务台首页第一屏 = 本周作战报告（与 /battle 共用 BattleReport）；
          工作台保持原来的「统计格 + 今日推荐 Top3」布局，一个字不动。 */}
      {battleReport && <BattleReport report={battleReport} personaBlank={personaBlank} />}

      {/* 待办清单收进折叠（2026-08-26 单壳化）：工作台删了，它不能跟着消失——
          这是手动待办的唯一入口。快速入口没保：那四个格子与侧栏/页签重复。 */}
      {tasks.length > 0 && (
        <Fold
          title={isEn ? 'To-Do List' : '待办清单'}
          sub={isEn ? 'Add items, check when done' : '自己加，做完打勾'}
          note={<span className="small muted">{tasks.filter((t) => !t.done).length} {isEn ? 'unfinished' : '条未完成'}</span>}
        >
          <TaskList tasks={tasks} />
        </Fold>
      )}
    </>
  );
}

