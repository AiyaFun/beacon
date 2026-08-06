'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui';
import { platformName } from '@/lib/constants';
import { actArchiveInspiration, actRestoreInspiration, actDeleteInspiration } from '../inspiration/actions';

// 资讯库列表：按平台筛 + 关键词搜 + 展开看正文摘录。
//
// 筛选与搜索都在前端做（一页最多 200 条，服务端已截）——加一轮请求换不来任何体验，
// 反而让「点一下平台徽标立刻筛」这种手感变成等待。

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

export function LibraryBoard({ items }: { items: LibraryItem[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [platform, setPlatform] = useState<string>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);

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
    return items.filter((it) => {
      if (platform !== 'all' && (it.platform ?? 'other') !== platform) return false;
      if (!kw) return true;
      // 搜标题、摘要、要点、备注——正文没下发到前端，所以搜不到正文里的词，这是刻意的取舍
      return [it.title, it.summary, it.analysis, it.note, it.points.join(' '), it.author]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(kw);
    });
  }, [items, platform, q]);

  function run(fn: () => Promise<unknown>) {
    start(async () => {
      await fn();
      router.refresh();
    });
  }

  if (items.length === 0) {
    return (
      <Card title="资讯库还是空的">
        <p className="small muted" style={{ lineHeight: 1.7 }}>
          用上面四条路中的任意一条存第一条进来。最省事的是：在任意内容页上右键 →
          「存进烽火台资讯库（含正文摘要）」；作品页上则是右键 →「一键拆解这条作品」。
        </p>
      </Card>
    );
  }

  return (
    <Card title={`库内内容（${shown.length}/${items.length}）`} sub="点标题展开正文摘录">
      <div className="row wrap" style={{ gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <button className={`btn btn-sm ${platform === 'all' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setPlatform('all')}>
          全部 {items.length}
        </button>
        {platforms.map(([k, n]) => (
          <button
            key={k}
            className={`btn btn-sm ${platform === k ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setPlatform(k)}
          >
            {k === 'other' ? '其它' : platformName(k)} {n}
          </button>
        ))}
        <input
          className="input"
          style={{ marginLeft: 'auto', width: 200, padding: '6px 10px' }}
          placeholder="搜标题 / 摘要 / 要点"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="stack" style={{ gap: 10 }}>
        {shown.map((it) => (
          <div key={it.id} style={{ padding: 12, borderRadius: 10, border: '1px solid var(--border)' }}>
            <div className="row-between" style={{ gap: 12, alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row wrap" style={{ gap: 8, alignItems: 'center', marginBottom: 4 }}>
                  <b
                    style={{ cursor: 'pointer' }}
                    onClick={() => setOpen(open === it.id ? null : it.id)}
                    title="点开看正文摘录"
                  >
                    {it.title}
                  </b>
                  {it.platform && <span className="badge badge-gray">{platformName(it.platform)}</span>}
                  {it.state === 'used' && <span className="badge badge-green">已转选题</span>}
                  {it.state === 'archived' && <span className="badge badge-gray">已归档</span>}
                </div>

                {it.summary && <p className="small" style={{ margin: '4px 0', lineHeight: 1.65 }}>{it.summary}</p>}
                {it.points.length > 0 && (
                  <ul className="small muted" style={{ margin: '4px 0 4px 16px', padding: 0, lineHeight: 1.65 }}>
                    {it.points.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                )}
                {it.analysis && (
                  <p className="small" style={{ margin: '4px 0', lineHeight: 1.65 }}>
                    <b>对你的用处：</b>
                    {it.analysis}
                  </p>
                )}
                {!it.summary && (
                  <p className="small muted" style={{ margin: '4px 0' }}>
                    （这条只存了正文，摘要没生成——多半是当时 AI 配额用完了）
                  </p>
                )}

                {open === it.id && it.excerpt && (
                  <div
                    className="small"
                    style={{
                      marginTop: 8, padding: 10, borderRadius: 8, background: 'var(--surface-2)',
                      whiteSpace: 'pre-wrap', lineHeight: 1.7, maxHeight: 240, overflow: 'auto',
                    }}
                  >
                    {it.excerpt}
                    {it.chars > it.excerpt.length && (
                      <span className="muted">…（全文 {it.chars} 字，看原文请点下方链接）</span>
                    )}
                  </div>
                )}

                <div className="small muted row wrap" style={{ gap: 8, marginTop: 6 }}>
                  <span>{relDays(it.createdAt)}存入</span>
                  {it.author && <span>· {it.author}</span>}
                  {it.chars > 0 && <span>· 正文 {it.chars} 字</span>}
                  {it.url && (
                    <a href={it.url} target="_blank" rel="noreferrer noopener">
                      看原文
                    </a>
                  )}
                </div>
              </div>

              <div className="row" style={{ gap: 6 }}>
                {it.state === 'open' ? (
                  <button className="btn btn-sm" disabled={pending} onClick={() => run(() => actArchiveInspiration(it.id))}>
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
                    if (window.confirm('删除后这条正文与摘要都不再保留。继续？')) run(() => actDeleteInspiration(it.id));
                  }}
                >
                  删除
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <p className="small muted" style={{ marginTop: 12 }}>
        库里的条目会参与每日选题推荐（与灵感收集箱同一条出口）。存的是他人作品，仅供分析参考，别直接复用其文字。
      </p>
    </Card>
  );
}
