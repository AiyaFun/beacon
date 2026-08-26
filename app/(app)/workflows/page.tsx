import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { PageHead, Card, Stat, Fold } from '@/components/ui';
import { can } from '@/lib/rbac';
import { backgroundSchedulerRuns } from '@/lib/jobs/queue';
import { listTemplates, preinstallBuiltinTemplates } from '@/lib/workflow/market';
import { fmtDateTime } from '@/lib/format';
import { PresetManager } from './PresetManager';
import { availableTools } from '@/lib/agent/run';
import { disabledTools } from '@/lib/agent/tool-config';
import { scheduleTargetLabel } from '@/lib/workflow/schedule-format';
import { parseJson } from '@/lib/json';
import { WorkflowMarket } from './WorkflowMarket';
import { RoleTabs } from '@/components/RoleTabs';
import { AGENT_ROLES } from '@/lib/agent/roles';
import { Schedules } from './Schedules';
import { MAX_RUNS_PER_DAY, AUTO_PAUSE_FAILS, parseWeekdays } from '@/lib/workflow/schedule';
import { TRIGGER_LABEL } from '@/lib/runs';
import type { StepLog } from '@/lib/workflow/run';
import { HubHeader } from '@/components/HubHeader';

export const dynamic = 'force-dynamic';

// 工作流模板：把「选题→初稿→技能→封面→配图→发布计划」串成一条可复用的流水线。
// 与技能中心的分工写在页面上，别让用户猜：技能是一步，模板是一串。
export default async function WorkflowsPage() {
  const s = await getSession();
  // 【为什么这里也预装一次】预装本来只挂在「保存人设」那处，于是**存量用户装不上**：
  // 他早就建过人设了，不会再触发一次；不建人设的用户更是永远碰不到。
  // 真机上看到的就是「可用模板 0 / 市场里共 3 条」——三条自带模板对他一条都用不了。
  //
  // 放在读路径上是安全的，因为判据是「这个租户**一条安装记录都没有**」：
  // 用户手动卸载写的是 enabled=false（行还在），所以卸载过的不会被装回来——
  // 那是他的选择，不能每次打开这一页又给他装上。
  await preinstallBuiltinTemplates(s.tenantId).catch(() => {});

  const [templates, recentRuns, schedules, presets, ws] = await Promise.all([
    listTemplates(s.tenantId),
    prisma.workflowRun.findMany({
      where: { workspaceId: s.workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 8,
      include: { template: { select: { name: true, emoji: true } } },
    }),
    prisma.scheduledAgent.findMany({
      where: { workspaceId: s.workspaceId },
      orderBy: [{ atHour: 'asc' }, { atMinute: 'asc' }],
      include: {
        template: { select: { name: true, emoji: true } },
        // 定时现在能指两种东西，两边都要带出来（名字由 scheduleTargetLabel 统一算）
      },
    }),
    prisma.taskPreset.findMany({
      where: { workspaceId: s.workspaceId },
      orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.workspace.findUnique({ where: { id: s.workspaceId }, select: { agentToolConfig: true } }),
  ]);

  const installed = templates.filter((t) => t.installed);
  const canEdit = can(s.role, 'content.create');

  return (
    <>
      <HubHeader
        title="技能 · 连接器"
        hint={`${AGENT_ROLES.agent.oneLine} · 怎么做由${AGENT_ROLES.agent.decidedBy}`}
        tabs={<RoleTabs active="agent" inline />}
        meta={<span className="small muted hide-mobile">已装 {installed.length} / 市场 {templates.length}</span>}
      />

      {/* 「智能体」这个名字最容易被误解成「它会自己想」。分工梯就摆在页顶，
          让用户当场看清：会思考的是助手，这里的每一条步骤都是写死的 */}

      <WorkflowMarket templates={templates} readOnly={!can(s.role, 'content.create')} />

      {/* 一键任务：排在定时前面。「存一张卡点一下就派」是低门槛的那一步，
          「让它到点自己跑」是下一步——顺序照着用户的接受次序来 */}
      <Card title="一键任务" sub="反复要做的那几件事，存成卡片点一下就派" style={{ marginTop: 16 }}>
        <PresetManager
          presets={presets.map((p) => ({
            id: p.id, title: p.title, goal: p.goal,
            agentTemplateId: p.agentTemplateId,
            authMode: p.authMode,
            preauthorizedTools: parseJson<string[]>(p.preauthorizedTools, []),
            enabled: p.enabled,
          }))}
          agents={templates.filter((t) => t.installed).map((t) => ({
            id: t.id, label: `${t.emoji} ${t.name}`, autonomous: t.mode === 'autonomous',
          }))}
          tools={availableTools(s.role, disabledTools(ws?.agentToolConfig))
            .filter((t) => t.write || t.costly)
            .map((t) => ({ name: t.name, label: t.label, costly: t.costly, contract: t.contract }))}
        />
      </Card>

      {/* 定时：紧跟在市场后面。用户刚看完「有哪些智能体」，下一个问题就是「能不能让它自己跑」 */}
      <Card
        id="schedules"
        title="定时任务"
        sub="让智能体按时自己跑一遍 · 时刻按北京时间 · 睡着时也会花配额，所以有上限与失败自停"
        style={{ marginTop: 16 }}
      >
        <Schedules
          scheduleWorks={backgroundSchedulerRuns()}
          rows={schedules.map((r) => ({
            id: r.id,
            templateName: scheduleTargetLabel(r),
            atHour: r.atHour,
            atMinute: r.atMinute,
            weekdays: parseWeekdays(r.weekdays),
            enabled: r.enabled,
            failStreak: r.failStreak,
            lastRunAt: r.lastRunAt ? fmtDateTime(r.lastRunAt) : null,
            lastStatus: r.lastStatus,
            lastError: r.lastError,
          }))}
          agents={installed.map((t) => ({ id: t.id, name: `${t.emoji} ${t.name}` }))}
          maxSchedules={MAX_RUNS_PER_DAY}
          maxRunsPerDay={MAX_RUNS_PER_DAY}
          autoPauseFails={AUTO_PAUSE_FAILS}
          readOnly={!canEdit}
        />
      </Card>

      {/* 折叠：回看才翻（运行中心有全量）。「一键任务」不折——PresetCards 链着 #presets 锚点，
          收进默认关闭的 Fold 会让跳转落在一个关着的抽屉上（extension 那轮的教训） */}
      <Fold title="最近运行" sub="每一步的结果都留痕：失败时能看出停在哪一步、为什么" note={<span className="small muted">回看才翻</span>}>
        {recentRuns.length === 0 ? (
          <p className="small muted">还没有跑过模板。</p>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {recentRuns.map((r) => {
              const logs = parseJson<StepLog[]>(r.log, []);
              return (
                <div key={r.id} className="small">
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="muted">{fmtDateTime(r.createdAt)}</span>
                    <strong>{scheduleTargetLabel(r)}</strong>
                    <span className={`badge ${r.status === 'done' ? 'badge-green' : r.status === 'failed' ? 'badge-red' : 'badge-gray'}`}>
                      {r.status === 'done' ? '跑完了' : r.status === 'failed' ? '中途停下' : r.status}
                    </span>
                    {/* 来源与运行中心同一套说法：定时/AI 派的标出来，手点的不标。
                        定时那条中途停下意味着「这条计划可能正在连续失败」，跟手点失败不是一回事 */}
                    {TRIGGER_LABEL[r.trigger] && <span className="badge badge-gray">{TRIGGER_LABEL[r.trigger]}</span>}
                  </div>
                  <ol style={{ margin: '4px 0 0', paddingLeft: 20 }}>
                    {logs.map((l, i) => (
                      <li key={i} style={{ color: l.ok ? 'inherit' : 'var(--red)' }}>
                        {l.label} — {l.message}
                      </li>
                    ))}
                  </ol>
                </div>
              );
            })}
          </div>
        )}
      </Fold>
    </>
  );
}
