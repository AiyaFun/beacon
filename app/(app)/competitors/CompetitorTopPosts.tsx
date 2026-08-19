'use client';

import { useState, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { parseJson, engagementRate, type Metrics } from '@/lib/json';
import { heatForSort } from '@/lib/insight/heat';
import { displayKeys, absenceNote } from '@/lib/insight/platform-metrics';
import { platformName, platformColor } from '@/lib/constants';
import { fmtNum, fmtDate } from '@/lib/format';
import { Icon } from '@/components/icons';
import { CompetitorTrendCell } from './CompetitorTrendCell';
import { beijingDayKey } from '@/lib/beijing';

type CompetitorPost = {
  id: string;
  title: string;
  url: string | null;
  platform: string;
  metrics: string;
  hotScore: number;
  publishedAt: Date | string | null;
  competitor: {
    name: string;
    handle: string;
    platform: string;
  };
};

type SnapItem = { takenAt: Date | string; metrics: string; source?: string | null };

const PLATFORM_EMOJI: Record<string, string> = {
  douyin: '🎵',
  xiaohongshu: '📕',
  wechat: '💬',
  bilibili: '📺',
  x: '✖️',
  youtube: '▶️',
  tiktok: '🎶',
};

type TimeRangeKey = 'all' | '24h' | '7d' | '30d';
// 'hot' 改成 'interaction'：原来的 hot 按 hotScore（= views/20000）排，
// 没有播放量的平台恒为 0，排序等于随机。见 lib/insight/heat.ts。
type SortKey = 'interaction' | 'views' | 'engagement' | 'growth';
type ViewModeKey = 'cards' | 'table';

/** 这条作品在当前时间窗内的增长（服务端算好传下来，口径同增长卡）。 */
export type PostGrowth = {
  status: 'ok' | 'no-data' | 'single-point';
  delta: Record<string, number | undefined>;
  points: number;
};

// 榜上摆哪些绝对数。**全是真实采到的量**，没采到的项自己不出现。
const METRIC_CHIPS = [
  { key: 'views', icon: '▶️', title: '播放/阅读量' },
  { key: 'likes', icon: '👍', title: '点赞量' },
  { key: 'comments', icon: '💬', title: '评论量' },
  { key: 'collects', icon: '⭐', title: '收藏量' },
  { key: 'shares', icon: '🔁', title: '转发量' },
  { key: 'coins', icon: '🪙', title: '投币数（B站）' },
  { key: 'danmaku', icon: '🎬', title: '弹幕数（B站）' },
] as const;

/** 卡片行上按顺序考虑的指标键（平台没有的会被 displayKeys 滤掉）。 */
const CHIP_KEYS = ['views', 'likes', 'comments', 'collects', 'shares', 'coins', 'danmaku'] as const;

/** 增长优先展示的指标：有播放量看播放，没有就看点赞——都答「这条还在不在涨」。 */
const GROWTH_PRIORITY = ['views', 'likes', 'comments', 'collects', 'shares'] as const;

/**
 * 领奖台要显示的三格：按优先级挑**真的采到**的指标，不足三项就少显示几格。
 * 互动率只在算得出来（有播放量）时才够格入选。
 */
function podiumCells(p: {
  views: number; likes: number; comments: number; collects: number; shares: number;
  rate: number | null; interaction: number;
}): { lbl: string; val: string; hot: boolean }[] {
  const cells: { lbl: string; val: string; hot: boolean }[] = [];
  const push = (lbl: string, v: number) => { if (v > 0) cells.push({ lbl, val: fmtNum(v), hot: false }); };
  push('播放量', p.views);
  push('点赞', p.likes);
  push('评论', p.comments);
  push('收藏', p.collects);
  push('转发', p.shares);
  // 用同一个 pctOrNull 走格式化：文件里只留一条百分比路径，
  // 也避免绕过「不许无条件 toFixed」那条守卫（见 tests/algorithm/no-views-platforms.test.ts）
  if (p.rate !== null) cells.push({ lbl: '互动率', val: pctOrNull(p.rate) ?? NA_TEXT, hot: p.rate > 0.03 });
  // 一项都没采到时，至少把互动量摆出来（它自己会是 —）
  if (cells.length === 0 && p.interaction >= 0) cells.push({ lbl: '互动量', val: fmtNum(p.interaction), hot: false });
  return cells.slice(0, 3);
}

function GrowthChip({ g, label }: { g?: PostGrowth; label: string }) {
  if (!g || g.status !== 'ok') return null;
  for (const k of GROWTH_PRIORITY) {
    const d = g.delta[k];
    if (typeof d !== 'number' || d === 0) continue;
    const name = METRIC_CHIPS.find((c) => c.key === k)?.title.replace(/[（(].*$/, '') ?? k;
    return (
      <span
        className="metric-chip"
        style={{ color: d > 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}
        title={`近 ${label}${name}净增（两次采集之间的差值）`}
      >
        {d > 0 ? '↑' : '↓'} {fmtNum(Math.abs(d))} {name}
      </span>
    );
  }
  return null;
}

// 「这项算不出来」的统一占位。抖音这类平台的公开页面不给播放量，
// 于是互动率/赞播比这些以播放为分母的指标一律不可得——
// 表格里必须留个位置说明「没有」，而不是填一个 0.0% 冒充观测值。
const NA_TEXT = '—';
const NA_TITLE = '该平台公开页面不提供播放量，这项算不出来（点赞/评论/收藏/转发是真实采到的）';
/** 比率 → 百分比文本；null 表示算不出来，返回 null 让调用方决定是留白还是画占位。 */
const pctOrNull = (x: number | null): string | null => (x === null ? null : `${(x * 100).toFixed(1)}%`);

export function CompetitorTopPosts({
  topPosts,
  snapsByPostMap,
  postGrowth,
  windowLabel,
}: {
  topPosts: CompetitorPost[];
  snapsByPostMap: Record<string, SnapItem[]>;
  /** 每条作品在当前时间窗内的增长，服务端算好（口径与增长卡一致） */
  postGrowth: Record<string, PostGrowth>;
  windowLabel: string;
}) {
  const [timeRange, setTimeRange] = useState<TimeRangeKey>('all');
  const [sortBy, setSortBy] = useState<SortKey>('interaction');
  const [viewMode, setViewMode] = useState<ViewModeKey>('cards');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // 逐条算出展示所需的量：真实绝对数 + 互动量（排序用）+ 互动率（有播放量才有）
  const postsWithAnalysis = useMemo(() => {
    const now = Date.now();
    return topPosts.map((p) => {
      const m = parseJson<Metrics>(p.metrics, {});
      const views = m.views ?? 0;
      const likes = m.likes ?? 0;
      const comments = m.comments ?? 0;
      const collects = m.collects ?? 0;
      const shares = m.shares ?? 0;
      const coins = m.coins ?? 0;
      const danmaku = m.danmaku ?? 0;

      // ⚠️ 这四项都可能**算不出来**，算不出来一律 null 而不是 0。
      // 抖音（以及一切公开页不给播放量的平台）上：播放量根本没有 → 互动率、赞播比是 null；
      // 主页只采到点赞、没采到评论 → 评赞比也是 null。
      // 从前这里一律给 0，页面就照着渲染出「互动率 0.0%」「赞播比 0.0%」——
      // 那不是「这条作品互动差」，是我们把「没这项数据」写成了「这项数据是零」。
      const rate = engagementRate(m);
      // 互动量：榜的默认排序口径。每个平台都拿得到（至少有点赞），
      // 不像 hotScore 那样在没有播放量的平台上恒为 0。
      const interaction = heatForSort(m);

      // 评估增速 (基于最新两次快照的播放/增量)
      const snaps = snapsByPostMap[p.id] || [];
      let growthDelta = 0;
      if (snaps.length >= 2) {
        const lastSnap = parseJson<Metrics>(snaps[snaps.length - 1].metrics, {});
        const prevSnap = parseJson<Metrics>(snaps[snaps.length - 2].metrics, {});
        growthDelta = (lastSnap.views ?? 0) - (prevSnap.views ?? 0);
      }

      // 计算发布时间跨度
      const pubTime = p.publishedAt ? new Date(p.publishedAt).getTime() : 0;
      const ageHours = pubTime > 0 ? Math.max(1, (now - pubTime) / 3600000) : 9999;

      // 清理标题
      const cleanTitle = p.title.replace(/^【[^】]+】\s*/, '');

      return {
        ...p,
        cleanTitle,
        m,
        views,
        likes,
        comments,
        collects,
        shares,
        coins,
        danmaku,
        rate,
        interaction,
        growth: postGrowth[p.id],
        growthDelta,
        ageHours,
        snaps,
      };
    });
  }, [topPosts, snapsByPostMap, postGrowth]);

  // 时间维度过滤 + 搜索过滤
  const filteredPosts = useMemo(() => {
    return postsWithAnalysis.filter((p) => {
      // 时间过滤
      if (timeRange === '24h' && p.ageHours > 24) return false;
      if (timeRange === '7d' && p.ageHours > 24 * 7) return false;
      if (timeRange === '30d' && p.ageHours > 24 * 30) return false;

      // 搜索过滤
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const matchTitle = p.cleanTitle.toLowerCase().includes(q);
        const matchAuthor = p.competitor.name.toLowerCase().includes(q);
        if (!matchTitle && !matchAuthor) return false;
      }

      return true;
    });
  }, [postsWithAnalysis, timeRange, searchQuery]);

  // 排序逻辑
  const sortedPosts = useMemo(() => {
    const list = [...filteredPosts];
    list.sort((a, b) => {
      if (sortBy === 'views') return b.views - a.views;
      // 按互动率排序时，算不出来的排在最后（而不是当成 0 混在「互动率最低」那一堆里——
      // 那会让用户以为抖音这些作品是「互动垫底」，其实只是没有播放量这个分母）
      if (sortBy === 'engagement') return (b.rate ?? -1) - (a.rate ?? -1);
      if (sortBy === 'growth') return b.growthDelta - a.growthDelta;
      return b.interaction - a.interaction; // 默认：互动量（赞+评+藏+转）
    });
    return list;
  }, [filteredPosts, sortBy]);

  // 选框控制
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === sortedPosts.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(sortedPosts.map((p) => p.id)));
    }
  };

  // CSV 导出功能
  const exportCSV = () => {
    if (sortedPosts.length === 0) return;
    const headers = ['排名', '平台', '作品标题', '创作者', '播放量', '点赞量', '评论量', '收藏量', '转发量', '互动量', '互动率', '发布时间'];
    const rows = sortedPosts.map((p, idx) => [
      idx + 1,
      platformName(p.platform),
      `"${p.cleanTitle.replace(/"/g, '""')}"`,
      `"${p.competitor.name.replace(/"/g, '""')}"`,
      // 播放量拿不到就导出空格，不导 0——导成 0 的表格发给别人，对方无从分辨
      // 「这条真没人看」和「这个平台不给播放量」
      p.views > 0 ? p.views : '',
      p.likes,
      p.comments,
      p.collects,
      p.shares,
      p.interaction < 0 ? '' : p.interaction,
      p.rate === null ? '' : `${(p.rate * 100).toFixed(2)}%`,
      p.publishedAt ? fmtDate(p.publishedAt) : '未记录',
    ]);
    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `高热作品榜单_${beijingDayKey()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (topPosts.length === 0) {
    return (
      <div className="empty-state" style={{ padding: '48px 20px', textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>📊</div>
        <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 6 }}>还没有采集到对标作品</div>
        <div className="small muted">添加对标账号后，点击“采集竞对”即可在此实时呈现全网高热作品榜单。</div>
      </div>
    );
  }

  const maxViews = Math.max(...sortedPosts.map((p) => p.views || 1), 1);

  // 分离 Top 3 (当在卡片模式且不筛选过多时呈现 Podium 颁奖台)
  const showPodium = viewMode === 'cards' && sortedPosts.length >= 3 && !searchQuery;
  const top3 = showPodium ? sortedPosts.slice(0, 3) : [];
  const remainingPosts = showPodium ? sortedPosts.slice(3) : sortedPosts;

  return (
    <div className="stack" style={{ gap: 14 }}>
      {/* 1. 多维控制工具栏 (时间范围 + 排序维度 + 搜索 + 视图切换) */}
      <div
        className="leaderboard-toolbar"
        style={{
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding: '12px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        {/* 工具栏第一行：过滤切片 & 视图模式 */}
        <div className="row-between wrap" style={{ gap: 10 }}>
          {/* 时间范围 Filter Tabs */}
          <div className="row wrap" style={{ gap: 4, alignItems: 'center' }}>
            <span className="small muted" style={{ marginRight: 4, fontWeight: 600 }}>
              <Icon.clock size={13} style={{ display: 'inline', verticalAlign: '-2px' }} /> 时间:
            </span>
            {(
              [
                ['all', '全部'],
                ['24h', '⚡ 24h 飙升'],
                ['7d', '📅 7天高热'],
                ['30d', '🗓️ 30天爆款'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                className={`filter-btn ${timeRange === key ? 'active' : ''}`}
                onClick={() => setTimeRange(key)}
              >
                {label}
              </button>
            ))}
          </div>

          {/* 视图切换按钮 */}
          <div className="row" style={{ gap: 4 }}>
            <button
              className={`view-toggle-btn ${viewMode === 'cards' ? 'active' : ''}`}
              onClick={() => setViewMode('cards')}
              title="切换为精致爆款卡片视图"
            >
              🖼️ 卡片视图
            </button>
            <button
              className={`view-toggle-btn ${viewMode === 'table' ? 'active' : ''}`}
              onClick={() => setViewMode('table')}
              title="切换为高密度表格视图"
            >
              📊 紧凑表格
            </button>
          </div>
        </div>

        {/* 工具栏第二行：排序规则 + 搜索框 + 导出 */}
        <div className="row-between wrap" style={{ gap: 10 }}>
          {/* 排序 Mode Pills */}
          <div className="row wrap" style={{ gap: 4, alignItems: 'center' }}>
            <span className="small muted" style={{ marginRight: 4, fontWeight: 600 }}>
              <Icon.fire size={13} style={{ display: 'inline', verticalAlign: '-2px' }} /> 排序:
            </span>
            {(
              [
                ['interaction', '🔥 互动量'],
                ['views', '👁️ 播放总量'],
                ['engagement', '⚡ 互动率'],
                ['growth', '🚀 飙升增速'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                className={`sort-pill ${sortBy === key ? 'active' : ''}`}
                onClick={() => setSortBy(key)}
              >
                {label}
              </button>
            ))}
          </div>

          {/* 搜索框 & 导出 CSV */}
          <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
            <div className="search-input-wrap">
              <Icon.pen size={12} className="search-icon" />
              <input
                type="text"
                placeholder="搜索爆款标题或创作者..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="search-input"
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery('')} className="clear-btn">
                  ×
                </button>
              )}
            </div>

            <button onClick={exportCSV} className="btn btn-sm btn-ghost" title="导出当前榜单 CSV 文件">
              <Icon.download size={13} />
              <span>导出 CSV</span>
            </button>
          </div>
        </div>

        {/* 榜单结果小结 & 批量勾选工具条 */}
        <div
          className="row-between wrap small muted"
          style={{ paddingTop: 6, borderTop: '1px dashed var(--border)' }}
        >
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <span>
              已筛选 <b style={{ color: 'var(--brand)' }}>{sortedPosts.length}</b> 条作品 (全量 {topPosts.length} 条)
            </span>
            {selectedIds.size > 0 && (
              <span className="badge badge-brand" style={{ fontWeight: 600 }}>
                已勾选 {selectedIds.size} 项
              </span>
            )}
          </div>

          {selectedIds.size > 0 && (
            <div className="row" style={{ gap: 8 }}>
              <Link
                href={`/topics?source=${encodeURIComponent(
                  sortedPosts
                    .filter((p) => selectedIds.has(p.id))
                    .map((p) => p.cleanTitle)
                    .join(' | ')
                )}`}
                className="btn btn-sm btn-primary"
                style={{ fontSize: 11, padding: '2px 10px', borderRadius: 12 }}
              >
                <Icon.sparkles size={12} />
                <span>批量转选题 ({selectedIds.size})</span>
              </Link>
              <button onClick={() => setSelectedIds(new Set())} className="btn btn-sm btn-ghost" style={{ fontSize: 11 }}>
                取消勾选
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 2. Top 3 爆款颁奖台 (仅卡片模式展现) */}
      {showPodium && (
        <div className="podium-section">
          <div className="podium-header row-between">
            <span className="badge badge-brand" style={{ fontWeight: 700, fontSize: 12, padding: '3px 10px' }}>
              👑 TOP 3 超级爆款领跑台
            </span>
            <span className="small muted">互动量最高的对标作品</span>
          </div>

          <div className="podium-grid">
            {top3.map((p, idx) => {
              const rank = idx + 1;
              const isFirst = rank === 1;
              return (
                <div key={p.id} className={`podium-card podium-rank-${rank}`}>
                  {/* 勋章 Header */}
                  <div className="podium-badge-header row-between">
                    <span className="podium-rank-tag">
                      {rank === 1 ? '🥇 榜首爆款' : rank === 2 ? '🥈 榜眼高热' : '🥉 探花佳作'}
                    </span>
                    <span
                      className="badge"
                      style={{
                        background: 'rgba(255,255,255,0.15)',
                        color: platformColor(p.platform),
                        fontWeight: 600,
                        fontSize: 11,
                      }}
                    >
                      {PLATFORM_EMOJI[p.platform]} {platformName(p.platform)}
                    </span>
                  </div>

                  {/* 标题与链接 */}
                  <div style={{ marginTop: 8, marginBottom: 8 }}>
                    {p.url ? (
                      <a href={p.url} target="_blank" rel="noopener noreferrer" className="podium-title-link">
                        {p.cleanTitle}
                      </a>
                    ) : (
                      <span className="podium-title-text">{p.cleanTitle}</span>
                    )}
                  </div>

                  {/* 作者与时间 */}
                  <div className="row wrap small muted" style={{ gap: 8, marginBottom: 10 }}>
                    <span className="row" style={{ gap: 3, alignItems: 'center' }}>
                      <Icon.user size={12} />
                      <b>{p.competitor.name}</b>
                    </span>
                    {p.publishedAt && <span>{fmtDate(p.publishedAt)}</span>}
                  </div>

                  {/* 三大爆款指标亮眼 Chip 组。
                      有播放量 → 播放量 / 互动率 / 赞播比（老样子）。
                      没有播放量（抖音这类平台的公开页面根本不显示）→ 换成**真实采到的绝对数**：
                      点赞 / 评论 / 收藏。此前是无条件渲染那三格，于是抖音作品上永远是
                      「播放量 0 · 互动率 0.0% · 赞播比 0.0%」——三个编出来的数字并排摆着。
                      摆三个破折号也不对：用户要的是能横向比作品的数，而这三个数我们是真有的。 */}
                  {/* 领奖台三格：**挑这条作品真正采到的前三项**，不是固定的三个指标。
                      写死「点赞/评论/收藏」的代价刚在真机上撞到：抖音主页只采得到点赞，
                      于是榜首赫然写着「评论 0 · 收藏 0」——那不是零互动，是没采到这两项。
                      和本文件其它地方同一条纪律：没有的项不出现，绝不用 0 冒充观测值。 */}
                  <div className="podium-metrics-grid">
                    {podiumCells(p).map((it) => (
                      <div className="podium-metric-item" key={it.lbl}>
                        <span className="metric-lbl">{it.lbl}</span>
                        <span className="metric-val" style={{ color: it.hot ? '#10b981' : 'inherit' }}>
                          {it.val}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* 底部一键转选题 */}
                  <div className="row-between" style={{ marginTop: 12, paddingTop: 8, borderTop: '1px dashed var(--border)' }}>
                    <span className="small muted">互动量 {p.interaction >= 0 ? fmtNum(p.interaction) : NA_TEXT}</span>
                    <Link
                      href={`/topics?source=${encodeURIComponent(p.cleanTitle)}`}
                      className="btn btn-sm btn-primary"
                      style={{ borderRadius: 16, fontSize: 11, padding: '3px 10px' }}
                    >
                      <Icon.sparkles size={12} />
                      <span>转选题</span>
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 3. 主体列表区: 卡片视图 vs 表格视图 */}
      {viewMode === 'cards' ? (
        <div className="stack" style={{ gap: 10 }}>
          {remainingPosts.map((p, idx) => {
            const rank = showPodium ? idx + 4 : idx + 1;
            const isExpanded = expandedId === p.id;
            const isSelected = selectedIds.has(p.id);

            const viewsPercent = Math.max(10, Math.min(100, Math.round(((p.views || 1) / maxViews) * 100)));

            return (
              <div
                key={p.id}
                className={`top-post-card ${isSelected ? 'selected-card' : ''}`}
                style={{
                  position: 'relative',
                  background: 'var(--surface)',
                  border: isSelected ? '1.5px solid var(--brand)' : '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  padding: '12px 14px',
                  transition: 'all 0.2s ease',
                }}
              >
                <div className="row wrap" style={{ gap: 12, alignItems: 'flex-start' }}>
                  {/* 多选 Checkbox & 排名勋章 */}
                  <div className="row" style={{ gap: 8, alignItems: 'center', flexShrink: 0 }}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(p.id)}
                      className="card-checkbox"
                      title="勾选加入批量转选题"
                    />
                    <div className={`rank-badge rank-${rank <= 3 ? rank : 'normal'}`}>
                      {rank === 1 && <span className="rank-crown">🥇</span>}
                      {rank === 2 && <span className="rank-crown">🥈</span>}
                      {rank === 3 && <span className="rank-crown">🥉</span>}
                      <span className="rank-num">{rank}</span>
                    </div>
                  </div>

                  {/* 主体内容 */}
                  <div style={{ flex: 1, minWidth: 260 }}>
                    {/* 第一行：平台标签 + 标题 */}
                    <div className="row wrap" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
                      <span
                        className="badge"
                        style={{
                          background: 'var(--surface-2)',
                          color: platformColor(p.platform),
                          fontWeight: 600,
                          fontSize: 11.5,
                          padding: '2px 7px',
                          borderRadius: 6,
                          flexShrink: 0,
                        }}
                      >
                        {PLATFORM_EMOJI[p.platform] ?? ''} {platformName(p.platform)}
                      </span>

                      {p.url ? (
                        <a
                          href={p.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="post-title-link"
                          title="在新标签页打开原作品"
                        >
                          {p.cleanTitle}
                          <Icon.arrow size={12} style={{ display: 'inline', marginLeft: 4, transform: 'rotate(-45deg)', opacity: 0.7 }} />
                        </a>
                      ) : (
                        <span className="post-title-text">{p.cleanTitle}</span>
                      )}
                    </div>

                    {/* 第二行：创作者 + 发布时间 + 三大爆款关键比例 Badges */}
                    <div className="row wrap" style={{ gap: 12, rowGap: 6, alignItems: 'center' }}>
                      <span className="small muted row" style={{ gap: 4, alignItems: 'center' }}>
                        <Icon.user size={12} />
                        <b style={{ color: 'var(--text-2)' }}>{p.competitor.name}</b>
                      </span>

                      {p.publishedAt && <span className="small muted">{fmtDate(p.publishedAt)}</span>}

                      {/* 关键数据。**按这个平台真正有的项来摆**：
                          · 平台压根不提供的（如抖音的播放量）连位置都不占——每行多一个破折号没意义
                          · 平台有、这次没采到的画「—」，鼠标悬停说明为什么（详情页才有 / 还没验过 / 该重采）
                          三种缺席给三种说法，用户才分得清「数据差」「平台没有」「我们没采到」。 */}
                      <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
                        {displayKeys(p.platform, CHIP_KEYS).map((k) => {
                          const c = METRIC_CHIPS.find((x) => x.key === k)!;
                          const v = p[k];
                          const has = typeof v === 'number' && v > 0;
                          return (
                            <span
                              key={k}
                              className="metric-chip"
                              style={has ? undefined : { opacity: 0.5 }}
                              title={has ? c.title : `${c.title}：${absenceNote(p.platform, k)}`}
                            >
                              {c.icon} {has ? fmtNum(v) : NA_TEXT}
                            </span>
                          );
                        })}

                        {/* 互动率只在算得出来时出现（有播放量才有分母） */}
                        {p.rate !== null && (
                          <span
                            className={`badge ${p.rate > 0.03 ? 'badge-green' : p.rate > 0.015 ? 'badge-brand' : 'badge-gray'}`}
                            style={{ fontSize: 11, padding: '1px 6px' }}
                            title="互动率 (点赞+评论+收藏 / 播放)"
                          >
                            {p.rate > 0.03 ? '🔥 ' : ''}互动率 {pctOrNull(p.rate)}
                          </span>
                        )}

                        {/* 这条作品在当前时间窗内的增长 */}
                        <GrowthChip g={p.growth} label={windowLabel} />
                      </div>
                    </div>
                  </div>

                  {/* 右侧动作区：拆解按钮 + 趋势 + 转选题 */}
                  <div className="row wrap" style={{ gap: 8, alignItems: 'center', flexShrink: 0, alignSelf: 'center' }}>
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : p.id)}
                      className={`btn btn-sm ${isExpanded ? 'btn-brand-soft' : 'btn-ghost'}`}
                      style={{ fontSize: 12, padding: '4px 10px', borderRadius: 14 }}
                      title="展开查看完整全维数据与爆点拆解"
                    >
                      <Icon.bulb size={13} />
                      <span>{isExpanded ? '收起拆解' : '拆解爆款'}</span>
                    </button>

                    <CompetitorTrendCell snapshots={p.snaps} />

                    <Link
                      href={`/topics?source=${encodeURIComponent(p.cleanTitle)}`}
                      className="btn btn-sm btn-brand-soft"
                      style={{
                        borderRadius: 20,
                        padding: '4px 12px',
                        fontSize: 12,
                        fontWeight: 600,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        textDecoration: 'none',
                      }}
                      title="将此爆款作品一键转为我的创作选题"
                    >
                      <Icon.sparkles size={13} />
                      <span>转选题</span>
                    </Link>
                  </div>
                </div>

                {/* 4. 爆款深度拆解展开面板 (Expanded Analysis Panel) */}
                {isExpanded && (
                  <div className="expanded-analysis-panel">
                    <div className="analysis-grid">
                      {/* 全维数据指标卡 */}
                      <div className="analysis-box">
                        <div className="analysis-title">📊 基础数据对比</div>
                        {/* 与卡片行上的 chip **同一套判据**：平台没有的项不占位，
                            平台有、这次没采到的画「—」并说明原因。
                            此前这里是七行写死的 fmtNum(p.x)，于是抖音的「播放/阅读: 0」、
                            小红书只采了主页时的「收藏数: 0」都被当成事实印出来——
                            那不是 0，那是这一页压根没有这项（同「缺席不许当 0」那条纪律）。 */}
                        <div className="metrics-detail-row">
                          {displayKeys(p.platform, CHIP_KEYS).map((k) => {
                            const c = METRIC_CHIPS.find((x) => x.key === k)!;
                            const v = p[k];
                            const has = typeof v === 'number' && v > 0;
                            return (
                              <span key={k} style={has ? undefined : { opacity: 0.6 }} title={has ? undefined : absenceNote(p.platform, k)}>
                                {c.icon} {c.title}: <b>{has ? fmtNum(v) : NA_TEXT}</b>
                              </span>
                            );
                          })}
                        </div>
                      </div>

                      {/* 互动构成。原来这里是赞播比/评赞比/藏赞比三个比例——
                          它们要么吃播放量（多数平台没有）、要么两个分量凑不齐，
                          绝大多数作品上三行全是「—」。换成真实采到的绝对数，
                          没采到的项不出现（不是显示 0）。 */}
                      <div className="analysis-box">
                        <div className="analysis-title">📊 互动构成</div>
                        <div className="stack" style={{ gap: 6, fontSize: 12 }}>
                          {METRIC_CHIPS.map((c) => {
                            const v = p[c.key];
                            if (typeof v !== 'number' || v <= 0) return null;
                            return (
                              <div className="row-between" key={c.key}>
                                <span className="muted">{c.icon} {c.title}:</span>
                                <b>{fmtNum(v)}</b>
                              </div>
                            );
                          })}
                          {p.interaction >= 0 && (
                            <div className="row-between" style={{ borderTop: '1px dashed var(--border)', paddingTop: 6 }}>
                              <span className="muted">互动量合计（赞+评+藏+转）:</span>
                              <b>{fmtNum(p.interaction)}</b>
                            </div>
                          )}
                          {p.growth?.status === 'ok' && (
                            <div className="row-between">
                              <span className="muted">近 {windowLabel}净增:</span>
                              <b>
                                {GROWTH_PRIORITY.map((k) => {
                                  const d = p.growth!.delta[k];
                                  if (typeof d !== 'number' || d === 0) return null;
                                  const name = METRIC_CHIPS.find((c) => c.key === k)?.title.replace(/[（(].*$/, '') ?? k;
                                  return `${name} ${d > 0 ? '+' : ''}${fmtNum(d)}`;
                                }).filter(Boolean).join(' · ') || '无变化'}
                              </b>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* AI 拆解建议与推荐切入角 */}
                    <div className="ai-hook-box">
                      <div className="row-between">
                        <span className="row" style={{ gap: 6, fontWeight: 600, fontSize: 12.5 }}>
                          <Icon.sparkles size={14} style={{ color: 'var(--brand)' }} />
                          <span>AI 爆款拆解切入建议</span>
                        </span>
                        <CopyTitleBtn title={p.cleanTitle} />
                      </div>
                      <p className="small muted" style={{ marginTop: 4, lineHeight: 1.6 }}>
                        💡 该作品在【{platformName(p.platform)}】展现出强烈的
                        {p.collects > p.likes * 0.15
                          ? '【实用干货与复看沉淀】'
                          : p.comments > p.likes * 0.08
                            ? '【话题争议与情绪共鸣】'
                            : '【第一眼 Hook 吸睛力】'}。
                        建议创作时保留原题的痛点切入，但使用差异化的案例或从反面视角反套路重构。
                      </p>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        /* 5. 紧凑表格视图 Mode (High density table) */
        <div className="table-container">
          <table className="compact-leaderboard-table">
            <thead>
              <tr>
                <th style={{ width: 40, textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    checked={selectedIds.size > 0 && selectedIds.size === sortedPosts.length}
                    onChange={toggleSelectAll}
                  />
                </th>
                <th style={{ width: 50, textAlign: 'center' }}>排名</th>
                <th style={{ width: 90 }}>平台</th>
                <th>作品标题 / 对标账号</th>
                <th style={{ textAlign: 'right' }}>播放量</th>
                <th style={{ textAlign: 'right' }}>点赞量</th>
                <th style={{ textAlign: 'right' }}>评论量</th>
                <th style={{ textAlign: 'right' }}>收藏量</th>
                <th style={{ textAlign: 'right' }}>转发量</th>
                <th style={{ textAlign: 'right' }}>互动率</th>
                <th style={{ textAlign: 'center', width: 90 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {sortedPosts.map((p, idx) => {
                const rank = idx + 1;
                const isSelected = selectedIds.has(p.id);
                return (
                  <tr key={p.id} className={isSelected ? 'selected-row' : ''}>
                    <td style={{ textAlign: 'center' }}>
                      <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(p.id)} />
                    </td>
                    <td style={{ textAlign: 'center', fontWeight: 700 }}>
                      <span className={`table-rank-num rank-${rank <= 3 ? rank : 'normal'}`}>{rank}</span>
                    </td>
                    <td>
                      <span className="badge" style={{ color: platformColor(p.platform), background: 'var(--surface-2)', fontSize: 11 }}>
                        {PLATFORM_EMOJI[p.platform]} {platformName(p.platform)}
                      </span>
                    </td>
                    <td>
                      <div className="stack" style={{ gap: 2 }}>
                        {p.url ? (
                          <a href={p.url} target="_blank" rel="noopener noreferrer" className="table-post-title">
                            {p.cleanTitle}
                          </a>
                        ) : (
                          <span className="table-post-title">{p.cleanTitle}</span>
                        )}
                        <span className="small muted">@{p.competitor.name}</span>
                      </div>
                    </td>
                    {/* 表格里算不出来的格子画占位并挂上原因，绝不填 0.0%：
                        一张全是 0.0% 的表看不出「真的差」和「这平台没这数据」的区别 */}
                    <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono, monospace)', fontWeight: 600 }}>
                      {p.views > 0 ? fmtNum(p.views) : <span className="muted" title={absenceNote(p.platform, 'views')}>{NA_TEXT}</span>}
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono, monospace)' }}>
                      {fmtNum(p.likes)}
                    </td>
                    {(['comments', 'collects', 'shares'] as const).map((k) => (
                      <td key={k} style={{ textAlign: 'right', fontFamily: 'var(--font-mono, monospace)' }}>
                        {p[k] > 0 ? (
                          fmtNum(p[k])
                        ) : (
                          <span className="muted" title={absenceNote(p.platform, k)}>{NA_TEXT}</span>
                        )}
                      </td>
                    ))}
                    <td style={{ textAlign: 'right', fontWeight: 600, color: (p.rate ?? 0) > 0.03 ? 'var(--green)' : 'inherit' }}>
                      {pctOrNull(p.rate) ?? <span className="muted" title={NA_TITLE}>{NA_TEXT}</span>}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <Link
                        href={`/topics?source=${encodeURIComponent(p.cleanTitle)}`}
                        className="btn btn-sm btn-ghost"
                        style={{ fontSize: 11, padding: '2px 6px' }}
                      >
                        转选题
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* CSS 样式系统 */}
      <style>{`
        /* 工具栏 Filter & Sort 按钮 */
        .filter-btn, .sort-pill {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 14px;
          padding: 3px 10px;
          font-size: 11.5px;
          color: var(--text-2);
          cursor: pointer;
          transition: all 0.15s ease;
        }
        .filter-btn:hover, .sort-pill:hover {
          border-color: var(--brand-soft);
          color: var(--text);
        }
        .filter-btn.active, .sort-pill.active {
          background: var(--brand-soft);
          color: var(--brand);
          border-color: var(--brand);
          font-weight: 600;
        }

        /* 视图切换按钮 */
        .view-toggle-btn {
          background: var(--surface);
          border: 1px solid var(--border);
          padding: 3px 9px;
          font-size: 11.5px;
          border-radius: 6px;
          cursor: pointer;
          color: var(--text-2);
        }
        .view-toggle-btn.active {
          background: var(--surface-2);
          color: var(--text);
          border-color: var(--brand);
          font-weight: 600;
        }

        /* 搜索框 */
        .search-input-wrap {
          position: relative;
          display: flex;
          align-items: center;
        }
        .search-icon {
          position: absolute;
          left: 8px;
          color: var(--text-3);
          pointer-events: none;
        }
        .search-input {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 14px;
          padding: 3px 26px 3px 26px;
          font-size: 11.5px;
          outline: none;
          width: 180px;
          transition: width 0.2s, border-color 0.2s;
        }
        .search-input:focus {
          border-color: var(--brand);
          width: 220px;
        }
        .clear-btn {
          position: absolute;
          right: 8px;
          background: none;
          border: none;
          color: var(--text-3);
          cursor: pointer;
          font-size: 14px;
          padding: 0;
        }

        /* Top 3 Podium 领跑台样式 */
        .podium-section {
          background: linear-gradient(180deg, var(--surface-2) 0%, var(--surface) 100%);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          padding: 14px;
        }
        .podium-header {
          margin-bottom: 12px;
        }
        .podium-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
          gap: 12px;
        }
        .podium-card {
          background: var(--surface);
          border-radius: 10px;
          padding: 12px;
          border: 1px solid var(--border);
          position: relative;
          transition: transform 0.2s, box-shadow 0.2s;
        }
        .podium-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 18px rgba(0,0,0,0.06);
        }
        .podium-rank-1 {
          border-color: #f59e0b;
          box-shadow: 0 0 12px rgba(245, 158, 11, 0.15);
        }
        .podium-rank-2 {
          border-color: #94a3b8;
        }
        .podium-rank-3 {
          border-color: #d97706;
        }
        .podium-rank-tag {
          font-weight: 800;
          font-size: 13px;
        }
        .podium-title-link, .podium-title-text {
          font-size: 13.5px;
          font-weight: 700;
          color: var(--text);
          text-decoration: none;
          line-height: 1.4;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .podium-title-link:hover {
          color: var(--brand);
        }
        .podium-metrics-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 6px;
          background: var(--surface-2);
          padding: 8px;
          border-radius: 6px;
          text-align: center;
        }
        .podium-metric-item {
          display: flex;
          flex-direction: column;
        }
        .metric-lbl {
          font-size: 10px;
          color: var(--text-3);
        }
        .metric-val {
          font-size: 12px;
          font-weight: 700;
          font-family: var(--font-mono, monospace);
        }

        /* 爆款卡片通用 hover & selected */
        .top-post-card {
          box-shadow: 0 1px 3px rgba(0,0,0,0.03);
        }
        .top-post-card:hover {
          border-color: var(--brand-soft);
          box-shadow: 0 4px 14px rgba(0,0,0,0.06);
        }
        .card-checkbox {
          width: 15px;
          height: 15px;
          cursor: pointer;
        }

        /* 排名勋章样式 */
        .rank-badge {
          width: 30px;
          height: 30px;
          border-radius: 8px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          font-weight: 800;
          font-size: 12px;
          background: var(--surface-2);
          color: var(--text-2);
          border: 1px solid var(--border);
        }
        .rank-badge.rank-1 {
          background: linear-gradient(135deg, #fff7ed, #ffedd5);
          color: #c2410c;
          border-color: #fdba74;
        }
        .rank-badge.rank-2 {
          background: linear-gradient(135deg, #f8fafc, #e2e8f0);
          color: #334155;
          border-color: #cbd5e1;
        }
        .rank-badge.rank-3 {
          background: linear-gradient(135deg, #fffbe3, #fef3c7);
          color: #92400e;
          border-color: #fde68a;
        }

        /* 作品标题 */
        .post-title-link, .post-title-text {
          font-size: 14px;
          font-weight: 600;
          color: var(--text);
          text-decoration: none;
          line-height: 1.4;
        }
        .post-title-link:hover {
          color: var(--brand);
        }

        /* 比例 Tag */
        .ratio-tag {
          font-size: 10.5px;
          padding: 1px 6px;
          border-radius: 4px;
          background: rgba(16, 185, 129, 0.1);
          color: #059669;
          font-weight: 500;
          font-family: var(--font-mono, monospace);
        }
        .ratio-comment {
          background: rgba(59, 130, 246, 0.1);
          color: #2563eb;
        }
        .ratio-collect {
          background: rgba(245, 158, 11, 0.1);
          color: #d97706;
        }

        /* Mini Metric Chips */
        .metric-chip {
          display: inline-flex;
          align-items: center;
          gap: 3px;
          font-size: 11px;
          padding: 2px 6px;
          border-radius: 4px;
          background: var(--surface-2);
          color: var(--text-2);
          font-family: var(--font-mono, monospace);
        }
        .views-chip {
          background: var(--brand-soft);
          color: var(--brand);
        }

        /* 热度指示线 */
        .heat-bar-wrap {
          height: 3px;
          background: var(--surface-2);
          border-radius: 3px;
          margin-top: 8px;
          overflow: hidden;
        }
        .heat-bar-inner {
          height: 100%;
          background: linear-gradient(90deg, var(--brand-soft), var(--brand));
          border-radius: 3px;
          transition: width 0.4s ease;
        }

        /* 爆款深度拆解展开面板 */
        .expanded-analysis-panel {
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px dashed var(--border);
          display: flex;
          flex-direction: column;
          gap: 10px;
          animation: fadeIn 0.2s ease-in-out;
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .analysis-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
          gap: 10px;
        }
        .analysis-box {
          background: var(--surface-2);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 10px 12px;
        }
        .analysis-title {
          font-size: 11.5px;
          font-weight: 700;
          color: var(--text-2);
          margin-bottom: 6px;
        }
        .metrics-detail-row {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          font-size: 11.5px;
          color: var(--text-2);
        }
        .ai-hook-box {
          background: var(--brand-soft);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 10px 12px;
        }

        /* 紧凑表格样式 */
        .table-container {
          overflow-x: auto;
          border: 1px solid var(--border);
          border-radius: var(--radius);
          background: var(--surface);
        }
        .compact-leaderboard-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 12px;
        }
        .compact-leaderboard-table th {
          background: var(--surface-2);
          color: var(--text-2);
          font-weight: 600;
          padding: 8px 10px;
          border-bottom: 1px solid var(--border);
          white-space: nowrap;
        }
        .compact-leaderboard-table td {
          padding: 8px 10px;
          border-bottom: 1px solid var(--border);
          vertical-align: middle;
        }
        .compact-leaderboard-table tr:last-child td {
          border-bottom: none;
        }
        .table-post-title {
          font-weight: 600;
          color: var(--text);
          text-decoration: none;
          line-height: 1.3;
        }
        .table-post-title:hover {
          color: var(--brand);
        }
        .table-rank-num {
          display: inline-block;
          width: 20px;
          height: 20px;
          line-height: 20px;
          border-radius: 4px;
        }
        .table-rank-num.rank-1 { background: #fde68a; color: #92400e; }
        .table-rank-num.rank-2 { background: #e2e8f0; color: #334155; }
        .table-rank-num.rank-3 { background: #fef3c7; color: #b45309; }
      `}</style>
    </div>
  );
}

function CopyTitleBtn({ title }: { title: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard.writeText(title);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }, [title]);
  return (
    <button onClick={copy} className="btn btn-sm btn-ghost" style={{ fontSize: 11, padding: '2px 8px' }}>
      {copied ? '已复制 ✓' : '复制标题'}
    </button>
  );
}
