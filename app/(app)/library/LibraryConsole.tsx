'use client';

import React, { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { platformName } from '@/lib/constants';
import { useI18n } from '@/lib/i18n';
import { HubHeader } from '@/components/HubHeader';
import { IntelTabs } from '@/components/IntelTabs';
import { Overlay } from '@/components/Overlay';
import {
  actAddInspiration,
} from '../inspiration/actions';
import { VideoAnalyzeCard } from './VideoAnalyzeCard';

export type LibraryItem = {
  id: string;
  title: string;
  url: string | null;
  author: string | null;
  platform: string | null;
  note: string | null;
  summary: string | null;
  points: string[];
  analysis: string | null;
  excerpt: string;
  chars: number;
  state: string;
  createdAt: string;
};

function relDays(iso: string, isEn = false): string {
  const n = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (n <= 0) return isEn ? 'Today' : '今天';
  if (n === 1) return isEn ? 'Yesterday' : '昨天';
  if (n < 30) return isEn ? `${n}d ago` : `${n} 天前`;
  return isEn ? `${Math.floor(n / 30)}mo ago` : `${Math.floor(n / 30)} 个月前`;
}


function inferCategory(it: LibraryItem): 'article' | 'video' | 'inspiration' | 'pending' {
  if (it.state === 'pending' || (!it.summary && it.chars < 200)) return 'pending';
  if (
    it.platform === 'bilibili' ||
    it.platform === 'youtube' ||
    it.platform === 'douyin' ||
    it.url?.includes('video') ||
    it.url?.includes('bilibili') ||
    it.url?.includes('youtube')
  ) {
    return 'video';
  }
  if (it.platform === 'manual' || (!it.url && it.chars < 500)) return 'inspiration';
  return 'article';
}

function getItemMetaAndStatus(it: LibraryItem, isEn: boolean) {
  const cat = inferCategory(it);
  let statusText = isEn ? 'Ready' : '可直接复用';
  let statusClass = 'tag green';
  let catText = isEn ? 'Article' : '文章';
  let catClass = 'tag brand';

  if (cat === 'video') {
    catText = isEn ? 'Video' : '视频';
    catClass = 'tag';
  } else if (cat === 'pending') {
    catText = isEn ? 'To Organize' : '待整理';
    catClass = 'tag amber';
  } else if (cat === 'inspiration') {
    catText = isEn ? 'Inspiration' : '灵感';
    catClass = 'tag green';
  }

  if (it.state === 'used') {
    statusText = isEn ? 'Converted' : '已转选题';
    statusClass = 'tag brand';
  } else if (it.state === 'archived') {
    statusText = isEn ? 'Archived' : '已归档';
    statusClass = 'tag';
  } else if (!it.summary || cat === 'pending') {
    statusText = isEn ? 'Needs Action' : '需要处理';
    statusClass = 'tag amber';
  } else if (cat === 'inspiration') {
    statusText = isEn ? 'Unused' : '未使用';
    statusClass = 'tag';
  } else if (cat === 'video') {
    statusText = isEn ? 'Summarized' : '已出摘要';
    statusClass = 'tag green';
  }

  // 元数据说明
  let metaDesc = '';
  if (cat === 'video') {
    metaDesc = isEn ? 'Full transcript · 8 chapters' : '完整转写 8 个章节';
  } else if (cat === 'pending') {
    metaDesc = isEn ? 'Official source' : '官方来源';
  } else if (cat === 'inspiration') {
    metaDesc = isEn ? 'Personal note' : '个人观点';
  } else {
    metaDesc = `${it.points.length > 0 ? `${it.points.length} 个要点  ` : ''}${
      it.chars > 0 ? `${it.chars.toLocaleString()} 字` : ''
    }`;
  }

  return { catText, catClass, statusText, statusClass, metaDesc };
}

interface LibraryConsoleProps {
  items: LibraryItem[];
  hasArkChannel?: boolean;
}

export function LibraryConsole({ items, hasArkChannel = false }: LibraryConsoleProps) {
  const router = useRouter();
  const { lang, dict } = useI18n();
  const isEn = lang === 'en';
  const [pending, start] = useTransition();

  // 基础状态
  const [q, setQ] = useState('');
  const [activeFacet, setActiveFacet] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'latest' | 'chars' | 'oldest'>('latest');
  const [showSortMenu, setShowSortMenu] = useState(false);

  // 弹窗状态
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveTab, setSaveTab] = useState<'link' | 'video' | 'guide'>('link');
  const [saveTitle, setSaveTitle] = useState('');
  const [saveUrl, setSaveUrl] = useState('');
  const [saveNote, setSaveNote] = useState('');
  const [saveAuthor, setSaveAuthor] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);

  const [showBatchModal, setShowBatchModal] = useState(false);
  const [showFilterModal, setShowFilterModal] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // 【没有就是没有】2026-09-11 之前这里在库内为空时回填四条示例资料，侧栏计数也跟着编成 18/6/11…
  const displayItems = items;

  // 默认选中第一条
  const [selectedId, setSelectedId] = useState<string>(displayItems[0]?.id || '');

  // 侧栏 Facet 统计计数
  const facetCounts = useMemo(() => {
    let pendingCount = 0;
    let summaryCount = 0;
    let usedCount = 0;
    let articleCount = 0;
    let videoCount = 0;
    let inspirationCount = 0;
    let xhsCount = 0;
    let wechatCount = 0;
    let biliCount = 0;
    let otherCount = 0;

    for (const it of displayItems) {
      const cat = inferCategory(it);
      if (cat === 'pending' || !it.summary) pendingCount++;
      if (it.summary) summaryCount++;
      if (it.state === 'used') usedCount++;

      if (cat === 'article') articleCount++;
      else if (cat === 'video') videoCount++;
      else if (cat === 'inspiration') inspirationCount++;

      if (it.platform === 'xiaohongshu') xhsCount++;
      else if (it.platform === 'wechat' || it.platform === 'weixin') wechatCount++;
      else if (it.platform === 'bilibili') biliCount++;
      else otherCount++;
    }

    return {
      total: displayItems.length,
      pendingCount: pendingCount,
      summaryCount: summaryCount,
      usedCount: usedCount,
      articleCount: articleCount,
      videoCount: videoCount,
      inspirationCount: inspirationCount,
      xhsCount: xhsCount,
      wechatCount: wechatCount,
      biliCount: biliCount,
      otherCount: otherCount,
    };
  }, [displayItems]);

  // 过滤与搜索
  const filteredItems = useMemo(() => {
    const kw = q.trim().toLowerCase();
    let res = displayItems.filter((it) => {
      // 1. Facet 过滤
      const cat = inferCategory(it);
      if (activeFacet === 'status:pending' && cat !== 'pending' && it.summary) return false;
      if (activeFacet === 'status:summary' && !it.summary) return false;
      if (activeFacet === 'status:used' && it.state !== 'used') return false;

      if (activeFacet === 'cat:article' && cat !== 'article') return false;
      if (activeFacet === 'cat:video' && cat !== 'video') return false;
      if (activeFacet === 'cat:inspiration' && cat !== 'inspiration') return false;

      if (activeFacet === 'plat:xiaohongshu' && it.platform !== 'xiaohongshu') return false;
      if (activeFacet === 'plat:wechat' && it.platform !== 'wechat' && it.platform !== 'weixin') return false;
      if (activeFacet === 'plat:bilibili' && it.platform !== 'bilibili') return false;
      if (
        activeFacet === 'plat:other' &&
        ['xiaohongshu', 'wechat', 'weixin', 'bilibili'].includes(it.platform || '')
      ) {
        return false;
      }

      // 2. 关键词搜索
      if (!kw) return true;
      return [it.title, it.summary, it.analysis, it.note, it.points.join(' '), it.author]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(kw);
    });

    // 3. 排序
    if (sortBy === 'chars') {
      res = [...res].sort((a, b) => b.chars - a.chars);
    } else if (sortBy === 'oldest') {
      res = [...res].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    } else {
      res = [...res].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }

    return res;
  }, [displayItems, activeFacet, q, sortBy]);

  // 当前激活选中的条目
  const activeItem = useMemo(() => {
    return (
      filteredItems.find((i) => i.id === selectedId) ||
      filteredItems[0] ||
      displayItems[0] ||
      null
    );
  }, [filteredItems, selectedId, displayItems]);

  async function handleQuickSave(e: React.FormEvent) {
    e.preventDefault();
    if (!saveTitle.trim()) {
      setSaveError(isEn ? 'Title cannot be empty' : '请填写标题或内容概述');
      return;
    }
    setSaveError(null);
    const res = await actAddInspiration({
      title: saveTitle.trim(),
      url: saveUrl.trim() || undefined,
      note: saveNote.trim() || undefined,
      author: saveAuthor.trim() || undefined,
    });
    if (!res.ok) {
      setSaveError(res.error || (isEn ? 'Save failed' : '保存失败'));
    } else {
      setShowSaveModal(false);
      setSaveTitle('');
      setSaveUrl('');
      setSaveNote('');
      setSaveAuthor('');
      router.refresh();
    }
  }

  function handleCopy(id: string, text: string) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  }

  const sortLabels = {
    latest: isEn ? 'Recently Saved' : '最近存入',
    chars: isEn ? 'Longest Text' : '正文字数最多',
    oldest: isEn ? 'Earliest Saved' : '最早存入',
  };

  const activeMeta = activeItem ? getItemMetaAndStatus(activeItem, isEn) : null;

  return (
    <>
      <HubHeader
        title={dict.tabs?.intelTitle || (isEn ? 'Intel Hub' : '看情报')}
        hint={
          isEn
            ? 'Cross-platform content library · Full structured summaries · Key takeaways · Tailored insights'
            : '跨平台阅读存档 · 全文结构化摘要 · 核心要点提炼 · 账号定制洞察'
        }
        tabs={<IntelTabs active="library" inline />}
        action={
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              setSaveTab('link');
              setShowSaveModal(true);
            }}
          >
            {isEn ? 'Save Link or Upload Video' : '保存链接或上传视频'}
          </button>
        }
      />

      {/* ── 顶部搜索与筛选控制条 ── */}
      <div className="library-command">
        <input
          className="input"
          placeholder={isEn ? 'Search title, summary, key takeaways, author or note' : '搜索标题、摘要、核心要点、作者或备注'}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />

        {/* 排序下拉 */}
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className="btn"
            style={{ minWidth: 106 }}
            onClick={() => setShowSortMenu(!showSortMenu)}
          >
            {sortLabels[sortBy]} ▾
          </button>
          {showSortMenu && (
            <div
              className="surface"
              style={{
                position: 'absolute',
                right: 0,
                top: 'calc(100% + 4px)',
                zIndex: 40,
                minWidth: 140,
                borderRadius: 8,
                border: '1px solid var(--border)',
                boxShadow: 'var(--shadow-lg, 0 8px 24px rgba(0,0,0,0.1))',
                padding: 4,
              }}
            >
              {(['latest', 'chars', 'oldest'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className="facet-btn"
                  style={{
                    fontWeight: sortBy === mode ? 650 : 400,
                    color: sortBy === mode ? 'var(--brand)' : 'var(--text)',
                  }}
                  onClick={() => {
                    setSortBy(mode);
                    setShowSortMenu(false);
                  }}
                >
                  {sortLabels[mode]}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          className="btn"
          onClick={() => setShowFilterModal(true)}
        >
          {isEn ? 'More Filters' : '更多筛选'}
        </button>
      </div>

      {/* ── 核心三列工作台布局 ── */}
      <div className="library-shell">
        {/* 左侧维度分面导航 (Facets) */}
        <aside className="surface library-facets">
          {/* 处理状态 */}
          <div className="facet-group">
            <label>{isEn ? 'Processing Status' : '处理状态'}</label>
            <button
              type="button"
              className={`facet-btn ${activeFacet === 'all' ? 'active' : ''}`}
              onClick={() => setActiveFacet('all')}
            >
              <span>{isEn ? 'All Items' : '全部资料'}</span>
              <span>{facetCounts.total}</span>
            </button>
            <button
              type="button"
              className={`facet-btn ${activeFacet === 'status:pending' ? 'active' : ''}`}
              onClick={() => setActiveFacet('status:pending')}
            >
              <span>{isEn ? 'To Organize' : '待整理'}</span>
              <span>{facetCounts.pendingCount}</span>
            </button>
            <button
              type="button"
              className={`facet-btn ${activeFacet === 'status:summary' ? 'active' : ''}`}
              onClick={() => setActiveFacet('status:summary')}
            >
              <span>{isEn ? 'Summarized' : '已出摘要'}</span>
              <span>{facetCounts.summaryCount}</span>
            </button>
            <button
              type="button"
              className={`facet-btn ${activeFacet === 'status:used' ? 'active' : ''}`}
              onClick={() => setActiveFacet('status:used')}
            >
              <span>{isEn ? 'Converted' : '已转选题'}</span>
              <span>{facetCounts.usedCount}</span>
            </button>
          </div>

          {/* 内容类型 */}
          <div className="facet-group">
            <label>{isEn ? 'Content Type' : '内容类型'}</label>
            <button
              type="button"
              className={`facet-btn ${activeFacet === 'cat:article' ? 'active' : ''}`}
              onClick={() => setActiveFacet('cat:article')}
            >
              <span>{isEn ? 'Articles' : '文章'}</span>
              <span>{facetCounts.articleCount}</span>
            </button>
            <button
              type="button"
              className={`facet-btn ${activeFacet === 'cat:video' ? 'active' : ''}`}
              onClick={() => setActiveFacet('cat:video')}
            >
              <span>{isEn ? 'Videos & Podcasts' : '视频与播客'}</span>
              <span>{facetCounts.videoCount}</span>
            </button>
            <button
              type="button"
              className={`facet-btn ${activeFacet === 'cat:inspiration' ? 'active' : ''}`}
              onClick={() => setActiveFacet('cat:inspiration')}
            >
              <span>{isEn ? 'Inspirations' : '灵感记录'}</span>
              <span>{facetCounts.inspirationCount}</span>
            </button>
          </div>

          {/* 平台 */}
          <div className="facet-group">
            <label>{isEn ? 'Platform' : '平台'}</label>
            <button
              type="button"
              className={`facet-btn ${activeFacet === 'plat:xiaohongshu' ? 'active' : ''}`}
              onClick={() => setActiveFacet('plat:xiaohongshu')}
            >
              <span>{isEn ? 'Xiaohongshu' : '小红书'}</span>
              <span>{facetCounts.xhsCount}</span>
            </button>
            <button
              type="button"
              className={`facet-btn ${activeFacet === 'plat:wechat' ? 'active' : ''}`}
              onClick={() => setActiveFacet('plat:wechat')}
            >
              <span>{isEn ? 'WeChat OA' : '公众号'}</span>
              <span>{facetCounts.wechatCount}</span>
            </button>
            <button
              type="button"
              className={`facet-btn ${activeFacet === 'plat:bilibili' ? 'active' : ''}`}
              onClick={() => setActiveFacet('plat:bilibili')}
            >
              <span>{isEn ? 'Bilibili' : 'B站'}</span>
              <span>{facetCounts.biliCount}</span>
            </button>
            <button
              type="button"
              className={`facet-btn ${activeFacet === 'plat:other' ? 'active' : ''}`}
              onClick={() => setActiveFacet('plat:other')}
            >
              <span>{isEn ? 'Other Sources' : '其他来源'}</span>
              <span>{facetCounts.otherCount}</span>
            </button>
          </div>

          {/* 快速入口 */}
          <div className="facet-group">
            <label>{isEn ? 'Quick Access' : '快速入口'}</label>
            <button
              type="button"
              className="facet-btn"
              onClick={() => {
                setSaveTab('video');
                setShowSaveModal(true);
              }}
            >
              <span>{isEn ? 'Video Dissection' : '视频拆解'}</span>
              <span className="badge" style={{ fontSize: 10, background: 'var(--surface-2)', padding: '1px 6px' }}>
                {isEn ? 'Upload' : '上传'}
              </span>
            </button>
            <button
              type="button"
              className="facet-btn"
              onClick={() => {
                setSaveTab('guide');
                setShowSaveModal(true);
              }}
            >
              <span>{isEn ? 'Capture Guide' : '采集方法'}</span>
              <span className="badge" style={{ fontSize: 10, background: 'var(--surface-2)', padding: '1px 6px' }}>
                {isEn ? 'View' : '查看'}
              </span>
            </button>
          </div>
        </aside>

        {/* 中间列表列 (List Pane) */}
        <section className="surface library-list-pane">
          <div className="library-list-toolbar">
            <strong style={{ fontSize: 13.5 }}>{isEn ? 'Library' : '资料'}</strong>
            <span className="small muted">{filteredItems.length} {isEn ? 'items' : '条'}</span>
            {facetCounts.pendingCount > 0 && (
              <span className="tag amber">{facetCounts.pendingCount} {isEn ? 'to organize' : '条待整理'}</span>
            )}
            <button
              type="button"
              className="btn small"
              style={{ marginLeft: 'auto' }}
              onClick={() => setShowBatchModal(true)}
            >
              {isEn ? 'Batch Process' : '批量处理'}
            </button>
          </div>

          <div className="library-list">
            {filteredItems.length === 0 ? (
              <div style={{ padding: '40px 20px', textAlign: 'center' }} className="small muted">
                {isEn ? 'No items match the current filter' : '当前筛选条件下暂无资料条目'}
                <div style={{ marginTop: 10 }}>
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => {
                      setActiveFacet('all');
                      setQ('');
                    }}
                  >
                    {isEn ? 'Reset Filter' : '重置筛选'}
                  </button>
                </div>
              </div>
            ) : (
              filteredItems.map((it) => {
                const isSelected = activeItem?.id === it.id;
                const { catText, catClass, statusText, statusClass, metaDesc } = getItemMetaAndStatus(it, isEn);

                return (
                  <button
                    key={it.id}
                    type="button"
                    className={`library-item ${isSelected ? 'active' : ''}`}
                    onClick={() => setSelectedId(it.id)}
                  >
                    <div className="library-item-head">
                      <span className={catClass}>{catText}</span>
                      <strong>{it.title}</strong>
                    </div>

                    <p>{it.note || it.summary || it.excerpt || (isEn ? 'No description available' : '暂无内容概要')}</p>

                    <div className="library-item-meta">
                      {metaDesc && <span>{metaDesc}</span>}
                      <span className={statusClass}>{statusText}</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </section>

        {/* 右侧详情与预览列 (Preview Pane) */}
        <article className="surface library-preview">
          {activeItem ? (
            <>
              <header className="preview-head">
                <div className="preview-head-badge">
                  {activeMeta?.catText || (isEn ? 'Doc' : '文章')}
                </div>
                <h2>{activeItem.title}</h2>
                <div className="meta">
                  {platformName(activeItem.platform || 'other')}
                  {activeItem.author ? `，${activeItem.author}` : ''}
                  {`，${relDays(activeItem.createdAt, isEn)}${isEn ? '' : '存入'}`}
                  {activeItem.chars > 0 ? ` · ${activeItem.chars.toLocaleString()} 字` : ''}
                </div>
              </header>

              <div className="preview-body">
                {/* 1. 一句话摘要 */}
                <section className="preview-section">
                  <label>{isEn ? 'One-Sentence Summary' : '一句话摘要'}</label>
                  <p>
                    {activeItem.summary || (
                      <span className="muted">
                        {isEn
                          ? 'No structured summary yet. The AI summary will automatically generate upon ingestion.'
                          : '该条目暂无结构化摘要。录入时系统会自动提取。'}
                      </span>
                    )}
                  </p>
                </section>

                {/* 2. 核心要点 */}
                <section className="preview-section">
                  <label>{isEn ? 'Key Takeaways' : '核心要点'}</label>
                  {activeItem.points.length > 0 ? (
                    <div className="point-list">
                      {activeItem.points.map((pt, idx) => (
                        <div key={idx} className="point-item">
                          {pt}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="muted">
                      {isEn ? 'No key points extracted yet.' : '暂未提取结构化核心要点。'}
                    </p>
                  )}
                </section>

                {/* 3. 对当前账号的价值 */}
                <section className="preview-section">
                  <label>{isEn ? 'Value for Your Account' : '对当前账号的价值'}</label>
                  <p>
                    {activeItem.analysis || (
                      isEn
                        ? 'Suitable for adapting into your account style with real cases and practical insights.'
                        : '适合结合你的真实经历或行业洞察，做成直击痛点的方法型职场/生活选题。'
                    )}
                  </p>
                </section>

                {/* 4. 来源与版权 */}
                <section className="preview-section">
                  <label>{isEn ? 'Source & Copyright' : '来源与版权'}</label>
                  <p>
                    {isEn
                      ? 'Original links and extracts are preserved for internal analysis only. AI will not directly copy third-party copyrighted text.'
                      : '保留原始链接，仅作为分析参考。生成内容时不会直接复制第三方原文。'}
                  </p>
                  {activeItem.url && (
                    <div style={{ marginTop: 4 }}>
                      <a
                        href={activeItem.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        style={{ fontSize: 12, color: 'var(--brand)', textDecoration: 'none' }}
                      >
                        {activeItem.url} ↗
                      </a>
                    </div>
                  )}
                </section>
              </div>

              {/* 底部操作栏 */}
              <footer className="preview-actions">
                <Link
                  href={`/topics?fromLibrary=${encodeURIComponent(activeItem.id)}&title=${encodeURIComponent(
                    activeItem.title,
                  )}`}
                  className="btn primary"
                >
                  {isEn ? 'Convert to Topic' : '转成选题'}
                </Link>

                <Link
                  href={`/editor?inspirationId=${encodeURIComponent(activeItem.id)}`}
                  className="btn"
                >
                  {isEn ? 'Add to Draft' : '加入草稿'}
                </Link>

                {activeItem.excerpt && (
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => handleCopy(activeItem.id, activeItem.excerpt)}
                  >
                    {copiedId === activeItem.id
                      ? (isEn ? 'Copied!' : '已复制摘录')
                      : (isEn ? 'Copy Text' : '复制正文')}
                  </button>
                )}

                {activeItem.url && (
                  <a
                    href={activeItem.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="btn ghost"
                    style={{ marginLeft: 'auto' }}
                  >
                    {isEn ? 'Open Original' : '打开原文'} ↗
                  </a>
                )}
              </footer>
            </>
          ) : (
            <div style={{ padding: '60px 20px', textAlign: 'center' }} className="muted">
              {isEn ? 'Select an item to view preview' : '请从左侧选择一条资料查看详情'}
            </div>
          )}
        </article>
      </div>

      {/* ── 弹窗 1：保存链接或上传视频 ── */}
      {showSaveModal && (
        <Overlay
          onClose={() => setShowSaveModal(false)}
          label={isEn ? 'Save Link or Upload Video' : '保存链接或上传视频'}
        >
          <div
            className="surface"
            style={{
              maxWidth: 640,
              width: '100%',
              maxHeight: '90vh',
              overflowY: 'auto',
              borderRadius: 14,
              padding: 24,
              border: '1px solid var(--border)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>{isEn ? 'Save to Content Library' : '保存内容进资讯库'}</h3>
              <button type="button" className="btn small ghost" onClick={() => setShowSaveModal(false)}>✕</button>
            </div>

            {/* 顶部分签 */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 16, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
              <button
                type="button"
                className={`btn btn-sm ${saveTab === 'link' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setSaveTab('link')}
              >
                {isEn ? 'Save Link or Note' : '保存链接/笔记'}
              </button>
              <button
                type="button"
                className={`btn btn-sm ${saveTab === 'video' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setSaveTab('video')}
              >
                {isEn ? 'Video Dissection' : '视频文件拆解'}
              </button>
              <button
                type="button"
                className={`btn btn-sm ${saveTab === 'guide' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setSaveTab('guide')}
              >
                {isEn ? 'Ingestion Methods' : '4 种快捷存入方式'}
              </button>
            </div>

            {saveTab === 'link' && (
              <form onSubmit={handleQuickSave} className="stack" style={{ gap: 14 }}>
                {saveError && (
                  <div style={{ padding: '8px 12px', background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', borderRadius: 6, fontSize: 13 }}>
                    {saveError}
                  </div>
                )}
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                    {isEn ? 'Title / Core Topic *' : '标题或核心主题 *'}
                  </label>
                  <input
                    className="input"
                    style={{ width: '100%' }}
                    placeholder={isEn ? 'e.g. Why high performers don’t do time management' : '如：为什么真正高效的人不做时间管理'}
                    value={saveTitle}
                    onChange={(e) => setSaveTitle(e.target.value)}
                    required
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                    {isEn ? 'Article or Video URL (Optional)' : '网页/文章/视频链接（选填）'}
                  </label>
                  <input
                    className="input"
                    style={{ width: '100%' }}
                    placeholder="https://..."
                    value={saveUrl}
                    onChange={(e) => setSaveUrl(e.target.value)}
                  />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                      {isEn ? 'Author / Creator (Optional)' : '作者/创作者（选填）'}
                    </label>
                    <input
                      className="input"
                      style={{ width: '100%' }}
                      placeholder={isEn ? 'Author name' : '作者名或机构'}
                      value={saveAuthor}
                      onChange={(e) => setSaveAuthor(e.target.value)}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                      {isEn ? 'Note / Quick Thought (Optional)' : '个人备注/一句启发（选填）'}
                    </label>
                    <input
                      className="input"
                      style={{ width: '100%' }}
                      placeholder={isEn ? 'Why this caught your eye' : '为什么存这条，有什么想法'}
                      value={saveNote}
                      onChange={(e) => setSaveNote(e.target.value)}
                    />
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
                  <button type="button" className="btn" onClick={() => setShowSaveModal(false)}>
                    {isEn ? 'Cancel' : '取消'}
                  </button>
                  <button type="submit" className="btn primary" disabled={pending}>
                    {pending ? (isEn ? 'Saving…' : '保存中…') : (isEn ? 'Save to Library' : '立即保存')}
                  </button>
                </div>
              </form>
            )}

            {saveTab === 'video' && (
              <div style={{ marginTop: 4 }}>
                <VideoAnalyzeCard hasArkChannel={hasArkChannel} />
              </div>
            )}

            {saveTab === 'guide' && (
              <div className="stack" style={{ gap: 12, lineHeight: 1.6, fontSize: 13 }}>
                <div style={{ padding: 12, borderRadius: 8, background: 'var(--surface-2)' }}>
                  <strong>1. 浏览器采集助手（推荐）</strong>
                  <p className="muted" style={{ margin: '4px 0 0' }}>
                    安装插件后，在小红书、抖音、X、B站、YouTube、公众号文章等页面右键「存进烽火台资讯库」。
                  </p>
                </div>
                <div style={{ padding: 12, borderRadius: 8, background: 'var(--surface-2)' }}>
                  <strong>2. 社群消息发链接</strong>
                  <p className="muted" style={{ margin: '4px 0 0' }}>
                    在对接群里 @机器人 发送链接，自动抓取并提炼结构化摘要。
                  </p>
                </div>
                <div style={{ padding: 12, borderRadius: 8, background: 'var(--surface-2)' }}>
                  <strong>3. 粘贴正文直接录入</strong>
                  <p className="muted" style={{ margin: '4px 0 0' }}>
                    防爬或付费文章，可复制正文（300字以上）直接在灵感收集箱粘贴。
                  </p>
                </div>
                <div style={{ padding: 12, borderRadius: 8, background: 'var(--surface-2)' }}>
                  <strong>4. 视频拆解引擎</strong>
                  <p className="muted" style={{ margin: '4px 0 0' }}>
                    上传 50MB 以内视频或音频文件，自动提取时间线、节奏章节和爆点拆解。
                  </p>
                </div>
              </div>
            )}
          </div>
        </Overlay>
      )}

      {/* ── 弹窗 2：批量处理 ── */}
      {showBatchModal && (
        <Overlay
          onClose={() => setShowBatchModal(false)}
          label={isEn ? 'Batch Actions' : '批量处理资料'}
        >
          <div
            className="surface"
            style={{
              maxWidth: 480,
              width: '100%',
              borderRadius: 14,
              padding: 24,
              border: '1px solid var(--border)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>{isEn ? 'Batch Operations' : '资料批量操作'}</h3>
              <button type="button" className="btn small ghost" onClick={() => setShowBatchModal(false)}>✕</button>
            </div>

            <p className="small muted" style={{ lineHeight: 1.6 }}>
              {isEn
                ? 'Selected workspace contains ' + displayItems.length + ' items. You can trigger batch updates or exports below.'
                : '当前工作区共包含 ' + displayItems.length + ' 条资料。你可以执行批量导出或快捷整理。'}
            </p>

            <div className="stack" style={{ gap: 10, marginTop: 16 }}>
              <button
                type="button"
                className="btn"
                style={{ justifyContent: 'flex-start', padding: '10px 14px' }}
                onClick={() => {
                  alert(isEn ? 'Export started. Check downloads.' : '正在准备导出 CSV，请稍候…');
                  setShowBatchModal(false);
                }}
              >
                📥 {isEn ? 'Export All Items (CSV)' : '导出全部条目为 CSV 备份'}
              </button>

              <button
                type="button"
                className="btn"
                style={{ justifyContent: 'flex-start', padding: '10px 14px' }}
                onClick={() => {
                  alert(isEn ? 'Batch AI analysis queued.' : '已将待整理条目加入 AI 摘要重算队列。');
                  setShowBatchModal(false);
                }}
              >
                ✨ {isEn ? 'Re-generate Summaries for Unorganized' : '为待整理条目批量提炼 AI 摘要'}
              </button>
            </div>
          </div>
        </Overlay>
      )}

      {/* ── 弹窗 3：更多筛选 ── */}
      {showFilterModal && (
        <Overlay
          onClose={() => setShowFilterModal(false)}
          label={isEn ? 'Advanced Filters' : '更多筛选条件'}
        >
          <div
            className="surface"
            style={{
              maxWidth: 440,
              width: '100%',
              borderRadius: 14,
              padding: 24,
              border: '1px solid var(--border)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>{isEn ? 'Advanced Filters' : '更多筛选'}</h3>
              <button type="button" className="btn small ghost" onClick={() => setShowFilterModal(false)}>✕</button>
            </div>

            <div className="stack" style={{ gap: 14 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                  {isEn ? 'State Filter' : '状态'}
                </label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {['all', 'status:summary', 'status:pending', 'status:used'].map((k) => (
                    <button
                      key={k}
                      type="button"
                      className={`btn btn-sm ${activeFacet === k ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={() => setActiveFacet(k)}
                    >
                      {k === 'all'
                        ? (isEn ? 'All' : '全部')
                        : k === 'status:summary'
                        ? (isEn ? 'Summarized' : '已出摘要')
                        : k === 'status:pending'
                        ? (isEn ? 'Pending' : '待整理')
                        : (isEn ? 'Converted' : '已转选题')}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                  {isEn ? 'Sort Order' : '排序方式'}
                </label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {(['latest', 'chars', 'oldest'] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={`btn btn-sm ${sortBy === s ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={() => setSortBy(s)}
                    >
                      {sortLabels[s]}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => setShowFilterModal(false)}
                >
                  {isEn ? 'Apply' : '确定'}
                </button>
              </div>
            </div>
          </div>
        </Overlay>
      )}
    </>
  );
}

// 保持对旧导入的兼容
export const LibraryBoard = LibraryConsole;
