import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { parseJson } from '@/lib/json';
import { TOPIC_DIMENSIONS, TOPIC_STATES, TOPIC_QUEUES, TOPIC_SOURCE_LABEL, platformName } from '@/lib/constants';
import { EVERGREEN_MIN_RESERVE } from '@/lib/topic/sources/evergreen';
import { buildBattleCards, hasBattleContent, formatViews, type BattleCard } from '@/lib/topic/battlecard';
import { BLUE_SEA_BADGE } from '@/lib/topic/bluesea';
import { Card, ScorePill, Empty, Fold } from '@/components/ui';
import { ActionButton } from '@/components/ActionButton';
import { Icon } from '@/components/icons';
import { actGenerate, actReplenishEvergreen } from './actions';
import { TopicActions } from './TopicActions';
import { AcceptedBar } from './AcceptedBar';
import { TopicVotes, type VoteSummary } from './TopicVotes';
import { TopicRescore } from './TopicRescore';
import { SourceReadinessCard } from './SourceReadiness';
import { BulkBar } from './BulkBar';
import { loadReadiness } from '@/lib/topic/readiness';
import { PickTabs } from './PickTabs';
import { InspirationPanel } from '../inspiration/InspirationPanel';
import { AdvisorPanel } from '../advisor/AdvisorPanel';
import { HubHeader } from '@/components/HubHeader';

export const dynamic = 'force-dynamic';

// 页面内展示的四个状态分区
const TABS = [
  { key: 'recommended', name: TOPIC_STATES.recommended },
  { key: 'accepted', name: TOPIC_STATES.accepted },
  { key: 'rejected', name: TOPIC_STATES.rejected },
  { key: 'candidate', name: TOPIC_STATES.candidate },
] as const;

type TopicRow = Awaited<ReturnType<typeof prisma.topicIdea.findMany>>[number];

// 作战卡：只放查库查出来的事实，一条预测都不放（见 lib/topic/battlecard.ts 文件头）。
// 用 <details> 折叠，默认收起——它是「决定要做之后」才需要的信息，
// 摊开在卡片上会把真正要做的判断（切入角 + 证据）淹掉。
function BattleSection({ card }: { card: BattleCard }) {
  return (
    <details style={{ marginTop: 12 }}>
      <summary className="small" style={{ cursor: 'pointer', color: 'var(--brand)' }}>
        作战卡 · 参考样本 / 发布时机 / 竞争密度
      </summary>
      <div className="stack small" style={{ gap: 8, marginTop: 10, paddingLeft: 4 }}>
        {/* 小成本验证建议：只在「这条贵 + 你有做不完的历史」同时成立时才出现，
            所以它出现的时候值得放在最前面看到。 */}
        {card.lightTrial && (
          <div style={{ padding: 8, borderRadius: 8, background: 'var(--surface-2)' }}>
            <span className="muted">小成本验证：</span>
            {card.lightTrial}
          </div>
        )}
        {card.bestSlot && (
          <div>
            <span className="muted">建议时段：</span>
            {card.bestSlot.label}
            <span className="muted">
              （你在这个时段发过 {card.bestSlot.sample} 条，均播 {formatViews(card.bestSlot.avgViews)}）
            </span>
          </div>
        )}
        {card.benchmark && (
          <div>
            <span className="muted">你的水位：</span>
            {platformName(card.benchmark.platform)}近 {card.benchmark.sample} 条均播{' '}
            {formatViews(card.benchmark.avgViews)}，最好一条 {formatViews(card.benchmark.bestViews)}
          </div>
        )}
        <div>
          <span className="muted">竞争密度：</span>
          {card.rivals === 0
            ? '近 72 小时你监控的竞对里没人做同题'
            : `近 72 小时有 ${card.rivals} 条同题竞对作品`}
        </div>
        {card.references.length > 0 && (
          <div>
            <span className="muted">参考样本：</span>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {card.references.map((r, i) => (
                <li key={i} style={{ lineHeight: 1.7 }}>
                  {r.url ? (
                    <a href={r.url} target="_blank" rel="noreferrer noopener">
                      {r.title}
                    </a>
                  ) : (
                    r.title
                  )}
                  <span className="muted">
                    {' '}
                    · {platformName(r.platform)}
                    {r.views > 0 ? ` · ${formatViews(r.views)} 播放` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}

function TopicCard({ t, battle, votes }: { t: TopicRow; battle?: BattleCard; votes?: VoteSummary }) {
  const scores = parseJson<Record<string, number>>(t.scores, {});
  const source = TOPIC_SOURCE_LABEL[t.sourceType] ?? {
    name: t.sourceType,
    badge: 'badge-gray',
    hint: '',
  };
  return (
    <Card style={{ display: 'flex', flexDirection: 'column' }}>
      {/* 标题 + 大分 */}
      <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div className="row wrap" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
            <b style={{ fontSize: 16 }}>{t.title}</b>
            {/* 信任分层：这条推荐是「查库查出证据」还是「AI 凭人设直觉给的」，用户一眼要能分。
                有 evidence（候选源查库查出的事实）＝有据；否则如实标 AI 建议，不装成有依据。 */}
            {t.evidence ? (
              <span className="badge badge-green" title="有站内可观测数据支撑：竞对同题密度、你的历史水位、跨平台扩散等（见下方「为什么推给你」）">有据推荐</span>
            ) : (
              <span className="badge badge-gray" title="这条主要靠人设匹配与热度信号给出，暂无你的账号数据支撑——登记回流数据后推荐会更准">AI 建议</span>
            )}
            {t.isExploration && (
              <span className="badge badge-amber" title="故意放一条不那么稳的，帮你开新赛道">探索位</span>
            )}
            {/* 蓝海标：门槛定得高（0.55），满屏都是就等于没有。
                title 里如实说清它是站内可观测的代理信号，不是搜索指数。 */}
            {(t.blueSea ?? 0) >= BLUE_SEA_BADGE && (
              <span
                className="badge badge-green"
                title="这个话题在榜上活得久、跨平台扩散广，而你监控的同行还没怎么做。依据是站内可观测信号（在榜时长 × 扩散平台数 × 竞对同题密度），不是全网搜索指数。"
              >
                蓝海
              </span>
            )}
          </div>
          <span className={`badge ${source.badge}`} title={source.hint}>
            {source.name}
          </span>
        </div>
        <div style={{ textAlign: 'center', minWidth: 64 }}>
          <div className="stat-value" style={{ fontSize: 30, lineHeight: 1 }}>
            {Math.round(t.totalScore)}
          </div>
          <div className="stat-label" style={{ marginTop: 2 }}>综合分</div>
          {/* mocked 的两种成因必须分开说。原来一律写「未接入真实 AI」，可真机上接着 MiniMax
              也会出现这个标——那是 30s 超时被 Mock 兜底，说成「没接 AI」是把用户往错方向指，
              而且那种情况是**能重试好**的（见 TopicRescore）。 */}
          {t.mocked && (
            t.degraded ? (
              <div
                className="card-sub"
                style={{ marginTop: 4, color: 'var(--amber, #b45309)' }}
                title="这条的 AI 调用失败/超时，已用占位分兜底（自动重试过一次仍未成功）。点「重新评分」可再试。"
              >
                评分未完成
                <TopicRescore topicId={t.id} />
              </div>
            ) : (
              <div className="card-sub" style={{ marginTop: 4 }} title="演示评分：未接入真实 AI，分数仅为占位">
                示例数据
              </div>
            )
          )}
        </div>
      </div>

      {/* 差异化切入角 */}
      <div
        className="row"
        style={{
          gap: 8,
          alignItems: 'flex-start',
          margin: '12px 0',
          padding: 10,
          borderRadius: 8,
          background: 'var(--surface-2)',
        }}
      >
        <Icon.sparkles size={16} className="" />
        <div className="small">
          <span className="muted">差异化切入角：</span>
          <b>{t.angle}</b>
        </div>
      </div>

      {/* 「为什么是你 / 为什么是现在」——候选源查库查出来的事实，不是 AI 推测。
          与切入角分开展示：那句是创意，这句是证据，混在一起用户分不清哪句可信。 */}
      {t.evidence && (
        <div
          className="row"
          style={{
            gap: 8,
            alignItems: 'flex-start',
            marginBottom: 12,
            padding: 10,
            borderRadius: 8,
            border: '1px solid var(--border)',
          }}
        >
          <Icon.check size={16} className="" />
          <div className="small">
            <span className="muted">为什么推给你：</span>
            {t.evidence}
          </div>
        </div>
      )}

      {/* 琥珀色 + 时钟是「时间压力」的视觉语言，只给真有窗口的队列用。
          常青题的提示说的恰恰是「无时效压力」，配上倒计时图标就是自相矛盾的假紧迫感——
          与晨报里同一条规则一致（lib/topic/brief.ts）。 */}
      {t.windowHint && (
        <div
          className={`small${t.queue === 'evergreen' ? ' muted' : ''}`}
          style={{ marginBottom: 12, ...(t.queue === 'evergreen' ? {} : { color: 'var(--amber)' }) }}
        >
          {t.queue === 'evergreen' ? null : <Icon.clock size={13} />} {t.windowHint}
        </div>
      )}

      {/* 六维评分 */}
      <div className="wrap" style={{ gap: 8 }}>
        {TOPIC_DIMENSIONS.map((d) => (
          <ScorePill key={d.key} label={d.name} value={scores[d.key] ?? 0} />
        ))}
      </div>

      {/* 理由 */}
      {t.rationale && (
        <p className="small muted" style={{ marginTop: 12, lineHeight: 1.6 }}>
          {t.rationale}
        </p>
      )}

      {/* 作战卡（有内容才渲染，避免点开是空的） */}
      {hasBattleContent(battle) && <BattleSection card={battle!} />}

      {/* 拒绝原因 */}
      {t.state === 'rejected' && t.rejectReason && (
        <p className="small" style={{ marginTop: 8, color: 'var(--red)' }}>
          <Icon.x size={12} /> 拒绝原因：{t.rejectReason}
        </p>
      )}

      {/* 已推荐才给采纳/拒绝 */}
      {t.state === 'recommended' && (
        <div style={{ marginTop: 'auto', paddingTop: 14 }}>
          <div className="divider" />
          {/* 投票只在多人工作区出现：一个人给自己的选题投票是纯噪声 */}
          {votes && (
            <div style={{ marginBottom: 10 }}>
              <TopicVotes topicId={t.id} votes={votes} />
            </div>
          )}
          <TopicActions topicId={t.id} title={t.title} />
        </div>
      )}
    </Card>
  );
}

export default async function TopicsPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string; view?: string }>;
}) {
  const s = await getSession();
  const sp = await searchParams;

  // 「定选题」三合一（2026-08-25）：灵感箱 /inspiration、选题智囊团 /advisor 并进本页。
  // 顶层 view 参数切换、只渲染当前 tab（同 /data 看效果的早返回模式）——
  // 两个面板各自取数，切到才查；默认视图不为它们多查一行。
  const view = sp.view === 'inspiration' || sp.view === 'advisor' ? sp.view : 'topics';
  if (view !== 'topics') {
    return (
      <>
        <HubHeader
          title="挑选题"
          hint="把情报变成「今天写哪一条」：候选、灵感、专家会诊"
          tabs={<PickTabs active={view} inline />}
        />
        {view === 'inspiration' ? <InspirationPanel /> : <AdvisorPanel />}
      </>
    );
  }

  const active = TABS.some((t) => t.key === sp.state) ? (sp.state as string) : 'recommended';

  const topics = await prisma.topicIdea.findMany({
    where: { accountId: s.accountId },
    orderBy: [{ totalScore: 'desc' }, { createdAt: 'desc' }],
  });

  // 各状态计数
  const counts: Record<string, number> = {};
  for (const t of topics) counts[t.state] = (counts[t.state] ?? 0) + 1;

  // 信任分层排序：有据推荐（evidence 非空）优先展示，同层内保持 DB 的分数降序（stable sort）。
  // 只调整同一分区/队列内的先后，不跨队列搬动——队列本身是排产逻辑，不能被证据有无覆盖。
  const shown = topics
    .filter((t) => t.state === active)
    .sort((a, b) => (a.evidence ? 0 : 1) - (b.evidence ? 0 : 1));
  // 作战卡只给当前分区看得见的那些算——它要扫竞对作品做同题匹配，
  // 对全部历史选题算一遍是白花的钱（而且用户看不到）。
  const battles = await buildBattleCards(s.workspaceId, s.accountId, shown).catch(
    () => new Map<string, BattleCard>(),
  );

  // 团队投票：**只在多人租户里取数与渲染**。一个人给自己的选题投票是纯噪声，
  // 而且会让个人用户以为「不投票就不算数」。单人时整块不出现，也省掉这两次查询。
  // 冷启动引导：八个候选源里有几个真在工作、沉默的怎么解锁。
  // 全是 count / 轻量 select，不进 LLM。失败不该挡住选题页主体。
  const readiness = await loadReadiness(s.workspaceId, s.accountId).catch(() => null);

  const memberCount = await prisma.member.count({ where: { tenantId: s.tenantId, status: 'active' } });
  const voteByTopic = new Map<string, VoteSummary>();
  if (memberCount > 1 && shown.length > 0) {
    const votes = await prisma.topicVote.findMany({
      where: { topicId: { in: shown.map((t) => t.id) } },
      select: { topicId: true, memberId: true, value: true },
    });
    for (const t of shown) voteByTopic.set(t.id, { up: 0, down: 0, mine: null });
    for (const v of votes) {
      const cur = voteByTopic.get(v.topicId);
      if (!cur) continue;
      if (v.value === 'down') cur.down++;
      else cur.up++;
      if (v.memberId === s.memberId) cur.mine = v.value === 'down' ? 'down' : 'up';
    }
  }
  // 「已推荐」按时间队列分组展示：先做哪个是排产问题，不是分数问题（lib/topic/queue.ts）。
  // 其余分区（已采纳/已拒绝/候选）是归档视图，平铺即可。
  const grouped = active === 'recommended';
  const reserve = topics.filter(
    (t) => t.queue === 'evergreen' && (t.state === 'recommended' || t.state === 'candidate'),
  ).length;

  return (
    <>
      <HubHeader
        title="挑选题"
        hint="先海选、再由 AI 精选 · 每条推荐都要说清「为什么是你、为什么是现在」"
        tabs={<PickTabs active="topics" inline />}
        action={
          <ActionButton action={actGenerate} primary loadingText="全流程运行中…">
            生成今日推荐
          </ActionButton>
        }
      />

      {/* 流程说明收进折叠（2026-08-26 用户「把重点内容提前，该缩起来缩起来」）：
          它是「懂一次就够」的机制说明，摊开摆在推荐列表前面，每天都把真正要挑的题
          压到第二屏。三格流程条本体没动——那是真机打磨过的（竖杠换行那次）。 */}
      <Fold title="推荐是怎么选出来的" sub="候选池 → 海选 → AI 精选" note={<span className="small muted">看一次就够</span>}>

        <div className="row wrap" style={{ gap: 8, alignItems: 'center', marginBottom: 12 }}>
          <span className="badge badge-brand">两阶段打分</span>
          <span className="small muted">候选先过一遍粗筛，剩下的才交给 AI 逐条打分</span>
        </div>
        <div className="flow-strip">
          <div className="flow-step">
            <div className="flow-step-head">
              <span className="flow-step-no">1</span>
              <b className="small">候选池</b>
            </div>
            <div className="small">热榜 · 竞对 · 抢跑窗口 · 旧文翻新 · 跨平台补发</div>
          </div>
          <div className="flow-arrow" aria-hidden>→</div>
          <div className="flow-step">
            <div className="flow-step-head">
              <span className="flow-step-no">2</span>
              <b className="small">海选</b>
            </div>
            <div className="small">按热度和人设匹配快速筛一遍</div>
          </div>
          <div className="flow-arrow" aria-hidden>→</div>
          <div className="flow-step">
            <div className="flow-step-head">
              <span className="flow-step-no">3</span>
              <b className="small">AI 精选</b>
            </div>
            <div className="small">六维评分 + 必须给出差异化切入角</div>
          </div>
        </div>
        {/* 候选池那几个自造词的注解放在条外：塞进第 1 格会把它撑成三行，
            三格就不等高了，流程条一歪就不像流程 */}
        <div className="small muted" style={{ marginTop: 10 }}>
          抢跑窗口＝别的平台已经爆了、你的平台还没有；旧文翻新与跨平台补发＝你自己验证过的内容。
        </div>
      </Fold>

      {/* 冷启动引导：沉默的来源够多时才展开，全部解锁后自动缩成一行。
          放在 tab 之前是因为它回答的是「为什么今天的推荐看起来这么普通」——
          那个疑问出现在用户读推荐之前，不是之后。 */}
      {/* 「推荐从哪来」只在**没有推荐**时前置——那时它就是「为什么空着」的答案；
          有推荐时它是背景说明，移到列表后面（见下），别把今天要挑的题压下去 */}
      {shown.length === 0 && readiness && (readiness.cold || readiness.material) && <SourceReadinessCard report={readiness} />}

      {/* 状态分区 tab */}
      <div className="tabs" style={{ marginBottom: 16 }}>
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={t.key === 'recommended' ? '/topics' : `/topics?state=${t.key}`}
            className={`tab${active === t.key ? ' active' : ''}`}
          >
            {t.name}
            <span className="badge badge-gray" style={{ marginLeft: 6 }}>
              {counts[t.key] ?? 0}
            </span>
          </Link>
        ))}
      </div>

      {/* 批量处理：只在「已推荐」分区出现——其余分区是归档视图，没有待处理动作 */}
      {active === 'recommended' && shown.length > 1 && <BulkBar ids={shown.map((t) => t.id)} />}

      {shown.length === 0 ? (
        <Empty
          icon="🎯"
          text={
            active === 'recommended'
              ? '还没有今日推荐——点右上角「生成今日推荐」跑一次全流程'
              : `「${TOPIC_STATES[active as keyof typeof TOPIC_STATES]}」分区暂无选题`
          }
          action={
            active === 'recommended' ? (
              <ActionButton action={actGenerate} primary loadingText="全流程运行中…">
                生成今日推荐
              </ActionButton>
            ) : undefined
          }
        />
      ) : grouped ? (
        TOPIC_QUEUES.map((q) => {
          const list = shown.filter((t) => (t.queue ?? 'today') === q.key);
          const isEvergreen = q.key === 'evergreen';
          // 空队列照常显示标题：「今天没有抢跑窗口」本身就是有用的信息，
          // 整块消失会让用户以为功能坏了或者根本不知道有这一队。
          return (
            <section key={q.key} style={{ marginBottom: 24 }}>
              <div className="row wrap" style={{ gap: 8, alignItems: 'center', marginBottom: 10 }}>
                <b style={{ fontSize: 15 }}>
                  {q.icon} {q.name}
                </b>
                <span className="badge badge-gray">{list.length}</span>
                <span className="small muted">{q.desc}</span>
                {isEvergreen && reserve < EVERGREEN_MIN_RESERVE && (
                  <ActionButton action={actReplenishEvergreen} loadingText="生成中…">
                    补充常青储备
                  </ActionButton>
                )}
              </div>
              {list.length === 0 ? (
                <p className="small muted" style={{ margin: 0 }}>
                  {isEvergreen
                    ? '常青储备是空的——热点断供的日子就靠它，建议先补几条放着。'
                    : '这一队今天没有货。不是出错，是当前候选里没有符合这个时间窗口的选题。'}
                </p>
              ) : (
                <div className="grid grid-2">
                  {list.map((t) => (
                    <TopicCard key={t.id} t={t} battle={battles.get(t.id)} votes={voteByTopic.get(t.id)} />
                  ))}
                </div>
              )}
            </section>
          );
        })
      ) : (
        <div className="grid grid-2">
          {shown.map((t) => (
            <TopicCard key={t.id} t={t} battle={battles.get(t.id)} votes={voteByTopic.get(t.id)} />
          ))}
        </div>
      )}

      {/* 采纳后的落地入口。挂在页面根部这个固定位置，采纳触发的 RSC 重渲染才带不走它
          （挂在卡片里就是一闪即逝——那正是「点采纳后直接跳走」的成因，见 accepted-bus.ts）。 */}
      <AcceptedBar key="accepted-bar" />

      {shown.length > 0 && readiness && (readiness.cold || readiness.material) && (
        <div style={{ marginTop: 16 }}><SourceReadinessCard report={readiness} /></div>
      )}

    </>
  );
}
