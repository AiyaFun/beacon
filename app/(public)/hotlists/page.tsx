import Link from 'next/link';
import { prisma } from '@/lib/db';
import { parseJson } from '@/lib/json';
import { HOT_SOURCES } from '@/lib/constants';
import { fmtNum, relTime } from '@/lib/format';
import { getSessionOrNull } from '@/lib/session';
import { PageHead, Card, Empty } from '@/components/ui';
import { ActionButton } from '@/components/ActionButton';
import { HotFitAnalyzer } from './HotFitAnalyzer';
import { actIngestHot } from '@/app/(app)/actions';
import { IntelTabs } from '@/components/IntelTabs';
import { HubHeader } from '@/components/HubHeader';

export const dynamic = 'force-dynamic';

// 热点聚合中心：登录用户可「重新采集 / 账号×热点结合分析」；游客只读浏览公开热榜（演示页）。
// 🔒 游客路径**绝不触发任何 llmComplete / 写操作**：结合分析（烧 LLM）与重新采集（写库+外部采集）
// 只对登录用户渲染；对应 server action 也各自 getSession()+requireRole 自守卫，双保险。
export default async function HotlistsPage() {
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
        title="看情报"
        hint={`${HOT_SOURCES.length} 个平台的热榜一站看全 · 主源断了自动切备用 · 公开榜单 60 秒更新 · 部分榜单需另接数据源`}
        tabs={<IntelTabs active="hot" inline />}
        meta={<span className="small muted hide-mobile">新鲜度：{lastFetch ? relTime(lastFetch) : '未采集'}</span>}
        action={
          isGuest ? (
            <Link href="/login" className="btn btn-primary btn-sm">登录后可采集</Link>
          ) : (
            <ActionButton action={actIngestHot} primary loadingText="采集中…">重新采集</ActionButton>
          )
        }
      />

      <Card
        title="账号 × 热点 结合分析"
        sub="选一个实时热点，看它跟你的账号怎么结合"
        style={{ marginBottom: 16 }}
      >
        {isGuest ? (
          <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="small muted">用 AI 把实时热点结合到你的账号人设、给出差异化切入角与制作建议。</span>
            <Link href="/login" className="btn btn-primary btn-sm">登录 / 注册后体验</Link>
          </div>
        ) : (
          <HotFitAnalyzer options={hotOptions} />
        )}
      </Card>

      {clusters.length > 0 && (
        <Card title="跨源热点聚类" sub="多平台同时升温 = 更强的选题信号" style={{ marginBottom: 16 }}>
          <div className="grid grid-3">
            {clusters.map((c) => {
              const sources = parseJson<string[]>(c.sources, []);
              return (
                <div key={c.id} className="card" style={{ padding: 12, boxShadow: 'none', background: 'var(--surface-2)' }}>
                  <b className="small">{c.title}</b>
                  <div className="wrap" style={{ gap: 4, marginTop: 6 }}>
                    {sources.map((src) => (
                      <span key={src} className="badge badge-gray">{HOT_SOURCES.find((h) => h.key === src)?.name ?? src}</span>
                    ))}
                    <LifecycleBadge stage={c.lifecycle} />
                    <span className="badge badge-brand">热度 {Math.round(c.heat)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {items.length === 0 ? (
        <Empty icon="🔥" text={isGuest ? '暂无热榜数据' : '还没有热榜数据，点右上角「重新采集」'} />
      ) : (
        <div className="grid grid-3">
          {HOT_SOURCES.map((src) => {
            const list = bySource.get(src.key) ?? [];
            // 整块徽标只在**全部**是示例时才挂——这没错，但它单独用就有个洞：
            // 板块里只要混进一条真数据，剩下的假词条就一个标都没有了（真机 2026-07-30 的百度榜）。
            // 所以逐条也要标：板块徽标回答「这块能不能信」，行内徽标回答「这条能不能信」。
            const allMock = list.length > 0 && list.every((i) => i.isMock);
            return (
              <Card key={src.key} title={src.name} sub={allMock ? '示例数据' : src.beta ? 'beta' : undefined}>
                {list.length === 0 ? (
                  <div className="small muted">{isGuest ? '暂未接入' : '未接入 · 点重新采集或配置数据源'}</div>
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
                            {/* 整块没挂徽标时，逐条标出混在真数据里的示例词条 */}
                            {it.isMock && !allMock && (
                              <span
                                className="badge badge-gray"
                                style={{ marginLeft: 6 }}
                                title="该平台暂无真实采集通道，这条是占位示例，不参与选题推荐"
                              >
                                示例
                              </span>
                            )}
                          </span>
                          <LifecycleBadge stage={it.lifecycle} />
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
                          title="打开热点原文"
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
            <b>注册即送 30 天标准版</b>
            <span className="small muted">热点结合分析、选题打分、AI 创作、合规检测、跨平台适配——登录后全部解锁。</span>
            <Link href="/login" className="btn btn-primary btn-sm">免费开始</Link>
          </div>
        </Card>
      )}
    </>
  );
}

const LIFECYCLE_STYLE: Record<string, { cls: string; label: string }> = {
  rising: { cls: 'badge-green', label: '上升' },
  peak: { cls: 'badge-red', label: '峰值' },
  cooling: { cls: 'badge-amber', label: '降温' },
  faded: { cls: 'badge-gray', label: '已退' },
};

function LifecycleBadge({ stage }: { stage: string }) {
  const s = LIFECYCLE_STYLE[stage];
  if (!s) return null;
  return <span className={`badge ${s.cls}`} style={{ fontSize: 10, padding: '1px 5px' }}>{s.label}</span>;
}
