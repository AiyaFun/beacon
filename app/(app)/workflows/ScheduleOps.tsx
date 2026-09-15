'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actRunScheduleNow, actSkipScheduleToday, actToggleSchedule } from './schedule-actions';
import { useI18n } from '@/lib/i18n/context';
import type { OccurrenceFlag } from '@/lib/workflow/schedule-occurrences';

// 定时运营中心（2026-09-11）：从「配了一个定时」升级为「能预测、发现冲突、处理失败和控制成本」。
//
// 这里只画服务端算好的实例（lib/workflow/schedule-occurrences.ts），不自己算时间——
// 时区与上限口径只能有一处。动作只有三种：现在跑（补跑）、跳过今天、停用/启用。

export type OccurrenceItem = {
  scheduleId: string;
  label: string;
  accountName?: string;
  /** ISO */
  at: string;
  dayKey: string;
  time: string;
  dayOffset: number;
  flags: OccurrenceFlag[];
  source: string;
  estCalls: number | null;
};

export type PausedItem = { id: string; label: string; when: string; autoPaused: boolean; lastError: string | null };

export type OpsSummary = { total: number; missed: number; capped: number; overlap: number; estCallsMax: number; unknownEst: number };

const FLAG: Record<OccurrenceFlag, { zh: string; en: string; cls: string; title: string }> = {
  missed: { zh: '错过了', en: 'Missed', cls: 'badge-red', title: '过了扫描窗口还没跑：这台机器上的定时器当时没跑到它' },
  capped: { zh: '会被上限拦下', en: 'Over daily cap', cls: 'badge-amber', title: '同一天排在每日上限之后：到点会被拦，除非前面的没跑' },
  overlap: { zh: '撞车', en: 'Overlap', cls: 'badge-amber', title: '同一账号同一分钟还有别的计划' },
  done_today: { zh: '今天已跑', en: 'Ran today', cls: 'badge-green', title: '' },
  skipped_today: { zh: '今天已跳过', en: 'Skipped today', cls: 'badge-gray', title: '' },
};

function dayTitle(offset: number, dayKey: string, isEn: boolean): string {
  const base = offset === 0 ? (isEn ? 'Today' : '今天') : offset === 1 ? (isEn ? 'Tomorrow' : '明天') : '';
  return base ? `${base} · ${dayKey.slice(5)}` : dayKey.slice(5);
}

export function ScheduleOps({
  items,
  paused,
  summary,
  maxPerDay,
  readOnly,
  days,
}: {
  items: OccurrenceItem[];
  paused: PausedItem[];
  summary: OpsSummary;
  maxPerDay: number;
  readOnly: boolean;
  days: number;
}) {
  const router = useRouter();
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ text: string; bad: boolean; href?: string } | null>(null);

  function run(fn: () => Promise<{ ok: boolean; error?: string; runHref?: string }>, okText: string) {
    setMsg(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) { setMsg({ text: r.error ?? (isEn ? 'Failed' : '没成功'), bad: true }); return; }
      setMsg({ text: okText, bad: false, href: r.runHref });
      router.refresh();
    });
  }

  const byDay = useMemo(() => {
    const m = new Map<string, OccurrenceItem[]>();
    for (const o of items) {
      const arr = m.get(o.dayKey) ?? [];
      arr.push(o);
      m.set(o.dayKey, arr);
    }
    return [...m.entries()];
  }, [items]);

  if (items.length === 0 && paused.length === 0) {
    return <p className="small muted" style={{ margin: 0 }}>{isEn ? 'No scheduled tasks yet — nothing to project.' : '还没有定时计划，所以也没有未来的实例可看。新建在页头右上。'}</p>;
  }

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row wrap small" style={{ gap: 12 }}>
        <span><strong>{summary.total}</strong> {isEn ? `runs in next ${days} days` : `次 · 未来 ${days} 天`}</span>
        {summary.missed > 0 && <span style={{ color: 'var(--red)' }}><strong>{summary.missed}</strong> {isEn ? 'missed' : '次错过'}</span>}
        {summary.capped > 0 && <span style={{ color: 'var(--amber-ink, var(--muted))' }}><strong>{summary.capped}</strong> {isEn ? 'over cap' : '次会被上限拦下'}</span>}
        {summary.overlap > 0 && <span style={{ color: 'var(--amber-ink, var(--muted))' }}><strong>{summary.overlap}</strong> {isEn ? 'overlaps' : '次撞车'}</span>}
        <span className="muted" title={isEn ? 'Upper bound from call budgets / costly steps, not real spend' : '按调用预算 / 会花钱的步数算的上界，不是真实花费'}>
          {isEn ? 'Up to' : '最多约'} <strong>{summary.estCallsMax}</strong> {isEn ? 'AI calls' : '次 AI 调用'}
          {summary.unknownEst > 0 && (isEn ? ` (+${summary.unknownEst} unknown)` : `（另 ${summary.unknownEst} 次估不了）`)}
        </span>
        <span className="muted">{isEn ? `Cap ${maxPerDay}/day` : `每天上限 ${maxPerDay} 次`}</span>
      </div>

      {msg && (
        <p className="small" style={{ margin: 0, color: msg.bad ? 'var(--red)' : 'var(--green, inherit)' }}>
          {msg.text}{msg.href && <> · <a href={msg.href}>{isEn ? 'View run →' : '去看这次运行 →'}</a></>}
        </p>
      )}

      {byDay.map(([dayKey, list]) => (
        <div key={dayKey}>
          <div className="small muted" style={{ marginBottom: 4 }}>{dayTitle(list[0].dayOffset, dayKey, isEn)}</div>
          <div className="stack" style={{ gap: 2 }}>
            {list.map((o) => {
              const consumed = o.flags.includes('done_today') || o.flags.includes('skipped_today');
              const missed = o.flags.includes('missed');
              return (
                <div key={`${o.scheduleId}-${o.dayKey}`} className="tool-row">
                  <span className="run-main">
                    <span className="row wrap" style={{ gap: 6 }}>
                      <span className="badge badge-gray" style={{ fontVariantNumeric: 'tabular-nums' }}>{o.time}</span>
                      <strong style={{ fontSize: 13 }}>{o.label}</strong>
                      {o.accountName && <span className="small muted">{o.accountName}</span>}
                      {o.flags.map((f) => (
                        <span key={f} className={`badge ${FLAG[f].cls}`} title={FLAG[f].title}>{isEn ? FLAG[f].en : FLAG[f].zh}</span>
                      ))}
                    </span>
                    <span className="small muted">
                      {o.source}
                      {o.estCalls != null && (isEn ? ` · up to ${o.estCalls} calls` : ` · 最多 ${o.estCalls} 次调用`)}
                    </span>
                  </span>
                  {!readOnly && o.dayOffset === 0 && !consumed && (
                    <span className="row" style={{ gap: 6, flexShrink: 0 }}>
                      <button
                        className="btn btn-sm"
                        disabled={pending}
                        title={missed ? (isEn ? 'Run now and count as today' : '补跑：算作今天这一次，到点不再跑第二遍') : (isEn ? 'Run once now; today\'s slot still runs' : '额外跑一次；今天到点仍会跑')}
                        onClick={() => run(() => actRunScheduleNow(o.scheduleId, missed), isEn ? 'Dispatched' : '派出去了')}
                      >
                        {missed ? (isEn ? 'Catch up' : '补跑') : (isEn ? 'Run now' : '现在跑一次')}
                      </button>
                      <button
                        className="btn btn-sm btn-ghost"
                        disabled={pending}
                        onClick={() => run(() => actSkipScheduleToday(o.scheduleId), isEn ? 'Skipped today' : '今天这次跳过了')}
                      >
                        {isEn ? 'Skip today' : '跳过今天'}
                      </button>
                      <button
                        className="btn btn-sm btn-ghost"
                        disabled={pending}
                        onClick={() => run(() => actToggleSchedule(o.scheduleId, false), isEn ? 'Paused' : '已停用')}
                      >
                        {isEn ? 'Pause' : '停用'}
                      </button>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {paused.length > 0 && (
        <div>
          <div className="small muted" style={{ marginBottom: 4 }}>{isEn ? 'Paused (not projected)' : '已停用（不排进时间轴）'}</div>
          <div className="stack" style={{ gap: 2 }}>
            {paused.map((p) => (
              <div key={p.id} className="tool-row">
                <span className="run-main">
                  <span className="row wrap" style={{ gap: 6 }}>
                    <strong style={{ fontSize: 13 }}>{p.label}</strong>
                    <span className="badge badge-gray">{p.when}</span>
                    {p.autoPaused && <span className="badge badge-red">{isEn ? 'Auto-paused on failures' : '连续失败已自动停用'}</span>}
                  </span>
                  {p.lastError && <span className="small muted">{p.lastError}</span>}
                </span>
                {!readOnly && (
                  <button className="btn btn-sm" disabled={pending} onClick={() => run(() => actToggleSchedule(p.id, true), isEn ? 'Enabled' : '已重新启用')}>
                    {isEn ? 'Enable' : '重新启用'}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
