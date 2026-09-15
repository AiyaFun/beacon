import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { Card, Fold } from '@/components/ui';
import { can } from '@/lib/rbac';
import { backgroundSchedulerRuns } from '@/lib/jobs/queue';
import { listTemplates, preinstallBuiltinTemplates } from '@/lib/workflow/market';
import { enabledRoutines } from '@/lib/workflow/routines';
import { ledgersByBot } from '@/lib/agent/ledger';
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
import { getServerLang } from '@/lib/i18n/server';
import { getDictionary } from '@/lib/i18n/dict';
import { WorkflowsTwoPanel } from './WorkflowsTwoPanel';
import { ScheduleOps } from './ScheduleOps';
import { AgentOverviewPanel } from './AgentOverviewPanel';
import { agentOverview, agentStatesFor, type AgentStateLite } from '@/lib/agent/overview';
import { parseAgentConfig, isAutonomous } from '@/lib/agent/autonomous';
import { projectOccurrences, summarizeOccurrences, type OccurrenceRule } from '@/lib/workflow/schedule-occurrences';
import { scheduleWhen } from '@/lib/workflow/schedule-format';
import { AGENT_TICK_MINUTES } from '@/lib/jobs/schedule-config';
import { listBindings } from '@/lib/agent/knowledge';
import { agentPerformance } from '@/lib/agent/performance';
import { agentHealth } from '@/lib/health/agents';
import { HealthInbox } from './HealthInbox';
import { listSelectableModels, providerLabel } from '@/lib/llm/selectable';

export const dynamic = 'force-dynamic';

// 工作流模板：把「选题→初稿→技能→封面→配图→发布计划」串成一条可复用的流水线。
// 与技能中心的分工写在页面上，别让用户猜：技能是一步，模板是一串。
export default async function WorkflowsPage({ searchParams }: { searchParams: Promise<{ agent?: string }> }) {
  const s = await getSession();
  // ?agent=<templateId> 打开数字员工档案（query 不是新路由：同一页同一份数据，侧栏入口不变）
  const { agent: agentParam } = await searchParams;
  const lang = await getServerLang();
  const dict = getDictionary(lang);
  const isEn = lang === 'en';
  // 【为什么这里也预装一次】预装本来只挂在「保存人设」那处，于是**存量用户装不上**：
  // 他早就建过人设了，不会再触发一次；不建人设的用户更是永远碰不到。
  // 真机上看到的就是「可用模板 0 / 市场里共 3 条」——三条自带模板对他一条都用不了。
  //
  // 放在读路径上是安全的，因为判据是「这个租户**一条安装记录都没有**」：
  // 用户手动卸载写的是 enabled=false（行还在），所以卸载过的不会被装回来——
  // 那是他的选择，不能每次打开这一页又给他装上。
  // 【不让预装挡住其余五条】预装对**老租户**只是一次 count 后立刻返回，但它原来写在
  // Promise.all 前面，于是那一次往返（生产跨区 32ms）把后面五条查询整体往后推了一跳。
  // 真依赖只有一条：listTemplates 必须在预装之后读，否则新租户第一次打开会看到空市场。
  // 所以让预装与其余五条同时起飞，只把 listTemplates 串在它后面。
  const preinstalled = preinstallBuiltinTemplates(s.tenantId).catch(() => {});

  const [templates, recentRuns, activeRun, schedules, presets, ws] = await Promise.all([
    preinstalled.then(() => listTemplates(s.tenantId)),
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
  // ── 第二批：一次并发 ──
  //
  // 【为什么改】原来这五样是**五段串行 await**：账号 → 可选模型 → 渠道名（还是个 for 里 await
  // 的 N+1）→ 建议定时 → 台账。它们只依赖上面那一批的结果，彼此谁也不等谁。
  // 2026-09-12 在生产上量到 /workflows 全文 1.5~1.8 秒，是全站最慢的一页；
  // 本机 SQLite 每跳 1ms 看不出来，生产每跳都是一次真实网络往返。
  const [accounts, models, modelLabelPairs, routineState, ledgerState] = await Promise.all([
    prisma.creatorAccount.findMany({ where: { workspaceId: s.workspaceId }, select: { id: true, name: true } }),
    // 按任务选模型（2026-09-11）：一键任务卡与定时都能指定走哪条渠道
    listSelectableModels(s.tenantId, lang).catch(() => []),
    // 渠道名：原来在 for 循环里逐个 await，定时条目用了 N 条渠道就是 N 次串行往返
    Promise.all(
      [...new Set(schedules.map((r) => r.providerId).filter((v): v is string => !!v))]
        .map(async (pid) => [pid, await providerLabel(s.tenantId, pid, lang)] as const),
    ),
    // 哪些 bot 的建议定时已经在跑（市场卡上画「已定时」/「开启」）；没后台调度的部署不问
    enabledRoutines(s.workspaceId, templates).catch(() => ({})),
    // 每个已装职能 bot 的台账（盯单/进度/已见条数）：让用户看得见它在盯什么、能改能清
    ledgersByBot(s.workspaceId, templates.filter((t) => t.installed && t.mode === 'autonomous').map((t) => t.slug)).catch(() => ({})),
  ]);
  const modelLabels = new Map<string, string>(modelLabelPairs);
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const presetOf = new Map(presets.map((p) => [p.id, p]));
  const templateOf = new Map(templates.map((t) => [t.id, t]));
  /** 定时到点派什么，给人看的一句话。task 型要带上预设任务，否则会显示成「已经被删了」 */
  const labelOf = (r: { targetKind: string; taskPresetId: string | null; template: { name: string; emoji: string } | null }) =>
    scheduleTargetLabel({ targetKind: r.targetKind, template: r.template, preset: r.taskPresetId ? presetOf.get(r.taskPresetId) ?? null : null });
  /** 跑一次最多烧多少次模型调用：预设任务按智能体的 callBudget（缺省 30），流水线按会花钱的步数 */
  const estCallsOf = (r: { targetKind: string; taskPresetId: string | null; templateId: string | null }): number | null => {
    if (r.targetKind === 'task') {
      const p = r.taskPresetId ? presetOf.get(r.taskPresetId) : null;
      if (!p) return null;
      const t = p.agentTemplateId ? templateOf.get(p.agentTemplateId) : null;
      const cfg = t && isAutonomous(t.mode) ? parseAgentConfig(t.agentConfig) : null;
      return cfg?.callBudget ?? 30;
    }
    const t = r.templateId ? templateOf.get(r.templateId) : null;
    return t ? t.costlySteps : null;
  };

  const canSchedule = backgroundSchedulerRuns();
  const installed = templates.filter((t) => t.installed);
  const canEdit = can(s.role, 'content.create');

  // 数字员工档案 + 列表上的状态（口径只在 lib/agent/overview.ts 一处）
  const [overview, agentStates, health] = await Promise.all([
    agentParam ? agentOverview(s.tenantId, s.workspaceId, agentParam).catch(() => null) : Promise.resolve(null),
    agentStatesFor(s.tenantId, s.workspaceId, installed.map((t) => ({ id: t.id, installed: true }))).catch((): Record<string, AgentStateLite> => ({})),
    // 健康收件箱：六类只读诊断（模型/渠道/执行器/知识/自写工具/定时）
    agentHealth(s.tenantId, s.workspaceId).catch(() => []),
  ]);
  // 档案页附加：知识绑定 + 绩效 + 选择器的候选（最近 40 条资讯、当前账号的素材类型）
  const [bindings, performance, libraryOptions, materialRows] = overview
    ? await Promise.all([
      listBindings(s.workspaceId, overview.id).catch(() => []),
      agentPerformance(s.workspaceId, overview.id),
      prisma.inspirationItem.findMany({ where: { workspaceId: s.workspaceId }, orderBy: { createdAt: 'desc' }, take: 40, select: { id: true, title: true } }),
      prisma.material.findMany({ where: { accountId: s.accountId }, select: { type: true }, distinct: ['type'] }),
    ])
    : [[], null, [], []];

  // 定时运营中心：按规则现算未来 7 天的实例（不落库）
  const OPS_DAYS = 7;
  const rules: OccurrenceRule[] = schedules.map((r) => ({
    id: r.id,
    label: labelOf(r),
    accountId: r.accountId,
    accountName: accountName.get(r.accountId),
    atHour: r.atHour,
    atMinute: r.atMinute,
    weekdays: parseWeekdays(r.weekdays),
    enabled: r.enabled,
    lastRunDay: r.lastRunDay,
    lastStatus: r.lastStatus,
    lastError: r.lastError,
    failStreak: r.failStreak,
    estCalls: estCallsOf(r),
  }));
  const occurrences = canSchedule ? projectOccurrences(rules, new Date(), { days: OPS_DAYS, maxPerDay: MAX_RUNS_PER_DAY, tickMinutes: AGENT_TICK_MINUTES }) : [];
  const opsSummary = summarizeOccurrences(occurrences);

  return (
    <>
      <HubHeader
        title={isEn ? 'Skills & Connectors' : '技能 · 连接器'}
        hint={isEn ? 'Workflows & scheduled tasks · Steps and actions execute deterministically' : `${AGENT_ROLES.agent.oneLine} · 怎么做由${AGENT_ROLES.agent.decidedBy}`}
        tabs={<RoleTabs active="agent" inline />}
        meta={<span className="small muted hide-mobile">{isEn ? `Installed ${installed.length} / Market ${templates.length}` : `已装 ${installed.length} / 市场 ${templates.length}`}</span>}
        action={canEdit ? <AgentCreateActions /> : undefined}
      />

      {overview && performance && (
        <AgentOverviewPanel v={overview} isEn={isEn} readOnly={!canEdit} bindings={bindings} libraryOptions={libraryOptions} materialTypes={materialRows.map((m) => m.type)} performance={performance} />
      )}

      {/* 健康与异常收件箱：有红黄才展开，一切正常时只一行 */}
      <Card
        title={isEn ? 'Health & exceptions' : '健康与异常'}
        sub={isEn ? 'Model · channels · executor · knowledge · custom tools · scheduler — read-only checks with evidence and a fix link' : '模型 · 渠道 · 执行器 · 知识 · 自写工具 · 定时器 — 只读诊断，每条带证据与修复入口'}
      >
        <HealthInbox items={health} />
      </Card>

      {agentParam && !overview && (
        <p className="small muted" style={{ marginBottom: 12 }}>{isEn ? 'That agent does not exist or is not yours.' : '这个智能体不存在，或不属于你的租户。'}</p>
      )}

      {/* 两栏面板：真实的定时计划 + 真实装了的智能体（2026-09-11 起不再有写死的示例） */}
      <WorkflowsTwoPanel
        routines={schedules.map((r) => ({
          id: r.id,
          label: labelOf(r),
          when: scheduleWhen(parseWeekdays(r.weekdays), r.atHour, r.atMinute, lang),
          enabled: r.enabled,
          autoPaused: !r.enabled && r.failStreak >= AUTO_PAUSE_FAILS,
          lastStatus: r.lastStatus,
          lastError: r.lastError,
        }))}
        agents={installed.map((t) => ({
          id: t.id,
          emoji: t.emoji,
          name: t.name,
          meta: t.persona || t.description,
          state: agentStates[t.id]?.state ?? 'available',
          stateReason: agentStates[t.id]?.reason ?? '',
        }))}
        readOnly={!canEdit}
        scheduleWorks={canSchedule}
      />

      {/* 定时运营中心：未来 7 天几点跑什么、会不会撞、有没有错过、最多烧多少 */}
      {canSchedule && (
        <Card
          title={isEn ? `Next ${OPS_DAYS} days` : `未来 ${OPS_DAYS} 天会跑什么`}
          sub={isEn ? 'Projected from rules · Beijing time · Missed / over-cap / overlap flagged · Catch up or skip today' : '按规则现算 · 北京时间 · 标出错过 / 会被上限拦下 / 撞车 · 今天的可以补跑或跳过'}
        >
          <ScheduleOps
            items={occurrences.map((o) => ({
              scheduleId: o.scheduleId, label: o.label, accountName: o.accountName, at: o.at.toISOString(),
              dayKey: o.dayKey, time: o.time, dayOffset: o.dayOffset, flags: o.flags, source: o.source, estCalls: o.estCalls,
            }))}
            paused={schedules.filter((r) => !r.enabled).map((r) => ({
              id: r.id, label: labelOf(r), when: scheduleWhen(parseWeekdays(r.weekdays), r.atHour, r.atMinute, lang),
              autoPaused: r.failStreak >= AUTO_PAUSE_FAILS, lastError: r.lastError,
            }))}
            summary={opsSummary}
            maxPerDay={MAX_RUNS_PER_DAY}
            readOnly={!canEdit}
            days={OPS_DAYS}
          />
        </Card>
      )}

      {/* 进阶管理：智能体流水线市场、一键任务卡、完整定时管理与运行日志 */}
      <details className="surface" style={{ marginTop: 16, borderRadius: 12, border: '1px solid var(--border)', padding: '12px 16px' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13, color: 'var(--text-2)', userSelect: 'none' }}>
          {isEn ? '⚙️ Detailed Workflow Market, Presets & Execution Logs' : '⚙️ 智能体市场流水线、一键任务卡与详细定时设置'}
        </summary>
        <div style={{ marginTop: 16 }}>
          <div className="workflows-cols">
            <div style={{ minWidth: 0 }}>
              <WorkflowMarket
                templates={templates}
                readOnly={!can(s.role, 'content.create')}
                activeRun={activeRun ? { runId: activeRun.id, templateId: activeRun.templateId } : null}
                lang={lang}
                routineState={routineState}
                canSchedule={canSchedule}
                ledgerState={ledgerState}
              />
            </div>
            <div style={{ minWidth: 0 }}>
              <Card
                title={isEn ? 'Recurring Routines' : '反复要做的事'}
                sub={isEn ? 'One-click launch cards · Scheduled triggers · Full audit logs' : '存成卡点一下就派 · 挂上时间自动跑 · 都留痕'}
                action={
                  <a
                    className="btn btn-sm"
                    href={`/assistant?goal=${encodeURIComponent(isEn ? 'Review my recent runs and recurring tasks, draft one-click preset cards and suggest what to schedule (list for confirmation first, do not create directly)' : '看看我最近的运行记录和常做的事，把反复出现的活整理成一键任务卡的方案，并建议哪几件值得挂成定时（先列方案给我确认，不要直接建）')}`}
                  >
                    {isEn ? '✨ Let AI Configure' : '✨ 让 AI 帮我配'}
                  </a>
                }
              >
                <div className="row wrap" style={{ gap: 8, alignItems: 'baseline', marginBottom: 4 }}>
                  <b className="small">{isEn ? 'One-Click Presets' : '一键任务'}</b>
                  <span className="small muted">{isEn ? 'Manual execution: Saved as cards, click once to dispatch anytime' : '手动的那一半：存成卡，想跑的时候点一下就派'}</span>
                </div>
                <PresetManager
                  presets={presets.map((p) => ({
                    id: p.id, title: p.title, goal: p.goal,
                    agentTemplateId: p.agentTemplateId,
                    authMode: p.authMode,
                    preauthorizedTools: parseJson<string[]>(p.preauthorizedTools, []),
                    enabled: p.enabled,
                    providerId: p.providerId,
                  }))}
                  models={models.map((m) => ({ id: m.id, label: m.label, note: m.note }))}
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
                    <b className="small">{isEn ? 'Scheduled Tasks' : '定时任务'}</b>
                    <span className="small muted">{isEn ? 'Automated execution: Runs on schedule (Beijing Time · Rate-limited with auto-pause on failure)' : '自动的那一半：挂上时间到点自己跑（北京时间 · 有上限与失败自停）· 新建在页头右上'}</span>
                  </div>
                  <Schedules
                    scheduleWorks={backgroundSchedulerRuns()}
                    rows={schedules.map((r) => ({
                      id: r.id,
                      templateName: labelOf(r),
                      atHour: r.atHour,
                      atMinute: r.atMinute,
                      weekdays: parseWeekdays(r.weekdays),
                      enabled: r.enabled,
                      failStreak: r.failStreak,
                      lastRunAt: r.lastRunAt ? fmtDateTime(r.lastRunAt) : null,
                      lastStatus: r.lastStatus,
                      lastError: r.lastError,
                      providerId: r.providerId,
                      modelLabel: r.providerId ? (modelLabels.get(r.providerId) ?? r.providerId) : (isEn ? 'Auto' : '自动'),
                    }))}
                    models={models.map((m) => ({ id: m.id, label: m.label }))}
                    agents={installed.map((t) => ({ id: t.id, name: `${t.emoji} ${t.name}` }))}
                    maxSchedules={MAX_RUNS_PER_DAY}
                    maxRunsPerDay={MAX_RUNS_PER_DAY}
                    autoPauseFails={AUTO_PAUSE_FAILS}
                    readOnly={!canEdit}
                  />
                </div>

                <div className="divider" />
                {/* 第三面：跑过的记录。折叠——回看才翻（运行中心有全量） */}
                <Fold
                  title={isEn ? 'Recent Runs' : '最近运行'}
                  sub={isEn ? 'Step-by-step logs: clearly see where and why tasks stopped' : '每一步的结果都留痕：失败时能看出停在哪一步、为什么'}
                  note={<span className="small muted">{isEn ? 'Audit history' : '回看才翻'}</span>}
                >
                  {recentRuns.length === 0 ? (
                    <p className="small muted">{isEn ? 'No template runs yet.' : '还没有跑过模板。'}</p>
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
                                {r.status === 'done' ? (isEn ? 'Completed' : '跑完了') : r.status === 'failed' ? (isEn ? 'Failed' : '中途停下') : r.status}
                              </span>
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
        </div>
      </details>
    </>
  );
}
