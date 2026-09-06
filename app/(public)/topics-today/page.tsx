import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db';
import { parseJson } from '@/lib/json';
import { sourceBrandName, TOPIC_SOURCE_LABEL } from '@/lib/constants';
import { evergreenBoard } from '@/lib/topic/sources/evergreen';
import { upcomingNodes } from '@/lib/topic/sources/calendar';
import { PRESET_NICHES, normalizeNiche } from '@/lib/topic/niches';
import { Card, Empty } from '@/components/ui';
import { HubHeader } from '@/components/HubHeader';
import { TrackView } from '@/components/growth/TrackView';
import { getSessionOrNull } from '@/lib/session';
import { getServerLang } from '@/lib/i18n/server';
import { beijingDayKey } from '@/lib/beijing';
import { recordCrawlerHitAsync } from '@/lib/geo/crawler-log';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: '今日选题榜',
  description: '按赛道给出今天可做的选题：跨平台正在扩散的话题 + 不依赖热点的常青题 + 三十天内的流量节点，每条带「为什么是今天」。免登录可看。',
};

// 公开「今日选题榜」（2026-09-05 增长缺口整改）。
//
// 【它是什么】一页可被搜索引擎与 AI 爬虫索引的**有正文的**公开页：此前公开面只有热榜与法务页，
// 而热榜正是「一抓一大把」的那部分。这一页展示的是产品真正的主张——推荐不只来自热点。
//
// 【只读、不打模型、不写库】三段内容全是现成事实：
//   ① 跨平台正在扩散的话题簇（TopicCluster，全租户共享，非敏感）；
//   ② 该赛道的八条常青公式（模板，可 review，不是模型即兴）；
//   ③ 三十天内的节点日历。
// 依赖用户数据的五条来源（抢跑窗口/旧文翻新/跨平台补发/灵感箱/读者提问）这里**不假装有**——
// 页脚如实说：登录后按你的账号算。
export default async function TopicsTodayPage({ searchParams }: { searchParams: Promise<{ niche?: string }> }) {
  try {
    const h = await headers();
    recordCrawlerHitAsync(h.get('user-agent'), '/topics-today');
  } catch { /* 拿不到请求头就不记 */ }
  const sp = await searchParams;
  const [lang, session] = await Promise.all([getServerLang(), getSessionOrNull()]);
  const en = lang === 'en';
  const niche = normalizeNiche(sp.niche);
  const day = beijingDayKey();

  const clusters = await prisma.topicCluster.findMany({
    where: { isSensitive: false },
    orderBy: { heat: 'desc' },
    take: 8,
    select: { id: true, title: true, summary: true, sources: true, heat: true, lifecycle: true },
  });
  const evergreen = evergreenBoard(niche);
  const nodes = upcomingNodes(new Date(), 30).slice(0, 6);

  const life: Record<string, string> = en
    ? { rising: 'rising', peak: 'peak', decay: 'cooling', cooling: 'cooling', faded: 'faded' }
    : { rising: '上升中', peak: '峰值', decay: '降温', cooling: '降温', faded: '已退' };

  return (
    <div className="pub-page">
      <TrackView name="landing_view" meta="topics-today" />
      <HubHeader
        title={en ? `Today’s topics · ${day}` : `今日选题榜 · ${day}`}
        hint={en ? 'Cross-platform spreading topics + evergreen formulas + upcoming calendar nodes. Read-only, no login.' : '跨平台扩散中的话题 + 常青公式 + 三十天内的节点。免登录，只读。'}
      />

      <Card
        title={en ? 'Spreading across platforms right now' : '正在跨平台扩散的话题'}
        sub={en ? 'Same story trending on ≥2 sources. Get there before it reaches your platform.' : '同一件事已在两个以上榜单同时出现——它到你的平台之前，还有一段窗口'}
        style={{ marginBottom: 16 }}
      >
        {clusters.length === 0 ? (
          <Empty icon="📡" text={en ? 'Clustering has not run today yet.' : '今天的话题聚类还没跑过，稍后再来。'} />
        ) : (
          <div className="grid grid-2" style={{ gap: 10 }}>
            {clusters.map((c, i) => {
              const sources = parseJson<string[]>(c.sources, []);
              return (
                <div key={c.id} className="card" style={{ padding: 14, boxShadow: 'none', background: 'var(--surface-2)' }}>
                  <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                    <span className={`rank-num${i < 3 ? ' top' : ''}`}>{i + 1}</span>
                    <div style={{ flex: 1 }}>
                      <b style={{ fontSize: 14 }}>{c.title}</b>
                      {c.summary && <div className="small muted" style={{ marginTop: 4, lineHeight: 1.6 }}>{c.summary}</div>}
                      <div className="row wrap" style={{ gap: 4, marginTop: 8 }}>
                        {sources.map((s) => <span key={s} className="badge badge-gray">{sourceBrandName(s)}</span>)}
                        <span className={`badge ${c.lifecycle === 'peak' ? 'badge-red' : c.lifecycle === 'rising' ? 'badge-green' : 'badge-amber'}`}>{life[c.lifecycle] ?? c.lifecycle}</span>
                      </div>
                      <div className="small muted" style={{ marginTop: 8 }}>
                        {en
                          ? `Why today: on ${sources.length} charts at once, ${life[c.lifecycle] ?? c.lifecycle}.`
                          : `为什么是今天：${sources.length} 个榜单同时在榜，处于「${life[c.lifecycle] ?? c.lifecycle}」阶段。`}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card
        title={en ? `Evergreen formulas · ${niche}` : `常青题 · ${niche}`}
        sub={en ? 'Topics that never depend on trends. Most days have no hot topic; these carry those days.' : '不依赖任何热点的选题。大部分日子是没有热点的，靠这些撑'}
        action={
          <form method="get" className="row" style={{ gap: 6 }}>
            <input className="input" name="niche" defaultValue={niche} maxLength={20} placeholder={en ? 'your niche' : '换成你的赛道词'} style={{ width: 160 }} />
            <button type="submit" className="btn btn-sm">{en ? 'Switch' : '换赛道'}</button>
          </form>
        }
        style={{ marginBottom: 16 }}
      >
        <div className="row wrap" style={{ gap: 6, marginBottom: 12 }}>
          {PRESET_NICHES.map((n) => (
            <Link key={n} href={`/topics-today?niche=${encodeURIComponent(n)}`} className={`badge ${n === niche ? 'badge-brand' : 'badge-gray'}`}>{n}</Link>
          ))}
        </div>
        <div className="grid grid-2" style={{ gap: 10 }}>
          {evergreen.map((e) => (
            <div key={e.key} className="card" style={{ padding: 14, boxShadow: 'none', background: 'var(--surface-2)' }}>
              <b style={{ fontSize: 14 }}>{e.title}</b>
              <div className="small muted" style={{ marginTop: 6, lineHeight: 1.6 }}>{en ? 'Why it lasts: ' : '为什么常青：'}{e.why}</div>
              <span className={`badge ${TOPIC_SOURCE_LABEL.evergreen.badge}`} style={{ marginTop: 8 }}>{en ? TOPIC_SOURCE_LABEL.evergreen.nameEn : TOPIC_SOURCE_LABEL.evergreen.name}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card
        title={en ? 'Calendar nodes in the next 30 days' : '三十天内的流量节点'}
        sub={en ? 'Predictable every year. Win by preparing early.' : '每年确定会来的节点，赢在提前量'}
        style={{ marginBottom: 16 }}
      >
        {nodes.length === 0 ? (
          <div className="small muted">{en ? 'No known node in the next 30 days.' : '未来 30 天没有已登记的节点。'}</div>
        ) : (
          <div className="stack" style={{ gap: 6 }}>
            {nodes.map((n) => (
              <div key={`${n.node.key}-${n.date.toISOString()}`} className="row-between" style={{ gap: 10, padding: '6px 0', borderTop: '1px solid var(--surface-2)' }}>
                <span><b>{n.node.name}</b> <span className="small muted">{n.node.why}</span></span>
                <span className="small muted" style={{ whiteSpace: 'nowrap' }}>{en ? `in ${n.daysUntil} days` : `还有 ${n.daysUntil} 天`}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card style={{ textAlign: 'center' }}>
        <div className="stack" style={{ gap: 8, alignItems: 'center', padding: '8px 0' }}>
          <b>{en ? 'Five more sources need your account' : '还有五条来源，要认识你才算得出'}</b>
          <span className="small muted" style={{ maxWidth: 620, lineHeight: 1.7 }}>
            {en
              ? 'Opportunity gap, revived posts, cross-platform syndication, inspiration box and reader questions all depend on your own data. The wizard gets them running in about ten minutes.'
              : '抢跑窗口、旧文翻新、跨平台补发、灵感箱、读者提问——都要看你的主战平台、你的旧作和你的读者。登录后十分钟的开场向导把它们点亮。'}
          </span>
          <Link href={session ? '/onboarding' : '/login'} className="btn btn-primary btn-sm">{session ? (en ? 'Run the wizard' : '去跑开场向导') : (en ? 'Start free · 30 days Pro' : '免费开始 · 送 30 天标准版')}</Link>
        </div>
      </Card>
    </div>
  );
}
