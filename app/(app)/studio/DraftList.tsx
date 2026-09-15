'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Empty } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { VersionCompare, type CompareVersion } from './VersionCompare';

// 左栏草稿列表：搜索 + 状态筛选 + 定高自滚。

export type DraftRow = {
  id: string;
  title: string;
  status: string;
  statusText: string;
  statusCls: string;
  platformName: string;
  platformColor: string;
  versionCount: number;
  lastLabel: string;
  latestVersion?: {
    seq: number;
    authorType: string;
    timeLabel: string;
  };
};

const STATUS_LABELS_EN: Record<string, string> = {
  draft: 'Draft',
  editing: 'Editing',
  checking: 'Checking',
  ready: 'Ready',
  published: 'Published',
  shelved: 'Shelved',
  abandoned: 'Abandoned',
};

function platformTagClass(name: string): string {
  if (name.includes('公众号') || name.toLowerCase().includes('wechat')) return 'green';
  if (name.includes('红书') || name.toLowerCase().includes('xhs')) return 'brand';
  return '';
}

export function DraftList({
  drafts,
  selectedId,
  emptyText,
  versions,
}: {
  drafts: DraftRow[];
  selectedId?: string;
  emptyText: string;
  versions?: CompareVersion[];
}) {
  const { lang } = useI18n();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const [showFilter, setShowFilter] = useState(false);

  const statuses = useMemo(() => {
    const seen = new Map<string, { text: string; n: number }>();
    for (const d of drafts) {
      const cur = seen.get(d.status);
      const labelText = lang === 'en' ? (STATUS_LABELS_EN[d.status] ?? d.statusText) : d.statusText;
      if (cur) cur.n += 1;
      else seen.set(d.status, { text: labelText, n: 1 });
    }
    return [...seen.entries()].map(([key, v]) => ({ key, ...v }));
  }, [drafts, lang]);

  const shown = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return drafts.filter(
      (d) => (status === 'all' || d.status === status) && (!kw || d.title.toLowerCase().includes(kw)),
    );
  }, [drafts, q, status]);

  return (
    <>
      <div className="surface-head">
        <strong>{lang === 'en' ? 'Drafts' : '草稿'}</strong>
        <span className="meta">{drafts.length} {lang === 'en' ? 'drafts' : '篇'}</span>
      </div>

      <div className="surface-body" style={{ paddingBottom: 7 }}>
        <div className="draft-search">
          <input
            className="input"
            placeholder={lang === 'en' ? 'Search drafts' : '搜索草稿'}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button
            type="button"
            className={`btn small ${showFilter ? 'primary' : ''}`}
            onClick={() => setShowFilter((v) => !v)}
            title={lang === 'en' ? 'Filter by status' : '按状态筛选'}
          >
            {lang === 'en' ? 'Filter' : '筛选'}
          </button>
        </div>

        {showFilter && statuses.length > 1 && (
          <div className="row wrap" style={{ gap: 4, marginTop: 8 }}>
            <button
              type="button"
              className={`tag ${status === 'all' ? 'brand' : ''}`}
              style={{ cursor: 'pointer', border: 'none' }}
              onClick={() => setStatus('all')}
            >
              {lang === 'en' ? 'All' : '全部'} {drafts.length}
            </button>
            {statuses.map((s) => (
              <button
                key={s.key}
                type="button"
                className={`tag ${status === s.key ? 'brand' : ''}`}
                style={{ cursor: 'pointer', border: 'none' }}
                onClick={() => setStatus(s.key)}
              >
                {s.text} {s.n}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="draft-list">
        {drafts.length === 0 ? (
          <div style={{ padding: '24px 12px' }}>
            <Empty icon="📝" text={emptyText} />
          </div>
        ) : shown.length === 0 ? (
          <div className="small muted" style={{ padding: '16px 12px', textAlign: 'center' }}>
            {lang === 'en' ? 'No matching drafts.' : '没有匹配的草稿'}
          </div>
        ) : (
          shown.map((d) => {
            const active = d.id === selectedId;
            const statusLabel = lang === 'en' ? (STATUS_LABELS_EN[d.status] ?? d.statusText) : d.statusText;
            const tagCls = platformTagClass(d.platformName);

            return (
              <div key={d.id}>
                <Link
                  href={`/studio?draft=${d.id}`}
                  className={`draft-row ${active ? 'active' : ''}`}
                >
                  <strong>{d.title}</strong>
                  <div className="draft-row-meta">
                    <span className={`tag ${tagCls}`}>{d.platformName}</span>
                    <span className="meta">{statusLabel}</span>
                    <span className="meta">{d.lastLabel}</span>
                  </div>
                </Link>

                {active && (
                  <div className="version-inline">
                    <div className="row-between" style={{ gap: 6, alignItems: 'flex-start' }}>
                      <div>
                        {`v${d.latestVersion?.seq ?? d.versionCount} ${d.latestVersion?.authorType ?? (lang === 'en' ? 'AI Draft' : 'AI 初稿')}`}
                        <br />
                        <span className="muted">
                          {lang === 'en'
                            ? `Current version, ${d.latestVersion?.timeLabel ?? d.lastLabel}`
                            : `当前版本，${d.latestVersion?.timeLabel ?? d.lastLabel}`}
                        </span>
                      </div>
                      {versions && versions.length >= 2 && (
                        <div style={{ flexShrink: 0 }}>
                          <VersionCompare versions={versions} draftId={d.id} />
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
