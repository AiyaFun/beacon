import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/geo/page-seo';
import { itemListJsonLd, breadcrumbJsonLd, hotItemEntries } from '@/lib/geo/item-list';
import { JsonLd } from '@/components/JsonLd';
import { headers } from 'next/headers';
import { recordCrawlerHitAsync } from '@/lib/geo/crawler-log';
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { parseJson } from '@/lib/json';
import { HOT_INGEST_INTERVAL_MINUTES, HOT_SOURCES, sourceBrandName } from '@/lib/constants';
import { relTime } from '@/lib/format';
import { getSessionOrNull } from '@/lib/session';
import { Card, Empty } from '@/components/ui';
import { ActionButton } from '@/components/ActionButton';
import { HotFitAnalyzer, QuickAnalyzeButton } from './HotFitAnalyzer';
import { HotlistPlatformTabs, LifecycleBadge, type HotItemView } from './HotlistPlatformTabs';
import { actIngestHot } from '@/app/(app)/actions';
import { readPersona } from '@/lib/persona';
import { IntelTabs } from '@/components/IntelTabs';
import { HubHeader } from '@/components/HubHeader';

import { getServerLang } from '@/lib/i18n/server';
import { getDictionary } from '@/lib/i18n/dict';

export const dynamic = 'force-dynamic';

// 标题/描述/关键词/canonical 收在 lib/geo/page-seo.ts —— 见那里顶部「为什么收成一处」
export const metadata: Metadata = pageMetadata('/hotlists');

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

  let personaSummary: { name: string; niche?: string; identity?: string; tone?: string } | null = null;
  if (session) {
    const acc = await prisma.creatorAccount.findUnique({
      where: { id: session.accountId },
      select: { name: true, personaCard: true },
    });
    if (acc) {
      const p = readPersona(acc.personaCard);
      personaSummary = {
        name: acc.name,
        niche: p.niche || '',
        identity: p.identity || '',
        tone: p.tone || '',
      };
    }
  }

  const [items, clusters] = await Promise.all([
    prisma.hotItem.findMany({ orderBy: [{ source: 'asc' }, { rank: 'asc' }] }),
    prisma.topicCluster.findMany({ where: { isSensitive: false }, orderBy: { heat: 'desc' }, take: 6 }),
  ]);

  const bySource = new Map<string, typeof items>();
  for (const it of items) {
    if (!bySource.has(it.source)) bySource.set(it.source, []);
    bySource.get(it.source)!.push(it);
  }
  // 【每个源只下发前 N 条】这是一个**公开页**，它此前把库里 1843 条热榜条目**全部**
  // 序列化进 HTML（实测 719KB），而首屏每个平台只显示 10 条、展开也只看得到当前这一个源。
  // 热榜本来就是个 TOP 榜：按 rank 取前 60 条，比第 61 名更靠后的对「今天什么在热」没有信息量。
  // 真实条数照旧由 totalBySource 交给页签徽标——**不拿截断后的数字冒充总数**。
  const PER_SOURCE_CAP = 60;
  const totalBySource: Record<string, number> = {};
  const itemsBySource: Record<string, HotItemView[]> = {};
  for (const src of HOT_SOURCES) {
    totalBySource[src.key] = (bySource.get(src.key) ?? []).length;
    itemsBySource[src.key] = (bySource.get(src.key) ?? []).slice(0, PER_SOURCE_CAP).map((it) => ({
      id: it.id,
      source: it.source,
      title: it.title,
      url: it.url,
      rank: it.rank,
      heat: it.heat,
      lifecycle: it.lifecycle,
      isMock: it.isMock,
    }));
  }
  // 「最近更新」要的是全站最新一次采集：items 按 source/rank 排序，items[0] 只是排序最前那个源的时间，
  // 各源更新时刻不一致时会显示成任意一个源的时间。取全表最大值。
  const lastFetch = items.reduce<Date | undefined>(
    (max, it) => (!max || it.fetchedAt > max ? it.fetchedAt : max),
    undefined,
  );
  const hotOptions = [...new Set(items.map((i) => i.title))].filter(Boolean).slice(0, 40);

  // 提取高热度焦点标签（跨平台共振 + 各平台 Top 1）
  const quickPills: { title: string; heat?: number; tag?: string }[] = [];
  for (const c of clusters.slice(0, 3)) {
    if (c.title && !quickPills.some((p) => p.title === c.title)) {
      quickPills.push({ title: c.title, heat: c.heat, tag: '跨源共振' });
    }
  }
  for (const it of items) {
    if (it.rank === 1 && it.title && !quickPills.some((p) => p.title === it.title)) {
      quickPills.push({ title: it.title, heat: it.heat, tag: it.source });
    }
    if (quickPills.length >= 6) break;
  }

  // ── 结构化数据：把这一页的榜单变成机器能直接摘的清单（2026-09-17）──────────
  //
  // 【为什么是这一页】全站公开可抓的十来个页里，只有这一页和 /topics-today 有真内容。
  // 它们对模型此前是一整团 HTML：读得到字，读不出「这是一个榜单、第一条是什么」。
  // AI 检索要引用一个来源，靠的正是这种能直接摘出条目的结构。
  //
  // 【三道过滤，缺一不可】
  //   · isMock —— 示例数据**绝不能**出现在对外的结构化数据里。它进不了库是一回事，
  //     从这里泄出去是另一回事：引擎会把编的热点当成我们声明的事实（见 beacon-mock-hotitem-leak）。
  //   · 空标题 —— 在 itemListJsonLd 里统一丢弃。
  //   · 条数上限 —— 同在那边，30 条。这段 JSON 会进 HTML，条数就是首屏体积。
  //
  // ⚠️ 零可见输出：<script type="application/ld+json"> 不渲染任何东西。
  // 挑哪些条目、怎么排，判据收在 hotItemEntries 里（含「为什么不能按 rank 全局排序」）。
  const hotEntries = hotItemEntries(items, sourceBrandName);

  return (
    <>
      <JsonLd data={itemListJsonLd(
        '/hotlists',
        `全网热榜聚合 · ${HOT_SOURCES.length} 大平台实时热点`,
        `${HOT_SOURCES.map((s) => sourceBrandName(s.key)).join('、')} 共 ${HOT_SOURCES.length} 个平台的实时热榜，每 ${HOT_INGEST_INTERVAL_MINUTES} 分钟同步一次，自动聚类去重。`,
        hotEntries,
      )} />
      <JsonLd data={breadcrumbJsonLd('/hotlists', '全网热榜')} />
      {/* 紧凑头（2026-08-26 用户「占了比较大的篇幅、每次都像重刷」）：
          标题/页签/新鲜度/采集按钮收进一行；原副标题与两枚说明徽章降为悬停提示。
          三页共用同款头 + loading 骨架，切页签时头部纹丝不动。 */}
      <HubHeader
        title={dict.intel.pageTitle}
        hint={lang === 'en' ? dict.intel.pageHint : `${HOT_SOURCES.length}${dict.intel.pageHint}`}
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
        id="hotfit-card-root"
        style={{ marginBottom: 16 }}
      >
        {isGuest ? (
          <div className="hotfit-container">
            <div className="hotfit-header">
              <div className="hotfit-title-group">
                <div className="hotfit-icon-badge">
                  <span style={{ fontSize: 16 }}>⚡️</span>
                </div>
                <div>
                  <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                    <b className="hotfit-title-text">{dict.intel.fitCardTitle}</b>
                    <span className="badge badge-brand hotfit-radar-pill">{dict.intel.fitRadarBadge}</span>
                  </div>
                  <p className="small muted hotfit-sub-text">{dict.intel.fitCardSub}</p>
                </div>
              </div>
            </div>
            <div style={{ padding: '16px 20px', background: 'var(--surface-2)', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
              <div>
                <b className="small" style={{ color: 'var(--text)' }}>{dict.intel.fitGuestTip}</b>
                <p className="small muted" style={{ marginTop: 4 }}>登录后即可将任意实时热点与您的账号定位无缝结合，智能推导差异化切入点与避坑指南。</p>
              </div>
              <Link href="/login" className="btn btn-primary btn-sm" style={{ padding: '8px 18px', fontWeight: 600 }}>{dict.intel.fitLoginBtn}</Link>
            </div>
          </div>
        ) : (
          <HotFitAnalyzer
            options={hotOptions}
            quickPills={quickPills}
            personaSummary={personaSummary}
          />
        )}
      </Card>

      {clusters.length > 0 && (
        <Card title={dict.intel.clusterTitle} sub={dict.intel.clusterSub} style={{ marginBottom: 16 }}>
          <div className="grid grid-3">
            {clusters.map((c) => {
              const sources = parseJson<string[]>(c.sources, []);
              return (
                <div key={c.id} className="card" style={{ padding: 12, boxShadow: 'none', background: 'var(--surface-2)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 8 }}>
                  <div>
                    <div className="row-between" style={{ alignItems: 'flex-start', gap: 6 }}>
                      <b className="small" style={{ flex: 1 }}>{c.title}</b>
                      <QuickAnalyzeButton topic={c.title} isGuest={isGuest} label={dict.intel.quickAnalyze} />
                    </div>
                    <div className="wrap" style={{ gap: 4, marginTop: 8 }}>
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
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {items.length === 0 ? (
        <Empty icon="🔥" text={isGuest ? dict.intel.emptyHot : dict.intel.emptyHotUser} />
      ) : (
        <HotlistPlatformTabs
          sources={HOT_SOURCES}
          itemsBySource={itemsBySource}
          totalBySource={totalBySource}
          isGuest={isGuest}
          lang={lang}
          dict={{
            mockData: dict.intel.mockData,
            mockItem: dict.intel.mockItem,
            notConnected: dict.intel.notConnected,
            notConnectedGuest: dict.intel.notConnectedGuest,
            openOrigin: dict.intel.openOrigin,
            sources: dict.intel.sources,
          }}
        />
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

