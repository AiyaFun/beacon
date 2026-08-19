'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui';
import { Icon } from '@/components/icons';
import { platformName } from '@/lib/constants';
import { actArchiveInspiration, actRestoreInspiration, actDeleteInspiration } from '../inspiration/actions';

// 资讯库列表：按平台筛 + 状态筛 + 排序 + 关键词搜 + 展开看正文摘录。

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

function relDays(iso: string): string {
  const n = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (n <= 0) return '今天';
  if (n === 1) return '昨天';
  if (n < 30) return `${n} 天前`;
  return `${Math.floor(n / 30)} 个月前`;
}

// 平台颜色标识辅助
function platformBadgeStyle(platform: string | null): { bg: string; color: string } {
  switch (platform) {
    case 'xiaohongshu':
      return { bg: 'rgba(255, 36, 66, 0.12)', color: '#ff2442' };
    case 'douyin':
      return { bg: 'rgba(22, 24, 35, 0.12)', color: '#161823' };
    case 'weixin':
    case 'wechat':
      return { bg: 'rgba(7, 193, 96, 0.12)', color: '#07c160' };
    case 'bilibili':
      return { bg: 'rgba(0, 174, 236, 0.12)', color: '#00aeec' };
    case 'youtube':
      return { bg: 'rgba(255, 0, 0, 0.12)', color: '#ff0000' };
    case 'x':
    case 'twitter':
      return { bg: 'rgba(29, 155, 240, 0.12)', color: '#1d9bf0' };
    case 'zhihu':
      return { bg: 'rgba(0, 132, 255, 0.12)', color: '#0084ff' };
    default:
      return { bg: 'var(--surface-2)', color: 'var(--fg-muted)' };
  }
}

export function LibraryBoard({ items }: { items: LibraryItem[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [platform, setPlatform] = useState<string>('all');
  const [stateFilter, setStateFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'latest' | 'chars' | 'oldest'>('latest');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const platforms = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of items) {
      const k = it.platform ?? 'other';
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [items]);

  const shown = useMemo(() => {
    const kw = q.trim().toLowerCase();
    let res = items.filter((it) => {
      // 1. 平台筛选
      if (platform !== 'all' && (it.platform ?? 'other') !== platform) return false;
      // 2. 状态筛选
      if (stateFilter === 'summary' && !it.summary) return false;
      if (stateFilter === 'nosummary' && it.summary) return false;
      if (stateFilter === 'used' && it.state !== 'used') return false;
      if (stateFilter === 'archived' && it.state !== 'archived') return false;
      if (stateFilter === 'open' && it.state !== 'open') return false;

      // 3. 关键词搜索
      if (!kw) return true;
      return [it.title, it.summary, it.analysis, it.note, it.points.join(' '), it.author]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(kw);
    });

    // 4. 排序 logic
    if (sortBy === 'chars') {
      res = [...res].sort((a, b) => b.chars - a.chars);
    } else if (sortBy === 'oldest') {
      res = [...res].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    } else {
      res = [...res].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }

    return res;
  }, [items, platform, stateFilter, sortBy, q]);

  function run(fn: () => Promise<unknown>) {
    start(async () => {
      await fn();
      router.refresh();
    });
  }

  function handleCopy(id: string, text: string) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  }

  if (items.length === 0) {
    return (
      <Card
        title={
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <Icon.file size={20} />
            <span>资讯库暂无内容</span>
          </div>
        }
      >
        <div style={{ textAlign: 'center', padding: '30px 20px' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>📭</div>
          <h3 style={{ margin: '0 0 8px 0', fontSize: '1.1rem', fontWeight: 600 }}>开始积累你的第一条热门资讯</h3>
          <p className="small muted" style={{ maxWidth: 500, margin: '0 auto 16px auto', lineHeight: 1.6 }}>
            在任意网文或作品页右键 → 选择<b>「存进烽火台资讯库」</b>；或在群里粘贴链接/正文，系统将自动抓取存入并提取 AI 结构化要点。
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card
      title={
        <div className="row wrap" style={{ gap: 10, alignItems: 'center' }}>
          <span>资讯库内容看板</span>
          <span className="badge badge-primary" style={{ fontSize: '0.8rem' }}>
            {shown.length} / {items.length} 条
          </span>
        </div>
      }
      sub="点击资讯标题或「展开正文」看原文摘录，提取爆款分析"
    >
      {/* 筛选与搜索工具栏 */}
      <div className="stack" style={{ gap: 12, marginBottom: 16 }}>
        {/* 1. 平台 Pill 列表 */}
        <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
          <button
            className={`btn btn-sm ${platform === 'all' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setPlatform('all')}
          >
            全部平台 ({items.length})
          </button>
          {platforms.map(([k, n]) => {
            const badge = platformBadgeStyle(k);
            const isSelected = platform === k;
            return (
              <button
                key={k}
                className={`btn btn-sm ${isSelected ? 'btn-primary' : 'btn-ghost'}`}
                style={
                  !isSelected && k !== 'other'
                    ? { border: '1px solid var(--border)', background: badge.bg, color: badge.color }
                    : undefined
                }
                onClick={() => setPlatform(k)}
              >
                {k === 'other' ? '其它来源' : platformName(k)} ({n})
              </button>
            );
          })}
        </div>

        {/* 2. 状态筛选 + 排序 + 搜索框 */}
        <div className="row wrap" style={{ gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
            <span className="small muted">状态：</span>
            <button
              className={`btn btn-sm ${stateFilter === 'all' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setStateFilter('all')}
            >
              全部状态
            </button>
            <button
              className={`btn btn-sm ${stateFilter === 'summary' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setStateFilter('summary')}
            >
              已出摘要
            </button>
            <button
              className={`btn btn-sm ${stateFilter === 'used' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setStateFilter('used')}
            >
              已转选题
            </button>
            <button
              className={`btn btn-sm ${stateFilter === 'archived' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setStateFilter('archived')}
            >
              已归档
            </button>
          </div>

          <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
            {/* 排序选择 */}
            <select
              className="input"
              style={{ padding: '4px 8px', fontSize: '0.85rem' }}
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as 'latest' | 'chars' | 'oldest')}
            >
              <option value="latest">按最新存入</option>
              <option value="chars">按正文字数最多</option>
              <option value="oldest">按最早存入</option>
            </select>

            {/* 搜素框 */}
            <div style={{ position: 'relative', width: 220 }}>
              <input
                className="input"
                style={{ width: '100%', padding: '6px 30px 6px 28px', fontSize: '0.85rem' }}
                placeholder="搜标题 / 摘要 / 洞察"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }}>
                <Icon.search size={14} />
              </span>
              {q && (
                <button
                  style={{
                    position: 'absolute',
                    right: 6,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--muted)',
                    padding: 2,
                  }}
                  onClick={() => setQ('')}
                >
                  <Icon.x size={14} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 无结果反馈 */}
      {shown.length === 0 && (
        <div style={{ padding: '40px 20px', textAlign: 'center' }} className="muted small">
          未找到匹配筛选或搜索条件（"{q}"）的资讯条目。
          <button
            className="btn btn-sm btn-ghost"
            style={{ marginLeft: 8 }}
            onClick={() => {
              setPlatform('all');
              setStateFilter('all');
              setQ('');
            }}
          >
            重置筛选条件
          </button>
        </div>
      )}

      {/* 资讯列表网格 */}
      <div className="stack" style={{ gap: 12 }}>
        {shown.map((it) => {
          const badgeStyle = platformBadgeStyle(it.platform);
          const isOpened = open === it.id;

          return (
            <div
              key={it.id}
              style={{
                padding: 16,
                borderRadius: 12,
                border: '1px solid var(--border)',
                background: 'var(--surface-1)',
                transition: 'all 0.2s ease',
              }}
            >
              <div className="row-between wrap" style={{ gap: 12, alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {/* 标题 & Badge 行 */}
                  <div className="row wrap" style={{ gap: 8, alignItems: 'center', marginBottom: 8 }}>
                    <b
                      style={{
                        fontSize: '1.02rem',
                        cursor: 'pointer',
                        color: 'var(--fg)',
                        lineHeight: 1.4,
                      }}
                      onClick={() => setOpen(isOpened ? null : it.id)}
                      title="点击展开/收起正文"
                    >
                      {it.title}
                    </b>

                    {it.platform && (
                      <span
                        className="badge"
                        style={{ background: badgeStyle.bg, color: badgeStyle.color, fontWeight: 500 }}
                      >
                        {platformName(it.platform)}
                      </span>
                    )}
                    {it.state === 'used' && <span className="badge badge-emerald">已转选题</span>}
                    {it.state === 'archived' && <span className="badge badge-gray">已归档</span>}
                  </div>

                  {/* AI 结构化摘要 */}
                  {it.summary ? (
                    <div
                      style={{
                        margin: '8px 0',
                        padding: '10px 14px',
                        borderRadius: 8,
                        background: 'var(--surface-2)',
                        borderLeft: '3px solid var(--primary)',
                      }}
                    >
                      <div
                        className="row small"
                        style={{ gap: 6, alignItems: 'center', fontWeight: 600, color: 'var(--primary)', marginBottom: 4 }}
                      >
                        <Icon.sparkles size={14} />
                        <span>AI 结构化摘要</span>
                      </div>
                      <p className="small" style={{ margin: 0, lineHeight: 1.65, color: 'var(--fg)' }}>
                        {it.summary}
                      </p>
                    </div>
                  ) : (
                    <p className="small muted" style={{ margin: '6px 0' }}>
                      ℹ️（该条目暂未提炼 AI 摘要——可能因录入时 AI 配额用完，后续可重新触发）
                    </p>
                  )}

                  {/* 结构化核心要点 */}
                  {it.points.length > 0 && (
                    <div style={{ margin: '8px 0' }}>
                      <div className="small muted" style={{ marginBottom: 4, fontWeight: 500 }}>
                        核心要点提炼：
                      </div>
                      <div className="row wrap" style={{ gap: 6 }}>
                        {it.points.map((p, i) => (
                          <div
                            key={i}
                            className="small"
                            style={{
                              padding: '4px 10px',
                              borderRadius: 6,
                              background: 'var(--surface-2)',
                              border: '1px solid var(--border)',
                              lineHeight: 1.4,
                            }}
                          >
                            • {p}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 账号用处 / 洞察提示框 */}
                  {it.analysis && (
                    <div
                      style={{
                        margin: '8px 0',
                        padding: '8px 12px',
                        borderRadius: 8,
                        background: 'rgba(255, 179, 0, 0.08)',
                        border: '1px solid rgba(255, 179, 0, 0.25)',
                      }}
                    >
                      <div className="small" style={{ lineHeight: 1.65, color: 'var(--fg)' }}>
                        <b style={{ color: '#d97706' }}>💡 对你账号的落地用处：</b>
                        {it.analysis}
                      </div>
                    </div>
                  )}

                  {/* 展收正文预览框 */}
                  {isOpened && it.excerpt && (
                    <div style={{ marginTop: 10 }}>
                      <div className="row-between" style={{ marginBottom: 4, padding: '0 4px' }}>
                        <span className="small muted">正文预览（前 {it.excerpt.length} 字）：</span>
                        <button
                          className="btn btn-sm btn-ghost small"
                          onClick={() => handleCopy(it.id, it.excerpt)}
                          style={{ padding: '2px 8px', fontSize: '0.78rem' }}
                        >
                          <Icon.copy size={12} />
                          {copiedId === it.id ? '已复制！' : '复制摘录'}
                        </button>
                      </div>
                      <div
                        className="small"
                        style={{
                          padding: 12,
                          borderRadius: 8,
                          background: 'var(--surface-2)',
                          border: '1px solid var(--border)',
                          whiteSpace: 'pre-wrap',
                          lineHeight: 1.7,
                          maxHeight: 260,
                          overflow: 'auto',
                          fontFamily: 'inherit',
                        }}
                      >
                        {it.excerpt}
                        {it.chars > it.excerpt.length && (
                          <div className="muted" style={{ marginTop: 8, fontStyle: 'italic' }}>
                            …（全文共 {it.chars} 字，查看全文请点击下方「查看原文」）
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* 底部元数据栏 */}
                  <div className="small muted row wrap" style={{ gap: 10, marginTop: 10, alignItems: 'center' }}>
                    <button
                      className="btn btn-sm btn-ghost"
                      style={{ padding: '2px 6px', fontSize: '0.78rem' }}
                      onClick={() => setOpen(isOpened ? null : it.id)}
                    >
                      {isOpened ? '▲ 收起正文' : '▼ 展开正文预览'}
                    </button>
                    <span>·</span>
                    <span>{relDays(it.createdAt)}存入</span>
                    {it.author && <span>· 作者: {it.author}</span>}
                    {it.chars > 0 && <span>· 全文 {it.chars} 字</span>}
                    {it.url && (
                      <a
                        href={it.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="row"
                        style={{ gap: 4, alignItems: 'center', textDecoration: 'none', color: 'var(--primary)' }}
                      >
                        <span>查看原文</span>
                        <Icon.external size={12} />
                      </a>
                    )}
                  </div>
                </div>

                {/* 右侧动作按钮 */}
                <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                  {it.state === 'open' ? (
                    <button
                      className="btn btn-sm"
                      disabled={pending}
                      onClick={() => run(() => actArchiveInspiration(it.id))}
                      title="归档后不再在每日推荐中频繁展示"
                    >
                      <Icon.archive size={14} />
                      归档
                    </button>
                  ) : (
                    <button className="btn btn-sm" disabled={pending} onClick={() => run(() => actRestoreInspiration(it.id))}>
                      放回
                    </button>
                  )}
                  <button
                    className="btn btn-sm btn-ghost"
                    disabled={pending}
                    onClick={() => {
                      if (window.confirm('删除后此正文与 AI 摘要将不再保留。确定删除？')) run(() => actDeleteInspiration(it.id));
                    }}
                    title="删除此条内容"
                  >
                    <Icon.trash size={14} />
                    删除
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div
        className="small muted row"
        style={{
          marginTop: 16,
          gap: 6,
          alignItems: 'center',
          padding: '10px 14px',
          background: 'var(--surface-2)',
          borderRadius: 8,
        }}
      >
        <Icon.info size={14} style={{ flexShrink: 0 }} />
        <span>
          资讯库中的条目会自动参与每日选题推演（与灵感收集箱共享选题出口）。第三方作品内容仅供分析参考，请勿未经授权直接公开发布原文。
        </span>
      </div>
    </Card>
  );
}
