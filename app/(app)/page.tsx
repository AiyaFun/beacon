import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { parseJson, type Metrics } from '@/lib/json';
import { readPersona, personaCompleteness, isPersonaBlank } from '@/lib/persona';
import { fmtNum } from '@/lib/format';
import { TOPIC_DIMENSIONS, HOT_SOURCES } from '@/lib/constants';
import { PageHead, Card, Stat, Meter, Empty } from '@/components/ui';
import { ActionButton } from '@/components/ActionButton';
import { TaskList } from '@/components/TaskList';
import { AdviceCard } from '@/components/AdviceCard';
import { TrialProgressCard } from '@/components/TrialProgressCard';
import { Icon } from '@/components/icons';
import { loadReadiness } from '@/lib/topic/readiness';
import { trialProgress } from '@/lib/pay/trial';
import { actGenerateRecommendations, actCrawlCompetitors } from './actions';

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const s = await getSession();
  const [account, topics, tasks, publishRecords, competitors, memories, sensitiveCount, readiness, tenant, newMemories] = await Promise.all([
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
  ]);

  // 试用运营节奏：仅在「试用中且未过期」时得到 isTrial=true（纯函数，见 lib/pay/trial.ts）
  const trial = trialProgress(tenant?.plan, tenant?.planExpiresAt);

  const persona = readPersona(account?.personaCard ?? '{}');
  const completeness = personaCompleteness(persona);
  // 人设完全空白时不再用小字提醒，改为页顶醒目引导卡（见下方 JSX）
  const personaBlank = isPersonaBlank(persona);
  const totalViews = publishRecords.reduce((sum, r) => sum + (parseJson<Metrics>(r.metrics, {}).views ?? 0), 0);
  const acceptedCount = await prisma.topicIdea.count({ where: { accountId: s.accountId, state: { in: ['accepted', 'drafting'] } } });

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
      <PageHead
        title="今日概览"
        desc={`${new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })} · 欢迎回来，${s.memberName}`}
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

      <div className="grid grid-2">
        <Card title="任务清单" sub="自己加，做完打勾">
          <TaskList tasks={tasks} />
        </Card>
        <Card title="快速入口">
          <div className="grid grid-2" style={{ gap: 10 }}>
            <QuickLink href="/hotlists" icon="fire" label="热点聚合" desc={`${HOT_SOURCES.length} 源热榜`} />
            <QuickLink href="/advisor" icon="users" label="选题智囊团" desc="12 人物会诊" />
            <QuickLink href="/algorithm" icon="gauge" label="算法教练" desc="分平台优化" />
            <QuickLink href="/compliance" icon="shield" label="合规检测" desc={`${sensitiveCount} 词库`} />
          </div>
        </Card>
      </div>
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
