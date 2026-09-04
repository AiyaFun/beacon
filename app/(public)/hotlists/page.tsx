import { headers } from 'next/headers';
import { recordCrawlerHitAsync } from '@/lib/geo/crawler-log';
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { parseJson } from '@/lib/json';
import { HOT_SOURCES } from '@/lib/constants';
import { fmtNum, relTime } from '@/lib/format';
import { getSessionOrNull } from '@/lib/session';
import { Card, Empty } from '@/components/ui';
import { ActionButton } from '@/components/ActionButton';
import { HotFitAnalyzer } from './HotFitAnalyzer';
import { actIngestHot } from '@/app/(app)/actions';
import { IntelTabs } from '@/components/IntelTabs';
import { HubHeader } from '@/components/HubHeader';

import { getServerLang } from '@/lib/i18n/server';
import { getDictionary } from '@/lib/i18n/dict';

export const dynamic = 'force-dynamic';

// 热点聚合中心：登录用户可「重新采集 / 账号×热点结合分析」；游客只读浏览公开热榜（演示页）。
export default async function HotlistsPage() {
  try {
    const h = await headers();
    recordCrawlerHitAsync(h.get('user-agent'), '/hotlists');
  } catch { /* 拿不到请求头就不记，绝不影响这一页 */ }

  const lang = await getServerLang();
  const dict = getDictionary(lang);

  const session = await getSessionOrNull();
  const isGuest = !session;

  const [items, clusters] = await Promise.all([
    prisma.hotItem.findMany({ orderBy: [{ source: 'asc' }, { rank: 'asc' }] }),
    prisma.topicCluster.findMany({ where: { isSensitive: false }, orderBy: { heat: 'desc' }, take: 6 }),
  ]);

  const bySource = new Map<string, typeof items>();
  for (const it of items) {
    if (!bySource.has(it.source)) bySource.set(it.source, []);
    bySource.get(it.source)!.push(it);
  }
  const lastFetch = items[0]?.fetchedAt;
  const hotOptions = [...new Set(items.map((i) => i.title))].filter(Boolean).slice(0, 40);

  return (
    <>
      {/* 紧凑头（2026-08-26 用户「占了比较大的篇幅、每次都像重刷」）：
          标题/页签/新鲜度/采集按钮收进一行；原副标题与两枚说明徽章降为悬停提示。
          三页共用同款头 + loading 骨架，切页签时头部纹丝不动。 */}
      <HubHeader
        title={dict.intel.pageTitle}
        hint={lang === 'en' ? dict.intel.pageHint : `${HOT_SOURCES.length} 个平台的热榜一站看全 · 主源断了自动切备用 · 公开榜单 60 秒更新 · 部分榜单需另接数据源`}
        tabs={<IntelTabs active="hot" inline />}
        meta={<span className="small muted hide-mobile">{dict.intel.freshness}{lastFetch ? relTime(lastFetch) : dict.intel.notIngested}</span>}
        action={
          isGuest ? (
            <Link href="/login" className="btn btn-primary btn-sm">{dict.intel.loginToFetch}</Link>
          ) : (
            <ActionButton action={actIngestHot} primary loadingText={dict.intel.fetching}>{dict.intel.reFetch}</ActionButton>
          )
        }
      />

      <Card
        title={dict.intel.fitCardTitle}
        sub={dict.intel.fitCardSub}
        style={{ marginBottom: 16 }}
      >
        {isGuest ? (
          <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="small muted">{dict.intel.fitGuestTip}</span>
            <Link href="/login" className="btn btn-primary btn-sm">{dict.intel.fitLoginBtn}</Link>
          </div>
        ) : (
          <HotFitAnalyzer options={hotOptions} />
        )}
      </Card>

      {clusters.length > 0 && (
        <Card title={dict.intel.clusterTitle} sub={dict.intel.clusterSub} style={{ marginBottom: 16 }}>
          <div className="grid grid-3">
            {clusters.map((c) => {
              const sources = parseJson<string[]>(c.sources, []);
              return (
                <div key={c.id} className="card" style={{ padding: 12, boxShadow: 'none', background: 'var(--surface-2)' }}>
                  <b className="small">{c.title}</b>
                  <div className="wrap" style={{ gap: 4, marginTop: 6 }}>
                    {sources.map((src) => (
                      <span key={src} className="badge badge-gray">
                        {lang === 'en' && dict.intel.sources[src as keyof typeof dict.intel.sources]
                          ? dict.intel.sources[src as keyof typeof dict.intel.sources]
                          : (HOT_SOURCES.find((h) => h.key === src)?.name ?? src)}
                      </span>
                    ))}
                    <LifecycleBadge stage={c.lifecycle} lang={lang} />
                    <span className="badge badge-brand">{dict.intel.heat} {Math.round(c.heat)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {items.length === 0 ? (
        <Empty icon="🔥" text={isGuest ? dict.intel.emptyHot : dict.intel.emptyHotUser} />
      ) : (
        <div className="grid grid-3">
          {HOT_SOURCES.map((src) => {
            const list = bySource.get(src.key) ?? [];
            const allMock = list.length > 0 && list.every((i) => i.isMock);
            const sourceName = lang === 'en' && dict.intel.sources[src.key as keyof typeof dict.intel.sources]
              ? dict.intel.sources[src.key as keyof typeof dict.intel.sources]
              : src.name;
            return (
              <Card key={src.key} title={sourceName} sub={allMock ? dict.intel.mockData : src.beta ? 'beta' : undefined}>
                {list.length === 0 ? (
                  <div className="small muted">{isGuest ? dict.intel.notConnectedGuest : dict.intel.notConnected}</div>
                ) : (
                  <div>
                    {list.slice(0, 8).map((it) => {
                      const clickable = !!it.url && it.url !== '#';
                      const inner = (
                        <>
                          <span className={`rank-num${it.rank <= 3 ? ' top' : ''}`}>{it.rank}</span>
                          <span className="small" style={{ flex: 1 }}>
                            {it.title}
                            {clickable && <span className="muted" style={{ marginLeft: 4 }}>↗</span>}
                            {it.isMock && !allMock && (
                              <span
                                className="badge badge-gray"
                                style={{ marginLeft: 6 }}
                                title="该平台暂无真实采集通道，这条是占位示例，不参与选题推荐"
                              >
                                {dict.intel.mockItem}
                              </span>
                            )}
                          </span>
                          <LifecycleBadge stage={it.lifecycle} lang={lang} />
                          {it.heat > 0 && <span className="small muted">{fmtNum(it.heat)}</span>}
                        </>
                      );
                      return clickable ? (
                        <a
                          key={it.id}
                          href={it.url!}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="list-row"
                          style={{ textDecoration: 'none', color: 'inherit' }}
                          title={dict.intel.openOrigin}
                        >
                          {inner}
                        </a>
                      ) : (
                        <div key={it.id} className="list-row">{inner}</div>
                      );
                    })}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {isGuest && (
        <Card style={{ marginTop: 16, textAlign: 'center' }}>
          <div className="stack" style={{ gap: 8, alignItems: 'center', padding: '8px 0' }}>
            <b>{lang === 'en' ? 'Get 30 Days Free Pro Access' : '注册即送 30 天标准版'}</b>
            <span className="small muted">
              {lang === 'en'
                ? 'Topic matching, AI creation, compliance check and multi-platform publishing — all unlocked after login.'
                : '热点结合分析、选题打分、AI 创作、合规检测、跨平台适配——登录后全部解锁。'}
            </span>
            <Link href="/login" className="btn btn-primary btn-sm">{lang === 'en' ? 'Start Free' : '免费开始'}</Link>
          </div>
        </Card>
      )}
    </>
  );
}

const LIFECYCLE_STYLE: Record<string, { cls: string; label: string; en: string }> = {
  rising: { cls: 'badge-green', label: '上升', en: 'Rising' },
  peak: { cls: 'badge-red', label: '峰值', en: 'Peak' },
  cooling: { cls: 'badge-amber', label: '降温', en: 'Cooling' },
  faded: { cls: 'badge-gray', label: '已退', en: 'Faded' },
};

function LifecycleBadge({ stage, lang }: { stage: string; lang?: string }) {
  const s = LIFECYCLE_STYLE[stage];
  if (!s) return null;
  const label = lang === 'en' ? s.en : s.label;
  return <span className={`badge ${s.cls}`} style={{ fontSize: 10, padding: '1px 5px' }}>{label}</span>;
}
