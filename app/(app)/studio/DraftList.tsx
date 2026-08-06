'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Empty } from '@/components/ui';

// 左栏草稿列表：搜索 + 状态筛选 + 定高自滚。
//
// 【为什么要拆成客户端组件】原来这里是服务端直接 map 出全部草稿。草稿是只增不减的东西，
// 写到第 30 篇时这一栏就有两千多像素高，把它下面的「版本时间线」永远顶到屏幕外；
// 而找一篇旧稿只能靠肉眼从头扫。列表定高自滚 + 搜索筛选，两个问题一起解决，
// 也让整页高度不再被草稿数量决定。

export type DraftRow = {
  id: string;
  title: string;
  status: string;
  statusText: string;
  statusCls: string;
  platformName: string;
  platformColor: string;
  versionCount: number;
  /** 服务端算好的「3小时前」。relTime 读 Date.now()，在客户端自己算必然 hydration 不一致 */
  lastLabel: string;
};

// 超过这个条数才启用内部滚动：少量草稿时定高会在卡片底部留一片空白，很难看
const SCROLL_FROM = 6;

export function DraftList({
  drafts,
  selectedId,
  emptyText,
}: {
  drafts: DraftRow[];
  selectedId?: string;
  emptyText: string;
}) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');

  // 状态筛选只列**这个账号真的有的**状态：摆一个 0 篇的「已搁置」按钮，点下去只会得到一片空白
  const statuses = useMemo(() => {
    const seen = new Map<string, { text: string; n: number }>();
    for (const d of drafts) {
      const cur = seen.get(d.status);
      if (cur) cur.n += 1;
      else seen.set(d.status, { text: d.statusText, n: 1 });
    }
    return [...seen.entries()].map(([key, v]) => ({ key, ...v }));
  }, [drafts]);

  const shown = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return drafts.filter(
      (d) => (status === 'all' || d.status === status) && (!kw || d.title.toLowerCase().includes(kw)),
    );
  }, [drafts, q, status]);

  if (drafts.length === 0) return <Empty icon="📝" text={emptyText} />;

  const scrolls = drafts.length > SCROLL_FROM;

  return (
    <div className="stack" style={{ gap: 10 }}>
      {/* 搜索与筛选只在草稿多到需要找的时候才出现——3 篇稿子摆一个搜索框是噪音 */}
      {drafts.length > 3 && (
        <>
          <input
            className="input"
            style={{ fontSize: 12.5, padding: '7px 12px' }}
            placeholder={`搜索这 ${drafts.length} 篇草稿的标题…`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {statuses.length > 1 && (
            <div className="row wrap" style={{ gap: 6 }}>
              <button
                className={`btn btn-sm ${status === 'all' ? 'btn-accent' : 'btn-ghost'}`}
                onClick={() => setStatus('all')}
              >
                全部 {drafts.length}
              </button>
              {statuses.map((s) => (
                <button
                  key={s.key}
                  className={`btn btn-sm ${status === s.key ? 'btn-accent' : 'btn-ghost'}`}
                  onClick={() => setStatus(s.key)}
                >
                  {s.text} {s.n}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {shown.length === 0 ? (
        <div className="small muted" style={{ padding: '12px 2px' }}>
          没有匹配的草稿。换个关键词，或点上面「全部」。
        </div>
      ) : (
        <div
          className={scrolls ? 'stack rail-scroll' : 'stack'}
          style={scrolls ? { gap: 8, maxHeight: 'min(46vh, 460px)' } : { gap: 8 }}
        >
          {shown.map((d) => {
            const active = d.id === selectedId;
            return (
              <Link
                key={d.id}
                href={`/studio?draft=${d.id}`}
                className="card"
                style={{
                  padding: 12,
                  boxShadow: 'none',
                  display: 'block',
                  background: active ? 'var(--surface-2)' : 'transparent',
                  borderColor: active ? 'var(--brand)' : undefined,
                }}
              >
                <div className="row-between" style={{ gap: 8 }}>
                  <b className="small" style={{ fontSize: 13, lineHeight: 1.4 }}>{d.title}</b>
                  <span className="badge" style={{ background: 'var(--surface-2)', color: d.platformColor }}>
                    {d.platformName}
                  </span>
                </div>
                <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
                  <span className={`badge ${d.statusCls}`}>{d.statusText}</span>
                  <span className="badge badge-gray">{d.versionCount} 版</span>
                  <span className="small muted">最新 {d.lastLabel}</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
