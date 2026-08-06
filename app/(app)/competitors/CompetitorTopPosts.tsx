'use client';

import { useState, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { parseJson, engagementRate, type Metrics } from '@/lib/json';
import { platformName, platformColor } from '@/lib/constants';
import { fmtNum, fmtDate } from '@/lib/format';
import { Icon } from '@/components/icons';
import { CompetitorTrendCell } from './CompetitorTrendCell';

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

type SnapItem = { takenAt: Date | string; metrics: string };

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
type SortKey = 'hot' | 'views' | 'engagement' | 'growth';
type ViewModeKey = 'cards' | 'table';

export function CompetitorTopPosts({
  topPosts,
  snapsByPostMap,
}: {
  topPosts: CompetitorPost[];
  snapsByPostMap: Record<string, SnapItem[]>;
}) {
  const [timeRange, setTimeRange] = useState<TimeRangeKey>('all');
  const [sortBy, setSortBy] = useState<SortKey>('hot');
  const [viewMode, setViewMode] = useState<ViewModeKey>('cards');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // 计算多维衍生指标 (赞播比, 评赞比, 藏赞比, 增速)
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

      const rate = engagementRate(m);
      const likeToView = views > 0 ? likes / views : 0;
      const commentToLike = likes > 0 ? comments / likes : 0;
      const collectToLike = likes > 0 ? collects / likes : 0;

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
        likeToView,
        commentToLike,
        collectToLike,
        growthDelta,
        ageHours,
        snaps,
      };
    });
  }, [topPosts, snapsByPostMap]);

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
      if (sortBy === 'engagement') return b.rate - a.rate;
      if (sortBy === 'growth') return b.growthDelta - a.growthDelta;
      return (b.hotScore || 0) - (a.hotScore || 0); // default: hot
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
    const headers = ['排名', '平台', '作品标题', '创作者', '播放量', '点赞量', '评论量', '收藏量', '互动率', '热度指数', '发布时间'];
    const rows = sortedPosts.map((p, idx) => [
      idx + 1,
      platformName(p.platform),
      `"${p.cleanTitle.replace(/"/g, '""')}"`,
      `"${p.competitor.name.replace(/"/g, '""')}"`,
      p.views,
      p.likes,
      p.comments,
      p.collects,
      `${(p.rate * 100).toFixed(2)}%`,
      p.hotScore || 0,
      p.publishedAt ? fmtDate(p.publishedAt) : '未记录',
    ]);
    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `高热作品榜单_${new Date().toISOString().slice(0, 10)}.csv`);
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

  const maxHot = Math.max(...sortedPosts.map((p) => p.hotScore || 1), 1);
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
                ['hot', '🔥 综合热度'],
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
            <span className="small muted">全网热度指数最高对标作品</span>
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

                  {/* 三大爆款指标亮眼 Chip 组 */}
                  <div className="podium-metrics-grid">
                    <div className="podium-metric-item">
                      <span className="metric-lbl">播放量</span>
                      <span className="metric-val">{fmtNum(p.views)}</span>
                    </div>
                    <div className="podium-metric-item">
                      <span className="metric-lbl">互动率</span>
                      <span className="metric-val" style={{ color: p.rate > 0.03 ? '#10b981' : 'inherit' }}>
                        {(p.rate * 100).toFixed(1)}%
                      </span>
                    </div>
                    <div className="podium-metric-item">
                      <span className="metric-lbl">赞播比</span>
                      <span className="metric-val">{(p.likeToView * 100).toFixed(1)}%</span>
                    </div>
                  </div>

                  {/* 底部一键转选题 */}
                  <div className="row-between" style={{ marginTop: 12, paddingTop: 8, borderTop: '1px dashed var(--border)' }}>
                    <span className="small muted">爆款热度: {p.hotScore || 0}</span>
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

            // 热度与播放占比条
            const heatPercent = Math.max(10, Math.min(100, Math.round(((p.hotScore || 1) / maxHot) * 100)));
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

                      {/* 关键数据 Mini Chips */}
                      <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
                        {p.views > 0 && (
                          <span className="metric-chip views-chip" title="累计播放/阅读量">
                            <Icon.eye size={11} />
                            <b>{fmtNum(p.views)}</b>
                          </span>
                        )}
                        {p.likes > 0 && (
                          <span className="metric-chip likes-chip" title="点赞数">
                            👍 {fmtNum(p.likes)}
                          </span>
                        )}

                        {/* 互动率 Badge */}
                        <span
                          className={`badge ${p.rate > 0.03 ? 'badge-green' : p.rate > 0.015 ? 'badge-brand' : 'badge-gray'}`}
                          style={{ fontSize: 11, padding: '1px 6px' }}
                          title="互动率 (点赞+评论+收藏 / 播放)"
                        >
                          {p.rate > 0.03 ? '🔥 ' : ''}互动率 {(p.rate * 100).toFixed(1)}%
                        </span>

                        {/* 赞播比 (赞/播) */}
                        {p.likeToView > 0 && (
                          <span className="ratio-tag" title="赞播比: 点赞 / 播放 (>5% 说明第一眼吸引力与完播率极佳)">
                            赞播比 {(p.likeToView * 100).toFixed(1)}%
                          </span>
                        )}

                        {/* 评赞比 (评/赞) */}
                        {p.commentToLike > 0 && (
                          <span className="ratio-tag ratio-comment" title="评赞比: 评论 / 点赞 (>10% 说明引发强互动讨论)">
                            评赞比 {(p.commentToLike * 100).toFixed(1)}%
                          </span>
                        )}

                        {/* 藏赞比 (藏/赞) */}
                        {p.collectToLike > 0 && (
                          <span className="ratio-tag ratio-collect" title="藏赞比: 收藏 / 点赞 (>20% 说明干货价值极高)">
                            藏赞比 {(p.collectToLike * 100).toFixed(1)}%
                          </span>
                        )}
                      </div>
                    </div>

                    {/* 热度感应双色动态条 */}
                    <div className="heat-bar-wrap" title={`爆款热度指数: ${p.hotScore || 0}`}>
                      <div className="heat-bar-inner" style={{ width: `${heatPercent}%` }} />
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
                        <div className="metrics-detail-row">
                          <span>👁️ 播放/阅读: <b>{fmtNum(p.views)}</b></span>
                          <span>👍 点赞数: <b>{fmtNum(p.likes)}</b></span>
                          <span>💬 评论数: <b>{fmtNum(p.comments)}</b></span>
                          <span>⭐ 收藏数: <b>{fmtNum(p.collects)}</b></span>
                          {p.shares > 0 && <span>🔄 转发数: <b>{fmtNum(p.shares)}</b></span>}
                          {p.danmaku > 0 && <span>📺 弹幕数: <b>{fmtNum(p.danmaku)}</b></span>}
                          {p.coins > 0 && <span>🪙 投币数: <b>{fmtNum(p.coins)}</b></span>}
                        </div>
                      </div>

                      {/* 爆款三高比例评估 */}
                      <div className="analysis-box">
                        <div className="analysis-title">🔥 爆款基因属性分析</div>
                        <div className="stack" style={{ gap: 6, fontSize: 12 }}>
                          <div className="row-between">
                            <span className="muted">赞播比 (Hook吸睛力):</span>
                            <b style={{ color: p.likeToView > 0.05 ? 'var(--green)' : 'inherit' }}>
                              {(p.likeToView * 100).toFixed(1)}% {p.likeToView > 0.05 ? '(优秀级)' : ''}
                            </b>
                          </div>
                          <div className="row-between">
                            <span className="muted">评赞比 (争议讨论力):</span>
                            <b style={{ color: p.commentToLike > 0.1 ? 'var(--green)' : 'inherit' }}>
                              {(p.commentToLike * 100).toFixed(1)}% {p.commentToLike > 0.1 ? '(高讨论)' : ''}
                            </b>
                          </div>
                          <div className="row-between">
                            <span className="muted">藏赞比 (实用价值力):</span>
                            <b style={{ color: p.collectToLike > 0.2 ? 'var(--green)' : 'inherit' }}>
                              {(p.collectToLike * 100).toFixed(1)}% {p.collectToLike > 0.2 ? '(高收藏)' : ''}
                            </b>
                          </div>
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
                        {p.collectToLike > 0.15 ? '【实用干货与复看沉淀】' : p.commentToLike > 0.08 ? '【话题争议与情绪共鸣】' : '【第一眼 Hook 吸睛力】'}。
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
                <th style={{ textAlign: 'right' }}>互动率</th>
                <th style={{ textAlign: 'right' }}>赞播比</th>
                <th style={{ textAlign: 'right' }}>评赞比</th>
                <th style={{ textAlign: 'right' }}>热度分</th>
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
                    <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono, monospace)', fontWeight: 600 }}>
                      {fmtNum(p.views)}
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono, monospace)' }}>
                      {fmtNum(p.likes)}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: p.rate > 0.03 ? 'var(--green)' : 'inherit' }}>
                      {(p.rate * 100).toFixed(1)}%
                    </td>
                    <td style={{ textAlign: 'right', fontSize: 12 }}>
                      {(p.likeToView * 100).toFixed(1)}%
                    </td>
                    <td style={{ textAlign: 'right', fontSize: 12 }}>
                      {(p.commentToLike * 100).toFixed(1)}%
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--brand)' }}>
                      {p.hotScore || 0}
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
