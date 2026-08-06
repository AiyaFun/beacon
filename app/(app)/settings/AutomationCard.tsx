'use client';

import { useState, useTransition } from 'react';
import { AUTOMATION_ITEMS, type AutomationConfig, type AutomationKey } from '@/lib/jobs/automation';
import { actSetAutomation, actRunJobNow } from './automation-actions';

export type LastRun = { status: string; detail: string | null; at: string } | null;

// 「立即运行」只对本工作区可范围化的任务开放；backfill 由里程碑驱动、alerts 事件驱动，只展示开关
const RUNNABLE = new Set(['daily_recommend', 'generate_reviews', 'weekly_review', 'optimize_memory']);

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3600_000);
  if (h < 1) return '刚刚';
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

export function AutomationCard({ config, lastRuns }: { config: AutomationConfig; lastRuns: Record<string, LastRun> }) {
  const [cfg, setCfg] = useState<AutomationConfig>(config);
  const [pending, start] = useTransition();
  const [runMsg, setRunMsg] = useState<Record<string, string>>({});

  function toggle(key: AutomationKey) {
    const next = !cfg[key];
    const prev = { ...cfg };
    setCfg((c) => ({ ...c, [key]: next }));
    start(async () => {
      try {
        const r = await actSetAutomation({ [key]: next });
        if (r.ok) setCfg(r.config);
        else setCfg(prev);
      } catch {
        setCfg(prev);
      }
    });
  }

  function runNow(job: string) {
    setRunMsg((m) => ({ ...m, [job]: '运行中…' }));
    start(async () => {
      const r = await actRunJobNow(job);
      setRunMsg((m) => ({ ...m, [job]: r.ok ? `✓ ${r.detail}` : `✗ ${r.error}` }));
    });
  }

  return (
    <div className="stack" style={{ gap: 14 }}>
      {AUTOMATION_ITEMS.map((it) => {
        const on = cfg[it.key];
        const last = it.job ? lastRuns[it.job] : null;
        const runnable = it.job !== null && RUNNABLE.has(it.job);
        const runKey = it.job ?? '';
        return (
          <div key={it.key} style={{ borderBottom: '1px solid var(--border)', paddingBottom: 12 }}>
            <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
              <div className="stack" style={{ gap: 3 }}>
                <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <span style={{ fontWeight: 600 }}>{it.label}</span>
                  {it.advanced && <span className="badge badge-gray" style={{ fontSize: 11 }}>高级</span>}
                </div>
                <span className="small muted" style={{ lineHeight: 1.5 }}>{it.desc}</span>
                {last && (
                  <span className="small muted">
                    上次运行：<span style={{ color: last.status === 'ok' ? 'var(--green)' : last.status === 'failed' ? 'var(--red)' : 'var(--text-3)' }}>{last.status === 'ok' ? '成功' : last.status === 'failed' ? '失败' : last.status}</span>
                    {last.detail ? ` · ${last.detail}` : ''} · {relTime(last.at)}
                  </span>
                )}
                {runKey && runMsg[runKey] && <span className="small" style={{ color: 'var(--brand)' }}>{runMsg[runKey]}</span>}
              </div>
              <div className="row" style={{ gap: 8, alignItems: 'center', flexShrink: 0 }}>
                {runnable && (
                  <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => runNow(it.job as string)}>立即运行</button>
                )}
                <button
                  role="switch"
                  aria-checked={on}
                  disabled={pending}
                  onClick={() => toggle(it.key)}
                  title={on ? '点击关闭' : '点击开启'}
                  style={{
                    width: 42,
                    height: 24,
                    borderRadius: 12,
                    border: 'none',
                    cursor: pending ? 'default' : 'pointer',
                    background: on ? 'var(--brand)' : 'var(--surface-2)',
                    position: 'relative',
                    transition: 'background 0.2s',
                  }}
                >
                  <span
                    style={{
                      position: 'absolute',
                      top: 3,
                      left: on ? 21 : 3,
                      width: 18,
                      height: 18,
                      borderRadius: '50%',
                      background: '#fff',
                      transition: 'left 0.2s',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                    }}
                  />
                </button>
              </div>
            </div>
          </div>
        );
      })}
      <div className="small muted" style={{ lineHeight: 1.6 }}>
        关闭任何自动化都不会删除已有数据或断开链路，重新开启即恢复。热榜采集等全平台共享任务不在此列（对个人开关无意义）。
      </div>
    </div>
  );
}
