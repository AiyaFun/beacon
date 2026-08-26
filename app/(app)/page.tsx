import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { parseJson, type Metrics } from '@/lib/json';
import { readPersona, isPersonaBlank } from '@/lib/persona';
import { fmtDateLong } from '@/lib/format';
import { HOT_SOURCES } from '@/lib/constants';
import { Card, Fold } from '@/components/ui';
import { ActionButton } from '@/components/ActionButton';
import { TaskList } from '@/components/TaskList';
import { AdviceCard } from '@/components/AdviceCard';
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

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const s = await getSession();
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

  // 任务台首屏那条「正在办的事」。**只在任务台下查**——工作台不渲染它，
  // 白查一次五张表只是给每个用户的首页平白加一笔开销
  const activeRuns = (await listRuns(s.workspaceId, { takePerKind: 8 }))
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

  // 派发卡要用的动作清单。与助手页同一个来源（availableTools），按角色与工作区开关过滤过。
  // **只在任务台下算**：工作台首页不渲染派活框，白查一次工具配置没有意义。
  const authTools = availableTools(s.role, disabledTools((await prisma.workspace.findUnique({
        where: { id: s.workspaceId }, select: { agentToolConfig: true },
      }))?.agentToolConfig))
        .filter((t) => t.write || t.costly)
        .map((t) => ({ name: t.name, label: t.label, costly: t.costly, contract: t.contract }));

  // 一键任务卡。**只在任务台下查**——工作台首页不渲染派活区，白查一次没意义
  const presetCards = await (async () => {
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
          agentName: r.agentTemplateId ? (nameOf.get(r.agentTemplateId) ?? '（智能体已删除）') : null,
          authorizedCount: parseJson<string[]>(r.preauthorizedTools, []).length,
        }));
      })();

  const persona = readPersona(account?.personaCard ?? '{}');
  // 人设完全空白时不再用小字提醒，改为页顶醒目引导卡（见下方 JSX）
  const personaBlank = isPersonaBlank(persona);

  // 任务台首页第一屏就是本周作战报告。**只在任务台下查**——工作台首页不渲染它，
  // 白查表现/竞对四处没意义（渲染主体与 /battle 页共用 components/BattleReport）。
  const battleReport = await buildBattleReport(s.workspaceId, s.accountId);

  return (
    <>
      {/* 任务台：说一句话就能派活的输入框必须是**上屏第一眼**，而不是四张统计卡之后。
          下面「今日概览」那一整套一个板块都没少——只是排在派活之后（首页形态差异，
          不是功能差异；两种外壳的**路由级功能**仍然完全对等）。 */}
      {(
        <TaskDeckHome memberName={s.memberName} initialActive={activeRuns} authorizableTools={authTools} />
      )}
      {presetCards.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <PresetCards presets={presetCards} />
        </div>
      )}

        <div className="row wrap" style={{ gap: 8, alignItems: 'baseline', marginBottom: 12 }}>
          <h2 style={{ fontSize: 17, margin: 0 }}>本周作战</h2>
          <span className="small muted">{fmtDateLong(new Date())} · 这周该做什么，每条后面就是执行入口</span>
          <span className="row" style={{ gap: 8, marginLeft: 'auto' }}>
            {competitors > 0 && (
              <ActionButton action={actCrawlCompetitors} loadingText="采集中…">采集竞对</ActionButton>
            )}
            {/* 人设空白时这里**不再重复一个建人设按钮**：下面那条醒目横幅
                （「AI 还不认识你」）已经带着同一个入口，同屏两个同去处的主按钮
                只会让人以为是两件事（2026-08-26 用户指出的重复跳转）。 */}
            {!personaBlank && (
              <ActionButton action={actGenerateRecommendations} primary loadingText={['正在采集热榜…', '正在聚类分析…', '正在 AI 精选推荐…']}>刷新选题</ActionButton>
            )}
          </span>
        </div>

      {/* 试用节奏卡：临期高亮 + 续费入口；非试用时组件内部返回 null，不占位 */}
      <TrialProgressCard trial={trial} />

      {personaBlank && (
        <div className="alert-gradient-brand" style={{ padding: '16px 20px', marginBottom: 20 }}>
          <div className="row-between wrap" style={{ gap: 12, alignItems: 'center' }}>
            <div className="row" style={{ gap: 12, alignItems: 'center' }}>
              <div className="icon-box-brand">
                <Icon.sparkles size={18} />
              </div>
              <div>
                <b style={{ color: 'var(--brand)', fontSize: 15 }}>AI 还不认识你</b>
                <div className="small" style={{ marginTop: 2, opacity: 0.9 }}>
                  人设是所有推荐的地基——空着的话，热点再准也匹配不到你头上。
                </div>
              </div>
            </div>
            <Link href="/persona" className="btn btn-primary" style={{ fontSize: 14, padding: '8px 18px' }}>
              1 分钟创建专属人设 →
            </Link>
          </div>
        </div>
      )}

      {/* 任务台首页第一屏 = 本周作战报告（与 /battle 共用 BattleReport）；
          工作台保持原来的「统计格 + 今日推荐 Top3」布局，一个字不动。 */}
      {battleReport && <BattleReport report={battleReport} personaBlank={personaBlank} />}

      {/* 待办清单收进折叠（2026-08-26 单壳化）：工作台删了，它不能跟着消失——
          这是手动待办的唯一入口。快速入口没保：那四个格子与侧栏/页签重复。 */}
      {tasks.length > 0 && (
        <Fold title="待办清单" sub="自己加，做完打勾" note={<span className="small muted">{tasks.filter((t) => !t.done).length} 条未完成</span>}>
          <TaskList tasks={tasks} />
        </Fold>
      )}
    </>
  );
}

