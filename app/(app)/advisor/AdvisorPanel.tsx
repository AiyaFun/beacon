import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { relTime } from '@/lib/format';
import { ACCOUNT_HEALTH_DIMENSIONS } from '@/lib/constants';
import { Card, Meter, ScorePill, Empty } from '@/components/ui';
import { Icon } from '@/components/icons';
import { accountHealth, sixDimScorecard, ensureAdvisorPersonas, MAX_ENABLED_PERSONAS } from '@/lib/advisor/panel';
import { VerdictButtons } from './VerdictButtons';
import { ConveneForm } from './ConveneForm';
import { WeakDimConvene } from './WeakDimConvene';
import { PanelManager, type PanelPersona } from './PanelManager';
import { getServerLang } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';

const TRIGGER_LABEL: Record<string, string> = {
  manual: '主动召唤',
  cold_start: '冷启动',
  repeated_reject: '连续被拒',
  draft_review: '草稿会诊',
};

export async function AdvisorPanel() {
  const s = await getSession();
  const lang = await getServerLang();

  const [account, ownPosts, publishRecords, session, personas] = await Promise.all([
    prisma.creatorAccount.findUnique({ where: { id: s.accountId } }),
    prisma.ownPost.findMany({ where: { accountId: s.accountId } }),
    prisma.publishRecord.findMany({ where: { accountId: s.accountId } }),
    prisma.advisorSession.findFirst({
      where: { accountId: s.accountId },
      orderBy: { createdAt: 'desc' },
      include: { opinions: { orderBy: { createdAt: 'asc' } } },
    }),
    ensureAdvisorPersonas(s.accountId),
  ]);

  const health = accountHealth(account, ownPosts, publishRecords);
  const card = sixDimScorecard(health);

  // 人物 key → 配置（emoji/权重），供意见卡展示；找不到（人物已删）按 role 兜底
  const personaMap = new Map(personas.map((p) => [p.key, p]));
  const personaEmoji = (key: string, role: string) =>
    personaMap.get(key)?.emoji ?? (role === 'audience' ? '🧑' : '🧠');
  const personaWeight = (key: string) => personaMap.get(key)?.weight ?? 1;
  const enabledCount = personas.filter((p) => p.enabled).length;
  const panelSize = Math.min(enabledCount, MAX_ENABLED_PERSONAS);

  const opinions = session?.opinions ?? [];
  const byWeight = (a: { personaKey: string }, b: { personaKey: string }) =>
    personaWeight(b.personaKey) - personaWeight(a.personaKey);
  const audienceOpinions = opinions.filter((o) => o.personaRole === 'audience').sort(byWeight);
  const expertOpinions = opinions.filter((o) => o.personaRole === 'expert').sort(byWeight);
  const adoptedCount = opinions.filter((o) => o.adopted === true).length;
  const rejectedCount = opinions.filter((o) => o.adopted === false).length;
  const pendingCount = opinions.filter((o) => o.adopted === null).length;

  return (
    <>
      <div className="row-between wrap" style={{ gap: 10, marginBottom: 14 }}>
        <span className="small muted">
          {lang === 'en'
            ? `${panelSize} persona council · Audience reaction & expert evaluation`
            : `${panelSize} 位人物混编会诊 · 受众侧模拟第一反应，专家侧做多维把关 · 采纳/否决驱动人物成长`}
        </span>
        <ConveneForm panelSize={panelSize} />
      </div>

      <Card
        sub={lang === 'en' ? 'When to use' : '什么时候用'}
        title={lang === 'en' ? 'Trigger Scenarios' : '触发场景'}
        style={{ marginBottom: 16 }}
      >
        <div className="grid grid-3">
          <TriggerHint
            icon="bulb"
            title={lang === 'en' ? 'Out of Ideas' : '没头绪 / 没灵感'}
            desc={lang === 'en' ? 'Refresh angles across 12 diverse expert perspectives.' : '推荐流刷了几天都没想做的，让 12 个脑子重新发散一次。'}
          />
          <TriggerHint
            icon="sparkles"
            title={lang === 'en' ? 'Cold Start' : '新账号冷启动'}
            desc={lang === 'en' ? 'Define direction for the first 10 seed posts without historical data.' : '还没有历史内容，先把前 10 条的方向定下来。'}
          />
          <TriggerHint
            icon="refresh"
            title={lang === 'en' ? 'Repeated Rejections' : '选题连续被拒'}
            desc={lang === 'en' ? 'Time to change lenses and find differentiated hooks.' : '最近推荐你都不满意，说明该换一批视角重新会诊。'}
          />
        </div>
        <div className="divider" />
        <div className="small muted">
          <Icon.shield size={13} />{' '}
          {lang === 'en'
            ? 'Council verdicts feedback into persona weights. Accepted angles automatically flow into the topic bank.'
            : '会诊结果（采纳/否决）会写入账号记忆并反哺人物权重——常被采纳的人物在下次会诊里说话更算数。被采纳的提案会自动进入选题池。'}
        </div>
      </Card>

      <Card
        title={lang === 'en' ? 'Advisor Council Personas' : '智囊团人物管理'}
        sub={lang === 'en' ? 'Custom roles · Self-learning from adoption' : '身份自定义 · 采纳/否决自学习'}
        style={{ marginBottom: 16 }}
        action={<span className="badge badge-brand">{lang === 'en' ? `${enabledCount} active` : `启用 ${enabledCount} 席`}</span>}
      >
        <PanelManager
          personas={personas.map((p) => ({
            id: p.id,
            key: p.key,
            name: p.name,
            role: p.role,
            emoji: p.emoji,
            stance: p.stance,
            focus: p.focus,
            source: p.source,
            enabled: p.enabled,
            weight: p.weight,
            adoptedCount: p.adoptedCount,
            rejectedCount: p.rejectedCount,
            learnedNotes: p.learnedNotes,
          })) as PanelPersona[]}
          maxEnabled={MAX_ENABLED_PERSONAS}
        />
      </Card>

      <Card
        title={lang === 'en' ? 'Account Health Audit' : '账号项目体检报告'}
        sub={lang === 'en' ? '6 Dimensions · Data-driven + Heuristic' : '六维 · 基于真实数据 + 启发式'}
        style={{ marginBottom: 16 }}
        action={<span className="badge badge-brand">{lang === 'en' ? `Score ${card.total}` : `综合 ${card.total} 分`}</span>}
      >
        <div className="grid grid-6" style={{ marginBottom: 14 }}>
          {ACCOUNT_HEALTH_DIMENSIONS.map((d) => (
            <ScorePill key={d.key} label={d.name} value={health[d.key] ?? 0} />
          ))}
        </div>

        <div className="stack" style={{ gap: 10 }}>
          {ACCOUNT_HEALTH_DIMENSIONS.map((d) => (
            <div key={d.key} className="row" style={{ gap: 12, alignItems: 'center' }}>
              <span className="small" style={{ width: 96, flexShrink: 0 }}>{d.name}</span>
              <div style={{ flex: 1 }}>
                <Meter value={health[d.key] ?? 0} />
              </div>
              <span className="small mono" style={{ width: 34, textAlign: 'right' }}>{health[d.key] ?? 0}</span>
            </div>
          ))}
        </div>

        <div className="divider" />
        <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
          <span style={{ color: 'var(--brand)', marginTop: 2 }}>
            <Icon.gauge size={16} />
          </span>
          <span className="small">{card.verdict}</span>
        </div>
        {/* P1-7 体检联动：把「建议就这一维召开专项会诊」从文案变成一键动作 */}
        <div style={{ marginTop: 10 }}>
          <WeakDimConvene dimName={card.weakest.name} score={card.weakest.score} />
        </div>
      </Card>

      <Card
        title="最近一次会诊"
        sub={session ? `${TRIGGER_LABEL[session.trigger] ?? session.trigger} · ${relTime(session.createdAt)}` : undefined}
        action={
          opinions.length > 0 ? (
            <span className="row wrap" style={{ gap: 6 }}>
              <span className="badge badge-green">采纳 {adoptedCount}</span>
              <span className="badge badge-gray">否决 {rejectedCount}</span>
              <span className="badge badge-amber">待定 {pendingCount}</span>
            </span>
          ) : undefined
        }
      >
        {opinions.length === 0 ? (
          <Empty
            icon="🧑‍⚖️"
            text="还没有会诊记录——点右上角「召集智囊团」，12 位人物会各自给你一条选题方向。"
          />
        ) : (
          <>
            {session?.summary && (
              <div className="small muted" style={{ marginBottom: 14 }}>
                <Icon.sparkles size={13} /> {session.summary}
              </div>
            )}

            <div className="row" style={{ gap: 8, marginBottom: 10 }}>
              <span className="badge badge-brand">受众侧 {audienceOpinions.length} 席</span>
              <span className="small muted">谁在看你 · 第一反应模拟</span>
            </div>
            <div className="grid grid-3" style={{ marginBottom: 16 }}>
              {audienceOpinions.map((o) => (
                <OpinionCard key={o.id} o={o} emoji={personaEmoji(o.personaKey, o.personaRole)} weight={personaWeight(o.personaKey)} />
              ))}
            </div>

            <div className="row" style={{ gap: 8, marginBottom: 10 }}>
              <span className="badge badge-accent">专家侧 {expertOpinions.length} 席</span>
              <span className="small muted">算法 / 爆款 / 变现 / 合规 / 数据 / 竞对</span>
            </div>
            <div className="grid grid-3">
              {expertOpinions.map((o) => (
                <OpinionCard key={o.id} o={o} emoji={personaEmoji(o.personaKey, o.personaRole)} weight={personaWeight(o.personaKey)} />
              ))}
            </div>
          </>
        )}
      </Card>
    </>
  );
}

function TriggerHint({ icon, title, desc }: { icon: keyof typeof Icon; title: string; desc: string }) {
  const IconCmp = Icon[icon];
  return (
    <div className="card" style={{ padding: 12, boxShadow: 'none', background: 'var(--surface-2)' }}>
      <div className="row" style={{ gap: 8, color: 'var(--brand)' }}>
        <IconCmp size={16} /> <b className="small" style={{ color: 'var(--text)' }}>{title}</b>
      </div>
      <div className="small muted" style={{ marginTop: 6 }}>{desc}</div>
    </div>
  );
}

function OpinionCard({
  o,
  emoji,
  weight,
}: {
  o: {
    id: string;
    personaKey: string;
    personaName: string;
    personaRole: string;
    stance: string;
    suggestion: string;
    rationale: string | null;
    adopted: boolean | null;
  };
  emoji: string;
  weight: number;
}) {
  const isAudience = o.personaRole === 'audience';
  return (
    <div className="card" style={{ padding: 14, boxShadow: 'none', background: 'var(--surface-2)', display: 'flex', flexDirection: 'column' }}>
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <span className="persona-avatar" style={{ fontSize: 22 }}>{emoji}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row-between">
            <b className="small">{o.personaName}</b>
            <span className="row" style={{ gap: 4 }}>
              {weight !== 1 && (
                <span className="badge badge-gray" title="自学习出的说话分量">×{weight.toFixed(2)}</span>
              )}
              <span className={`badge ${isAudience ? 'badge-brand' : 'badge-accent'}`}>
                {isAudience ? '受众' : '专家'}
              </span>
            </span>
          </div>
          <div className="small muted" style={{ marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {o.stance}
          </div>
        </div>
      </div>

      <div className="small" style={{ margin: '10px 0 6px', flex: 1 }}>
        <div className="row" style={{ gap: 6, alignItems: 'flex-start' }}>
          <span style={{ color: 'var(--brand)', marginTop: 1 }}>
            <Icon.bulb size={13} />
          </span>
          <b>{o.suggestion}</b>
        </div>
        {o.rationale && (
          <div className="small muted" style={{ marginTop: 6 }}>{o.rationale}</div>
        )}
      </div>

      <div className="divider" style={{ margin: '10px 0' }} />
      <VerdictButtons opinionId={o.id} adopted={o.adopted} />
    </div>
  );
}
