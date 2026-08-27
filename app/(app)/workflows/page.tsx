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
import { AgentCreateActions } from '@/components/AgentCreateActions';
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

  const [templates, recentRuns, activeRun, schedules, presets, ws] = await Promise.all([
    listTemplates(s.tenantId),
    prisma.workflowRun.findMany({
      where: { workspaceId: s.workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 8,
      include: { template: { select: { name: true, emoji: true } } },
    }),
    // 正在跑的那条手点运行：跳走再回来时，页面要接着盯它——否则组件状态一丢，
    // 「跑一遍」恢复可点，同一条模板会被再派一次（真双跑、双花额度）。
    // 只认 manual：定时/AI 派的有自己的展示面，不该劫持这页的进度卡。
    prisma.workflowRun.findFirst({
      where: { workspaceId: s.workspaceId, status: 'running', trigger: 'manual' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, templateId: true },
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
        action={canEdit ? <AgentCreateActions /> : undefined}
      />

      {/* 「智能体」这个名字最容易被误解成「它会自己想」。分工梯就摆在页顶，
          让用户当场看清：会思考的是助手，这里的每一条步骤都是写死的 */}

      {/* 两列（2026-08-26 用户「分成两列，这样就不会不知道在哪里」）：
          左=班底（有哪些智能体），右=反复要做的事（怎么复用它们）。
          窄屏回落单列（.workflows-cols 的媒体查询）。 */}
      <div className="workflows-cols">
      <div style={{ minWidth: 0 }}>
      <WorkflowMarket
        templates={templates}
        readOnly={!can(s.role, 'content.create')}
        activeRun={activeRun ? { runId: activeRun.id, templateId: activeRun.templateId } : null}
      />
      </div>
      <div style={{ minWidth: 0 }}>

      {/* 2026-08-26 三合一（用户「一键任务、定时任务、最近运行……能融合就融合」）：
          它们是「反复要做的事」一件事的三个面——存一张卡手动点 / 挂上时间自动跑 / 跑过的记录。
          此前三张卡摞着，像三个不同的功能，区别只写在各自 sub 里没人对照着读。
          合成一张卡、三个小节，每节第一句就是它与上一节的区别。 */}
      <Card
        title="反复要做的事"
        sub="存成卡点一下就派 · 挂上时间自动跑 · 都留痕"
        action={
          // 「通过 AI 一键优化」：把整理工作交给执行器——它有 list_ 系工具能翻运行记录，
          // draft_schedule 能起草定时（落库前会停下来要确认，合约不能它一个人签）
          <a
            className="btn btn-sm"
            href={`/assistant?goal=${encodeURIComponent('看看我最近的运行记录和常做的事，把反复出现的活整理成一键任务卡的方案，并建议哪几件值得挂成定时（先列方案给我确认，不要直接建）')}`}
          >
            ✨ 让 AI 帮我配
          </a>
        }
      >
        <div className="row wrap" style={{ gap: 8, alignItems: 'baseline', marginBottom: 4 }}>
          <b className="small">一键任务</b>
          <span className="small muted">手动的那一半：存成卡，想跑的时候点一下就派</span>
        </div>
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

        <div className="divider" />
        {/* id=schedules 留在这个小节上：产物落点 lib/agent/artifacts.ts 与历史通知还指着它 */}
        <div id="schedules" style={{ scrollMarginTop: 80 }}>
          <div className="row wrap" style={{ gap: 8, alignItems: 'baseline', marginBottom: 4 }}>
            <b className="small">定时任务</b>
            <span className="small muted">自动的那一半：挂上时间到点自己跑（北京时间 · 有上限与失败自停）· 新建在页头右上</span>
          </div>
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
        </div>

        <div className="divider" />
        {/* 第三面：跑过的记录。折叠——回看才翻（运行中心有全量） */}
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
      </Card>
      </div>
      </div>
    </>
  );
}
