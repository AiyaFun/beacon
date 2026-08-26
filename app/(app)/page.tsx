import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { parseJson, type Metrics } from '@/lib/json';
import { readPersona, personaCompleteness, isPersonaBlank } from '@/lib/persona';
import { fmtNum, fmtDateLong } from '@/lib/format';
import { TOPIC_DIMENSIONS, HOT_SOURCES } from '@/lib/constants';
import { Card, Stat, Meter, Empty } from '@/components/ui';
import { ActionButton } from '@/components/ActionButton';
import { TaskList } from '@/components/TaskList';
import { AdviceCard } from '@/components/AdviceCard';
import { TrialProgressCard } from '@/components/TrialProgressCard';
import { Icon } from '@/components/icons';
import { loadReadiness } from '@/lib/topic/readiness';
import { currentShell } from '@/lib/shell-server';
import { listRuns, KIND_LABEL } from '@/lib/runs';
import { TaskDeckHome } from '@/components/TaskDeckHome';
import { PresetCards } from '@/components/PresetCards';
import { availableTools } from '@/lib/agent/run';
import { disabledTools } from '@/lib/agent/tool-config';
import { trialProgress } from '@/lib/pay/trial';
import { buildBattleReport } from '@/lib/battle/report';
import { BattleReport } from '@/components/BattleReport';
import { actGenerateRecommendations, actCrawlCompetitors } from './actions';
import { HubHeader } from '@/components/HubHeader';

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const s = await getSession();
  const shell = await currentShell();
  const taskdeck = shell === 'taskdeck';
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
  const activeRuns = taskdeck
    ? (await listRuns(s.workspaceId, { takePerKind: 8 }))
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
        }))
    : [];

  // 派发卡要用的动作清单。与助手页同一个来源（availableTools），按角色与工作区开关过滤过。
  // **只在任务台下算**：工作台首页不渲染派活框，白查一次工具配置没有意义。
  const authTools = taskdeck
    ? availableTools(s.role, disabledTools((await prisma.workspace.findUnique({
        where: { id: s.workspaceId }, select: { agentToolConfig: true },
      }))?.agentToolConfig))
        .filter((t) => t.write || t.costly)
        .map((t) => ({ name: t.name, label: t.label, costly: t.costly, contract: t.contract }))
    : [];

  // 一键任务卡。**只在任务台下查**——工作台首页不渲染派活区，白查一次没意义
  const presetCards = taskdeck
    ? await (async () => {
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
      })()
    : [];

  const persona = readPersona(account?.personaCard ?? '{}');
  const completeness = personaCompleteness(persona);
  // 人设完全空白时不再用小字提醒，改为页顶醒目引导卡（见下方 JSX）
  const personaBlank = isPersonaBlank(persona);
  const totalViews = publishRecords.reduce((sum, r) => sum + (parseJson<Metrics>(r.metrics, {}).views ?? 0), 0);
  const acceptedCount = await prisma.topicIdea.count({ where: { accountId: s.accountId, state: { in: ['accepted', 'drafting'] } } });

  // 任务台首页第一屏就是本周作战报告。**只在任务台下查**——工作台首页不渲染它，
  // 白查表现/竞对四处没意义（渲染主体与 /battle 页共用 components/BattleReport）。
  const battleReport = taskdeck ? await buildBattleReport(s.workspaceId, s.accountId) : null;

  const suggestions = [
    !personaBlank && completeness < 80 ? `人设卡完善度 ${completeness}%，补齐"不能做"清单能让选题更精准。` : null,
    // 人设空白时页头渲染的是「先建人设」，右上角**没有**「生成今日推荐」这个按钮
    // （见下方 PageHead 的 personaBlank 分支）。照着指一个不存在的按钮，是每个新注册用户
    // 第一眼就会撞上的错——文案必须跟着那个分支走。
    topics.length === 0
      ? personaBlank
        ? '先花 1 分钟建人设——建完右上角才会出现「生成今日推荐」，AI 也才知道该往谁头上匹配热点。'
        : '还没有今日推荐——点右上角「生成今日推荐」跑一次全流程。'
      : `今日有 ${topics.length} 条推荐选题，挑 1 条今天就开拍。`,
    '发布后记得回"数据看板"登记表现，推荐会越来越准。',
  ].filter(Boolean) as string[];

  return (
    <>
      {/* 任务台：说一句话就能派活的输入框必须是**上屏第一眼**，而不是四张统计卡之后。
          下面「今日概览」那一整套一个板块都没少——只是排在派活之后（首页形态差异，
          不是功能差异；两种外壳的**路由级功能**仍然完全对等）。 */}
      {taskdeck && (
        <TaskDeckHome memberName={s.memberName} initialActive={activeRuns} authorizableTools={authTools} />
      )}
      {taskdeck && presetCards.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <PresetCards presets={presetCards} />
        </div>
      )}

      {taskdeck ? (
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
      ) : (
      <HubHeader
        title="今日概览"
        hint={`${fmtDateLong(new Date())} · 欢迎回来，${s.memberName}`}
        action={
          <div className="row" style={{ gap: 8 }}>
            {/* 还没添加任何竞对时，「采集竞对」无事可做，不渲染 */}
            {competitors > 0 && (
              <ActionButton action={actCrawlCompetitors} loadingText="采集中…">采集竞对</ActionButton>
            )}
            {personaBlank ? (
              <a href="/persona" className="btn btn-sm btn-primary">先建人设（1 分钟）→</a>
            ) : (
              <ActionButton action={actGenerateRecommendations} primary loadingText={['正在采集热榜…', '正在聚类分析…', '正在 AI 精选推荐…']}>生成今日推荐</ActionButton>
            )}
          </div>
        }
      />
      )}

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
      {taskdeck && battleReport ? (
        <BattleReport report={battleReport} personaBlank={personaBlank} />
      ) : (
        <>
      {/* 本周作战入口：工作台首页每天必看，放这儿提高这个新功能被用到的概率。
          有待起稿选题才显示——没有就不占位（首页已经够满）。 */}
      {recommendedCount > 0 && (
        <Link href="/battle" className="battle-entry" style={{ marginBottom: 16 }}>
          <div className="battle-entry-ic">🔥</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <b>本周作战 · {recommendedCount} 条高潜选题待起稿</b>
            <div className="small" style={{ marginTop: 2, opacity: 0.9 }}>
              {topics[0] ? `头一条「${topics[0].title}」` : '按人设排好优先级'}——打开就能就地起稿，一路做到发布
            </div>
          </div>
          <span className="battle-entry-cta">打开本周作战 →</span>
        </Link>
      )}

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="全平台总播放" value={fmtNum(totalViews)} foot="已回填数据合计" href="/data" />
        <Stat label="监控竞对" value={competitors} foot="跨平台对标账号" href="/competitors" />
        <Stat
          label="生效记忆条数"
          value={memories}
          foot={newMemories > 0 ? `近 7 天 +${newMemories} · 越用越懂你` : '账号大脑越用越懂'}
          href="/persona"
        />
        <Stat label="已采纳待拍" value={acceptedCount} foot="进入创作队列" href="/topics" />
      </div>

      <div className="grid-asym-1.6-1" style={{ marginBottom: 16 }}>
        <Card title="今日推荐 Top3" sub="AI 按人设 + 热点挑的" action={<Link href="/topics" className="btn btn-sm btn-ghost">全部 →</Link>}>
          {topics.length === 0 ? (
            <Empty
              icon="🎯"
              text={
                personaBlank
                  ? '还没有推荐——先建人设，右上角才会出现「生成今日推荐」'
                  : '还没有推荐——点右上角「生成今日推荐」'
              }
            />
          ) : (
            <div className="stack">
              {topics.map((t, i) => {
                const scores = parseJson<Record<string, number>>(t.scores, {});
                return (
                  <div key={t.id} className="card" style={{ padding: 14, boxShadow: 'none', background: 'var(--surface-2)' }}>
                    <div className="row-between">
                      <div className="row" style={{ gap: 8 }}>
                        <span className="rank-num top">{i + 1}</span>
                        <b>{t.title}</b>
                      </div>
                      <span className="row" style={{ gap: 6, alignItems: 'center' }}>
                        {/* 与选题页同口径：mocked 的两种成因说法不同（见 topics/page.tsx） */}
                        {t.mocked && (
                          t.degraded ? (
                            <span
                              className="card-sub"
                              style={{ color: 'var(--amber, #b45309)' }}
                              title="这条的 AI 调用失败/超时，已用占位分兜底。到选题引擎可单条重新评分。"
                            >
                              评分未完成
                            </span>
                          ) : (
                            <span className="card-sub" title="演示评分：未接入真实 AI，分数仅为占位">示例数据</span>
                          )
                        )}
                        <span className="badge badge-brand">{t.totalScore}分</span>
                      </span>
                    </div>
                    <div className="small muted" style={{ margin: '6px 0 8px' }}>
                      <Icon.sparkles size={13} /> 切入角：{t.angle}
                    </div>
                    <div className="wrap" style={{ gap: 6 }}>
                      {TOPIC_DIMENSIONS.slice(0, 4).map((d) => (
                        <span key={d.key} className="badge badge-gray">{d.name} {scores[d.key] ?? '—'}</span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {!personaBlank && (
            <div className="row-between small" style={{ marginTop: 10, padding: '8px 12px', background: 'var(--surface-2)', borderRadius: 8 }}>
              <span className="muted">{readiness.active}/{readiness.total} 个来源在为你工作</span>
              <a href="/topics" style={{ fontSize: 13 }}>看怎么解锁 →</a>
            </div>
          )}
        </Card>

        <Card title="今日建议" sub="AI 看了你的数据 · 点右上角可 LLM 生成">
          <AdviceCard
            initialSuggestions={suggestions}
            context={{
              completeness,
              topicCount: topics.length,
              publishCount: publishRecords.length,
              acceptedCount,
              memoryCount: memories,
              competitorCount: competitors,
            }}
          />
          <div className="divider" />
          <div className="row-between">
            <span className="small muted">人设完善度</span>
            <span className="small"><b>{completeness}%</b></span>
          </div>
          <div style={{ marginTop: 6 }}><Meter value={completeness} /></div>
          {!personaBlank && (
            <Link href="/persona" className="btn btn-sm btn-ghost" style={{ marginTop: 10 }}>完善人设 →</Link>
          )}
        </Card>
      </div>
        </>
      )}

      {/* 任务清单与快速入口只给工作台：任务台首页 = 派活框 + 作战报告，
          到此为止——快速入口和侧栏/抽屉重复，任务清单与报告的「今天该做什么」重复，
          留着只是把第一屏往下拖（2026-08-26 用户反馈「整体页面不要太复杂」）。 */}
      {!taskdeck && (
      <div className="grid grid-2">
        <Card title="任务清单" sub="自己加，做完打勾">
          <TaskList tasks={tasks} />
        </Card>
        <Card title="快速入口">
          <div className="grid grid-2" style={{ gap: 10 }}>
            <QuickLink href="/hotlists" icon="fire" label="热点聚合" desc={`${HOT_SOURCES.length} 源热榜`} />
            <QuickLink href="/topics?view=advisor" icon="users" label="选题智囊团" desc="12 人物会诊" />
            <QuickLink href="/algorithm" icon="gauge" label="算法教练" desc="分平台优化" />
            <QuickLink href="/compliance" icon="shield" label="合规检测" desc={`${sensitiveCount} 词库`} />
          </div>
        </Card>
      </div>
      )}
    </>
  );
}

function QuickLink({ href, icon, label, desc }: { href: string; icon: keyof typeof Icon; label: string; desc: string }) {
  const IconCmp = Icon[icon];
  return (
    <Link href={href} className="card card-hover" style={{ padding: 14, boxShadow: 'none', background: 'var(--surface-2)', display: 'block' }}>
      <div className="row" style={{ gap: 8, color: 'var(--brand)' }}>
        <IconCmp size={17} /> <b style={{ color: 'var(--text)' }}>{label}</b>
      </div>
      <div className="small muted" style={{ marginTop: 4 }}>{desc}</div>
    </Link>
  );
}
