'use client';

import React, { useState, useMemo } from 'react';
import { fmtNum } from '@/lib/format';
import { sourceBrandName } from '@/lib/constants';
import { QuickAnalyzeButton } from './HotFitAnalyzer';

export type HotItemView = {
  id: string;
  source: string;
  title: string;
  url: string | null;
  rank: number;
  heat: number;
  lifecycle?: string | null;
  isMock?: boolean;
};

export type HotSourceInfo = {
  key: string;
  name: string;
  beta?: boolean;
};

const LIFECYCLE_STYLE: Record<string, { cls: string; label: string; en: string }> = {
  rising: { cls: 'badge-green', label: '上升', en: 'Rising' },
  peak: { cls: 'badge-red', label: '峰值', en: 'Peak' },
  cooling: { cls: 'badge-amber', label: '降温', en: 'Cooling' },
  faded: { cls: 'badge-gray', label: '已退', en: 'Faded' },
};

export function LifecycleBadge({ stage, lang }: { stage?: string | null; lang?: string }) {
  if (!stage) return null;
  const s = LIFECYCLE_STYLE[stage];
  if (!s) return null;
  const label = lang === 'en' ? s.en : s.label;
  return (
    <span className={`badge ${s.cls}`} style={{ fontSize: 10, padding: '1px 5px', lineHeight: 1.2 }}>
      {label}
    </span>
  );
}

interface HotlistPlatformTabsProps {
  sources: readonly HotSourceInfo[];
  itemsBySource: Record<string, HotItemView[]>;
  /** 每个源在库里的**真实**条数。itemsBySource 是按 rank 截断过的，徽标不拿截断数冒充总数 */
  totalBySource: Record<string, number>;
  isGuest: boolean;
  lang?: string;
  dict: {
    mockData: string;
    mockItem: string;
    notConnected: string;
    notConnectedGuest: string;
    openOrigin: string;
    sources: Record<string, string>;
  };
}

export function HotlistPlatformTabs({
  sources,
  itemsBySource,
  totalBySource,
  isGuest,
  lang,
  dict,
}: HotlistPlatformTabsProps) {
  // 默认选中第一个有数据的源，或首个源
  const defaultSource = useMemo(() => {
    const firstWithData = sources.find((s) => (itemsBySource[s.key] || []).length > 0);
    return firstWithData?.key || sources[0]?.key || 'douyin';
  }, [sources, itemsBySource]);

  const [activeTab, setActiveTab] = useState<string>(defaultSource);
  const [showAll, setShowAll] = useState<boolean>(false);

  const currentSource = sources.find((s) => s.key === activeTab) || sources[0];
  const currentList = itemsBySource[activeTab] || [];
  const currentTotal = totalBySource[activeTab] ?? currentList.length;
  const allMock = currentList.length > 0 && currentList.every((i) => i.isMock);

  // 默认展示前 10 条（5 行双列对齐），点击展开可看全部
  const displayLimit = 10;
  const visibleItems = showAll ? currentList : currentList.slice(0, displayLimit);
  const hasMore = currentList.length > displayLimit;

  return (
    <div className="surface platform-block">
      <div className="surface-head">
        <div className="platform-tabs" role="tablist" aria-label="Platform Hotlists">
          {sources.map((src) => {
            const count = totalBySource[src.key] ?? (itemsBySource[src.key] || []).length;
            const displayName =
              lang === 'en' && dict.sources[src.key]
                ? dict.sources[src.key]
                : sourceBrandName(src.key);
            const isActive = activeTab === src.key;

            return (
              <button
                key={src.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`platform-tab-btn ${isActive ? 'active' : ''}`}
                onClick={() => {
                  setActiveTab(src.key);
                  setShowAll(false);
                }}
              >
                <span>{displayName}</span>
                {count > 0 && <span className="platform-tab-count">{count}</span>}
              </button>
            );
          })}
        </div>

        <div className="platform-header-meta">
          {allMock && <span className="badge badge-gray">{dict.mockData}</span>}
          {currentSource?.beta && <span className="badge badge-gray">beta</span>}
          {currentList.length > 0 && (
            <span className="platform-count-text">
              {showAll
                // 【截断了就说破】列表按 rank 只带回前 60 条，库里可能还有更靠后的。
                // 说「已显示全部 60 条」而库里有 413 条，就是拿截断数冒充总数。
                ? (currentTotal > currentList.length
                    ? `${lang === 'en' ? 'Top' : '已显示前'} ${currentList.length} ${lang === 'en' ? `of ${currentTotal}` : `条 · 库里共 ${currentTotal} 条`}`
                    : `${lang === 'en' ? 'Showing all' : '已显示全部'} ${currentList.length} ${lang === 'en' ? 'items' : '条'}`)
                : `${lang === 'en' ? 'Top' : '仅显示前'} ${Math.min(displayLimit, currentList.length)} ${lang === 'en' ? 'items' : '条'}`}
            </span>
          )}
          {hasMore && (
            <button
              type="button"
              className="platform-toggle-btn"
              onClick={() => setShowAll((prev) => !prev)}
            >
              {showAll ? (lang === 'en' ? 'Collapse' : '收起') : (lang === 'en' ? `Show all (${currentList.length})` : `展开全部 (${currentList.length})`)}
            </button>
          )}
        </div>
      </div>

      {currentList.length === 0 ? (
        <div className="platform-empty">
          <p className="small muted">
            {isGuest ? dict.notConnectedGuest : dict.notConnected}
          </p>
        </div>
      ) : (
        <div className="platform-list">
          {visibleItems.map((it) => {
            const clickable = Boolean(it.url && it.url !== '#');
            const rankStr = String(it.rank).padStart(2, '0');
            const isTopRank = it.rank <= 3;

            return (
              <div key={it.id} className="platform-row">
                <span className={`platform-row-rank ${isTopRank ? 'top-rank' : ''}`}>
                  {rankStr}
                </span>

                <div className="platform-row-main">
                  {clickable ? (
                    <a
                      href={it.url!}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="platform-row-title"
                      title={dict.openOrigin}
                    >
                      <span>{it.title}</span>
                      <span className="platform-row-ext-icon" aria-hidden="true">↗</span>
                    </a>
                  ) : (
                    <span className="platform-row-title">{it.title}</span>
                  )}
                  {it.isMock && !allMock && (
                    <span className="badge badge-gray" style={{ fontSize: 10, padding: '0 4px', flexShrink: 0 }}>
                      {dict.mockItem}
                    </span>
                  )}
                </div>

                <div className="platform-row-actions">
                  <LifecycleBadge stage={it.lifecycle} lang={lang} />
                  {it.heat > 0 && (
                    <span className="platform-row-heat">
                      {fmtNum(it.heat)}
                    </span>
                  )}
                  <QuickAnalyzeButton topic={it.title} isGuest={isGuest} label="⚡️" />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
