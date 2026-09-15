'use client';

import React, { useState, useMemo } from 'react';
import Link from 'next/link';
import type { RunEntry, RunStatus } from '@/lib/runs/badge';
import { ActionButton } from '@/components/ActionButton';
import { actRerunWorkflow, actCancelBrowserTask } from './actions';
import { RunsBatchExecute } from '@/components/RunsBatchExecute';
import { useI18n } from '@/lib/i18n';
import { beijingDayKey } from '@/lib/beijing';

// 任务记录（运行中心）的界面。
//
// 【2026-09-11 之前这里有四条写死的示例运行】没有真实数据就渲染「发布职场沟通文章 · 等你确认」
// 这种假行，计数格印着 1/2/7/1，耗时是编的「4 分 12 秒」，「确认继续」「停止任务」两个按钮
// 点了只弹一句「已确认继续推进」什么都不做。新工作区的用户看到的是一个正在忙碌的假系统。
// 现在：没有就是没有（真实空状态）；耗时只对有发起时间且已结束的算，算不出就写「—」；
// 按钮只放真的能做的事（去看执行过程、重跑、取消采集）。源码守卫 tests/no-demo-fallback.test.ts。

interface RunsClientViewProps {
  rows: RunEntry[];
  n: {
    waiting: number;
    running: number;
    failed: number;
    done: number;
  };
}

/** 耗时：只对已结束且知道发起时间的算。进行中/等人不算「跑了多久」——挂起几小时的等待不是执行时间。 */
function fmtDuration(r: RunEntry): string {
  if (r.status === 'running') return '进行中';
  if (r.status === 'waiting') return '等人';
  if (!r.startedAt) return '—';
  const ms = new Date(r.at).getTime() - new Date(r.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs} 秒`;
  if (secs < 3600) return `${Math.floor(secs / 60)} 分 ${secs % 60} 秒`;
  return `${Math.floor(secs / 3600)} 时 ${Math.floor((secs % 3600) / 60)} 分`;
}

function fmtRunTime(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(date.getTime())) return '—';
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function exportRunsCsv(rows: RunEntry[]) {
  // CSV 公式注入：以 = + - @ 开头的单元格会被表格软件当公式执行，前面垫一个单引号
  const cell = (v: string) => `"${(/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;
  const headers = ['状态', '任务名称', '类型', '归属账号', '发起时间', '详情'];
  const lines = rows.map((r) => [
    r.status,
    cell(r.title || ''),
    r.kind,
    cell(r.accountName || ''),
    new Date(r.at).toISOString(),
    cell(r.detail || ''),
  ].join(','));
  const csvContent = '\uFEFF' + [headers.join(','), ...lines].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `runs-export-${beijingDayKey()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function RunsClientView({ rows, n }: RunsClientViewProps) {
  const { lang, dict } = useI18n();

  const [selectedId, setSelectedId] = useState<string>(() => {
    const firstWait = rows.find((r) => r.status === 'waiting');
    return firstWait ? firstWait.id : rows[0]?.id ?? '';
  });

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | RunStatus>('all');
  const [accountFilter, setAccountFilter] = useState<string>('all');

  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchTitle = r.title.toLowerCase().includes(q);
        const matchDetail = (r.detail || '').toLowerCase().includes(q);
        const matchAccount = (r.accountName || '').toLowerCase().includes(q);
        if (!matchTitle && !matchDetail && !matchAccount) return false;
      }
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (accountFilter !== 'all' && r.accountName !== accountFilter) return false;
      return true;
    });
  }, [rows, searchQuery, statusFilter, accountFilter]);

  const selectedRun = rows.find((r) => r.id === selectedId) || filteredRows[0] || rows[0];

  function getTargetLabel(href: string): string {
    const route = href.split(/[#?]/)[0];
    const itemInfo = dict.nav.items[route as keyof typeof dict.nav.items];
    if (itemInfo) return itemInfo.label;
    const coveredName = dict.nav.coveredPages[route as keyof typeof dict.nav.coveredPages];
    if (coveredName) return coveredName;
    return lang === 'en' ? 'Related Page' : '相关页面';
  }

  function renderStatusTag(status: RunStatus, compact?: boolean) {
    const dot = (color: string, label: string) => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: compact ? 11.5 : 12, color: 'var(--text-2)', fontWeight: 520, whiteSpace: 'nowrap' }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
        {label}
      </span>
    );
    switch (status) {
      case 'waiting':
        return compact
          ? dot('var(--amber)', dict.runs.status.waiting || '等你确认')
          : <span className="tag amber">{dict.runs.status.waiting || '等你确认'}</span>;
      case 'done':
        return compact
          ? dot('var(--green)', dict.runs.status.done || '已完成')
          : <span className="tag green">{dict.runs.status.done || '已完成'}</span>;
      case 'failed':
        return compact
          ? dot('var(--red)', dict.runs.status.failed || '失败')
          : <span className="tag brand">{dict.runs.status.failed || '失败'}</span>;
      case 'running':
        return compact
          ? dot('var(--accent)', dict.runs.status.running || '运行中')
          : <span className="tag">{dict.runs.status.running || '运行中'}</span>;
      case 'cancelled':
      default:
        return compact
          ? dot('var(--muted)', dict.runs.status.cancelled || '已取消')
          : <span className="tag">{dict.runs.status.cancelled || '已取消'}</span>;
    }
  }

  const accounts = useMemo(() => {
    const list: string[] = [];
    for (const r of rows) {
      if (r.accountName && !list.includes(r.accountName)) {
        list.push(r.accountName);
      }
    }
    return list;
  }, [rows]);

  const r = selectedRun;
  const targetLabel = r ? getTargetLabel(r.href) : '';
  const kindLabel = (k: RunEntry['kind']) => dict.runs.kinds[k as keyof typeof dict.runs.kinds] ?? k;

  return (
    <section className="page active" id="page-runs" aria-label={dict.runs.pageTitle || '任务记录'}>
      {rows.length > 0 && (
        <div className="wrap" style={{ justifyContent: 'flex-end', marginBottom: 16 }}>
          {rows.some((item) => item.status === 'waiting') && <RunsBatchExecute />}
          <button type="button" className="btn" onClick={() => exportRunsCsv(rows)}>
            {lang === 'en' ? 'Export records' : '导出记录'}
          </button>
        </div>
      )}

      <div className="metric-ribbon">
        <button type="button" className="metric-cell" aria-pressed={statusFilter === 'running'} onClick={() => setStatusFilter(statusFilter === 'running' ? 'all' : 'running')}>
          <span>正在运行</span>
          <strong>{n.running}</strong>
        </button>
        <button type="button" className="metric-cell" aria-pressed={statusFilter === 'waiting'} onClick={() => setStatusFilter(statusFilter === 'waiting' ? 'all' : 'waiting')}>
          <span>等你处理</span>
          <strong>{n.waiting}</strong>
        </button>
        <button type="button" className="metric-cell" aria-pressed={statusFilter === 'done'} onClick={() => setStatusFilter(statusFilter === 'done' ? 'all' : 'done')}>
          <span>已完成</span>
          <strong>{n.done}</strong>
        </button>
        <button type="button" className="metric-cell" aria-pressed={statusFilter === 'failed'} onClick={() => setStatusFilter(statusFilter === 'failed' ? 'all' : 'failed')}>
          <span>失败</span>
          <strong>{n.failed}</strong>
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="surface" style={{ padding: '40px 16px', textAlign: 'center' }}>
          <p className="muted small" style={{ margin: 0 }}>{dict.runs.emptyText}</p>
          <div className="row" style={{ justifyContent: 'center', gap: 8, marginTop: 12 }}>
            <Link href="/" className="btn primary">{lang === 'en' ? 'Dispatch a task' : '去派一件事'}</Link>
            <Link href="/workflows" className="btn">{lang === 'en' ? 'Run an agent' : '跑一个智能体'}</Link>
          </div>
        </div>
      ) : (
        <>
          <div className="command-bar surface">
            <input
              className="input"
              placeholder="搜索任务名称或结果"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <button
              type="button"
              className={`btn ${statusFilter !== 'all' ? 'primary' : ''}`}
              onClick={() => {
                const nextStatus: Record<string, 'all' | RunStatus> = {
                  all: 'waiting',
                  waiting: 'running',
                  running: 'done',
                  done: 'failed',
                  failed: 'all',
                };
                setStatusFilter(nextStatus[statusFilter] || 'all');
              }}
            >
              {statusFilter === 'all'
                ? '全部状态'
                : statusFilter === 'waiting'
                ? '等你处理'
                : statusFilter === 'running'
                ? '运行中'
                : statusFilter === 'done'
                ? '已完成'
                : '失败'}
            </button>
            <button
              type="button"
              className={`btn ${accountFilter !== 'all' ? 'primary' : ''}`}
              onClick={() => {
                if (accounts.length === 0) return;
                const curIdx = accounts.indexOf(accountFilter);
                if (curIdx === -1) setAccountFilter(accounts[0]);
                else if (curIdx === accounts.length - 1) setAccountFilter('all');
                else setAccountFilter(accounts[curIdx + 1]);
              }}
            >
              {accountFilter === 'all' ? '全部账号' : accountFilter}
            </button>
          </div>

          <div className="two-panel">
            <section className="surface">
              {filteredRows.length === 0 ? (
                <div style={{ padding: '40px 16px', textAlign: 'center' }} className="muted small">
                  暂无匹配的任务记录
                </div>
              ) : (
                filteredRows.map((item) => {
                  const isActive = selectedRun?.id === item.id;
                  return (
                    <div
                      key={`${item.kind}-${item.id}`}
                      className={`run-row ${isActive ? 'active' : ''}`}
                      onClick={() => setSelectedId(item.id)}
                    >
                      {renderStatusTag(item.status, true)}
                      <div>
                        <strong>{item.title}</strong>
                        <div className="meta">
                          {kindLabel(item.kind)}
                          {item.accountName ? ` · ${item.accountName}` : ''}
                          {item.detail ? ` · ${item.detail}` : ''}
                        </div>
                      </div>
                      <span title={new Date(item.at).toLocaleString()}>{fmtRunTime(item.at)}</span>
                      <span>{fmtDuration(item)}</span>
                    </div>
                  );
                })
              )}
            </section>

            <aside className="surface" style={{ position: 'sticky', top: 12 }}>
              <div className="surface-head">
                <strong>{lang === 'en' ? 'Details' : '详情'}</strong>
              </div>
              <div className="surface-body stack" style={{ gap: 16 }}>
                {r ? (
                  <>
                    <div>
                      <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 620, lineHeight: 1.4 }}>{r.title}</h2>
                      <div className="row wrap" style={{ gap: 6 }}>
                        {renderStatusTag(r.status)}
                        <span className="tag">{kindLabel(r.kind)}</span>
                      </div>
                    </div>

                    <div className="detail-block">
                      <label>{lang === 'en' ? 'Status' : '现状'}</label>
                      <p>{r.detail || (r.status === 'done' ? '已结束。' : r.status === 'running' ? '系统正在推进。' : '—')}</p>
                    </div>

                    {(r.accountName || r.memberName) && (
                      <div className="detail-block">
                        <label>{lang === 'en' ? 'Attribution' : '归属'}</label>
                        <p>
                          {r.accountName ? `${lang === 'en' ? 'Account' : '账号'}：${r.accountName}` : ''}
                          {r.accountName && r.memberName ? ' · ' : ''}
                          {r.memberName ? `${lang === 'en' ? 'By' : '发起人'}：${r.memberName}` : ''}
                        </p>
                      </div>
                    )}

                    {r.steps && r.steps.length > 0 && (
                      <div className="detail-block">
                        <label>{lang === 'en' ? 'Steps' : '执行明细'}（{r.steps.filter((s) => s.ok).length}/{r.steps.length} {lang === 'en' ? 'passed' : '步成功'}）</label>
                        <ol className="run-steps small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                          {r.steps.map((st) => {
                            const stepKindText = dict.runs.stepKinds[st.kind as keyof typeof dict.runs.stepKinds] ?? st.kind;
                            return (
                              <li key={st.seq} className={st.ok ? undefined : 'run-step-bad'}>
                                <strong>{stepKindText}</strong>
                                {st.tool ? ` ${st.tool}` : ''}
                                {st.result ? ` — ${st.result}` : ''}
                              </li>
                            );
                          })}
                        </ol>
                      </div>
                    )}

                    <div className="stack" style={{ gap: 8, marginTop: 2 }}>
                      {r.kind === 'agent' ? (
                        <Link href={r.href} className="btn primary" style={{ textAlign: 'center' }}>
                          {r.status === 'waiting' ? (dict.runs.confirmStep || '去确认这一步 →') : (lang === 'en' ? 'View Process →' : '看执行过程 →')}
                        </Link>
                      ) : r.kind === 'browser' && r.status === 'waiting' ? (
                        <Link href="/extension" className="btn primary" style={{ textAlign: 'center' }}>
                          {dict.runs.checkExtension}
                        </Link>
                      ) : r.href.split(/[#?]/)[0] !== '/runs' ? (
                        <Link href={r.href} className="btn" style={{ textAlign: 'center' }}>
                          {dict.runs.goTo.replace('{name}', targetLabel)}
                        </Link>
                      ) : null}

                      {r.kind === 'workflow' && (r.status === 'failed' || r.status === 'cancelled') && (
                        <ActionButton
                          action={actRerunWorkflow.bind(null, r.id)}
                          loadingText={dict.runs.rerunning}
                          confirmText={dict.runs.rerunConfirm}
                          className="btn"
                        >
                          {dict.runs.rerun}
                        </ActionButton>
                      )}

                      {r.kind === 'browser' && r.status === 'waiting' && (
                        <ActionButton
                          action={actCancelBrowserTask.bind(null, r.id)}
                          loadingText={dict.runs.cancelling}
                          className="btn danger"
                        >
                          {dict.runs.cancelBrowser}
                        </ActionButton>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="muted small">{lang === 'en' ? 'Select a task to view details' : '请在左侧选择一个任务查看详情'}</p>
                )}
              </div>
            </aside>
          </div>
        </>
      )}
    </section>
  );
}
