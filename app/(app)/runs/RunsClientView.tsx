'use client';

import React from 'react';
import Link from 'next/link';
import { Card, Stat, Empty } from '@/components/ui';
import { Icon } from '@/components/icons';
import { fmtDateTime } from '@/lib/format';
import type { RunEntry, RunStatus } from '@/lib/runs/badge';
import { ActionButton } from '@/components/ActionButton';
import { actRerunWorkflow, actCancelBrowserTask } from './actions';
import { HubHeader } from '@/components/HubHeader';
import { RunsBatchExecute } from '@/components/RunsBatchExecute';
import { useI18n } from '@/lib/i18n';

const STATUS_CLASS: Record<RunStatus, string> = {
  waiting: 'badge-accent',
  running: 'badge-gray',
  done: 'badge-green',
  failed: 'badge-red',
  cancelled: 'badge-gray',
};

interface RunsClientViewProps {
  rows: RunEntry[];
  n: {
    waiting: number;
    running: number;
    failed: number;
    done: number;
  };
}

function RunRow({ r }: { r: RunEntry }) {
  const { lang, dict } = useI18n();
  const steps = r.steps ?? [];

  const statusText = dict.runs.status[r.status] || r.status;
  const kindText = dict.runs.kinds[r.kind] || r.kind;

  function getTargetLabel(href: string): string {
    const route = href.split(/[#?]/)[0];
    const itemInfo = dict.nav.items[route as keyof typeof dict.nav.items];
    if (itemInfo) return itemInfo.label;
    const coveredName = dict.nav.coveredPages[route as keyof typeof dict.nav.coveredPages];
    if (coveredName) return coveredName;
    return lang === 'en' ? 'Related Page' : '相关页面';
  }

  const targetLabel = getTargetLabel(r.href);

  return (
    <details className="run-row">
      <summary className="run-sum">
        <span className={`badge ${STATUS_CLASS[r.status]}`}>{statusText}</span>
        <span className="run-main">
          <span className="run-title">{r.title}</span>
          <span className="small muted">
            {kindText}
            {r.accountName ? ` · ${r.accountName}` : ''}
            {r.detail ? ` · ${r.detail}` : ''}
          </span>
        </span>
        <span className="small muted run-time">{fmtDateTime(r.at)}</span>
        <span className="run-caret" aria-hidden="true"><Icon.chevron size={15} /></span>
      </summary>
      <div className="run-body">
        {r.kind === 'agent' && (
          steps.length > 0 ? (
            <ol className="run-steps small">
              {steps.map((st) => {
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
          ) : (
            <p className="small muted">{dict.runs.noToolCalls}</p>
          )
        )}
        {r.kind !== 'agent' && r.detail && <p className="small muted">{r.detail}</p>}
        <div className="row wrap" style={{ gap: 8 }}>
          {r.href.split(/[#?]/)[0] !== '/runs' ? (
            <Link href={r.href} className="btn btn-sm">
              {r.status === 'waiting' && r.kind === 'agent'
                ? dict.runs.confirmStep
                : dict.runs.goTo.replace('{name}', targetLabel)}
            </Link>
          ) : (
            r.kind === 'browser' && r.status === 'waiting' && (
              <Link href="/extension" className="btn btn-sm">{dict.runs.checkExtension}</Link>
            )
          )}

          {r.kind === 'workflow' && (r.status === 'failed' || r.status === 'cancelled') && (
            <ActionButton
              action={actRerunWorkflow.bind(null, r.id)}
              loadingText={dict.runs.rerunning}
              confirmText={dict.runs.rerunConfirm}
            >
              {dict.runs.rerun}
            </ActionButton>
          )}

          {r.kind === 'browser' && r.status === 'waiting' && (
            <ActionButton action={actCancelBrowserTask.bind(null, r.id)} loadingText={dict.runs.cancelling}>
              {dict.runs.cancelBrowser}
            </ActionButton>
          )}
        </div>
      </div>
    </details>
  );
}

function RunGroup({ rows }: { rows: RunEntry[] }) {
  return (
    <div className="stack" style={{ gap: 2 }}>
      {rows.map((r) => <RunRow key={`${r.kind}-${r.id}`} r={r} />)}
    </div>
  );
}

export function RunsClientView({ rows, n }: RunsClientViewProps) {
  const { dict } = useI18n();

  const waiting = rows.filter((r) => r.status === 'waiting');
  const active = rows.filter((r) => r.status === 'running');
  const rest = rows.filter((r) => r.status !== 'waiting' && r.status !== 'running').slice(0, 30);

  return (
    <>
      <HubHeader
        title={dict.runs.pageTitle}
        hint={dict.runs.pageHint}
      />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label={dict.runs.statWaiting} value={n.waiting} foot={dict.runs.statWaitingFoot} />
        <Stat label={dict.runs.statRunning} value={n.running} foot={dict.runs.statRunningFoot} />
        <Stat label={dict.runs.statFailed} value={n.failed} foot={dict.runs.statFailedFoot} />
        <Stat label={dict.runs.statDone} value={n.done} foot={dict.runs.statDoneFoot} />
      </div>

      {waiting.length > 0 && (
        <Card
          title={dict.runs.cardWaitingTitle}
          sub={dict.runs.cardWaitingSub}
          style={{ marginBottom: 16 }}
          action={<RunsBatchExecute />}
        >
          <RunGroup rows={waiting} />
        </Card>
      )}

      {active.length > 0 && (
        <Card title={dict.runs.cardRunningTitle} sub={dict.runs.cardRunningSub} style={{ marginBottom: 16 }}>
          <RunGroup rows={active} />
        </Card>
      )}

      <Card title={dict.runs.cardRecentTitle} sub={dict.runs.cardRecentSub}>
        {rows.length === 0 ? (
          <Empty
            icon="🛰"
            text={dict.runs.emptyText}
          />
        ) : rest.length === 0 ? (
          <p className="small muted">{dict.runs.allInAbove}</p>
        ) : (
          <RunGroup rows={rest} />
        )}
      </Card>
    </>
  );
}
