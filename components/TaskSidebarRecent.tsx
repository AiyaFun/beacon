'use client';

import React from 'react';
import Link from 'next/link';
import type { RunEntry, RunStatus } from '@/lib/runs/badge';
import { useI18n } from '@/lib/i18n';

const STATUS_DOT: Record<RunStatus, string> = {
  waiting: 'dot-amber',
  running: 'dot-green',
  done: 'dot-green',
  failed: 'dot-red',
  cancelled: 'dot-gray',
};

const STATUS_LABEL_ZH: Record<RunStatus, string> = {
  waiting: '等你确认',
  running: '正在跑',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export function TaskSidebarRecent({ rows }: { rows: { row: RunEntry; times: number }[] }) {
  const { lang, dict } = useI18n();

  return (
    <div className="nav-group task-recent">
      <div className="nav-group-title">{dict.shell.recentTasks}</div>
      {rows.length === 0 ? (
        <p className="small muted" style={{ padding: '2px 10px' }}>
          {lang === 'en' ? 'No tasks yet. Try dispatching from New Task.' : '还没有任务。去「新任务」说一句话试试。'}
        </p>
      ) : (
        rows.map(({ row: r, times }) => {
          const statusText = lang === 'en' ? dict.runs.status[r.status] : STATUS_LABEL_ZH[r.status];
          return (
            <Link
              key={`${r.kind}-${r.id}`}
              href={r.href}
              className="task-item"
              title={`${statusText} · ${r.title}`}
            >
              <span className={`dot ${STATUS_DOT[r.status]}`} />
              <span className="task-item-text">{r.title}</span>
              {times > 1 && <span className="task-item-times">×{times}</span>}
            </Link>
          );
        })
      )}
      {rows.length > 0 && (
        <Link href="/runs" className="small muted task-more">
          {dict.shell.viewAllRuns}
        </Link>
      )}
    </div>
  );
}
