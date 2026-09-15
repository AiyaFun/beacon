'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { actToggleSchedule } from './schedule-actions';
import { AGENT_STATE_LABEL, type AgentState } from '@/lib/agent/overview-state';

// 两栏面板：左边「反复要做的事」= 真实的定时计划；右边「可用智能体」= 真实装了的模板。
//
// 【2026-09-11 之前这里是三条写死的示例】「每周一生成选题清单」「选题策划 · 可用」……
// 新工作区一条定时都没配，页面上也亮着三条「已启用」；开关一拨只改本地 state，刷新就回去。
// 用户据此以为自己已经配好了定时，然后等着看不存在的稿子。
// 现在：没有就显示没有；开关真的写库；每一行都能点进档案或去改。

export type RoutineItem = {
  id: string;
  label: string;
  when: string;
  enabled: boolean;
  autoPaused: boolean;
  lastStatus: string | null;
  lastError: string | null;
};

export type AgentItem = {
  id: string;
  emoji: string;
  name: string;
  meta: string;
  state: AgentState;
  stateReason: string;
};

export function WorkflowsTwoPanel({ routines, agents, readOnly, scheduleWorks }: {
  routines: RoutineItem[];
  agents: AgentItem[];
  readOnly: boolean;
  scheduleWorks: boolean;
}) {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState('');

  function toggle(id: string, enabled: boolean) {
    setErr('');
    start(async () => {
      const r = await actToggleSchedule(id, enabled);
      if (!r.ok) { setErr(isEn ? 'Failed to update' : '没改成'); return; }
      router.refresh();
    });
  }

  function openNew() {
    window.dispatchEvent(new CustomEvent('beacon:new-schedule'));
  }

  return (
    <div className="two-panel" style={{ marginBottom: 16 }}>
      <section className="surface">
        <div className="surface-head" style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <strong>{isEn ? 'Recurring Routines' : '反复要做的事'}</strong>
          <span className="meta">{isEn ? `${routines.length} scheduled` : `${routines.length} 条定时`}</span>
        </div>
        {err && <p className="small" style={{ color: 'var(--red)', margin: '8px 14px 0' }}>{err}</p>}
        {routines.length === 0 ? (
          <div className="surface-body small muted">
            {scheduleWorks
              ? (isEn ? 'No scheduled routines yet. ' : '还没有定时计划。')
              : (isEn ? 'Scheduling is not active on this host. ' : '这台机器上没有在跑定时，配了也不会到点触发。')}
            {scheduleWorks && !readOnly && (
              <button type="button" className="btn small primary" style={{ marginLeft: 8 }} onClick={openNew}>{isEn ? 'New schedule' : '新建一条'}</button>
            )}
          </div>
        ) : (
          <div className="plain-list">
            {routines.map((r) => (
              <div key={r.id} className="plain-row">
                <div className="avatar">{r.when.slice(0, 1)}</div>
                <div className="plain-row-main">
                  <strong>{r.label}</strong>
                  <span>
                    {r.when}
                    {r.autoPaused ? (isEn ? ' · auto-paused after failures' : ' · 连续失败已自动停用') : ''}
                    {r.lastStatus === 'failed' && r.enabled ? (isEn ? ' · last run failed' : ' · 上次失败') : ''}
                    {r.lastError && !r.autoPaused ? ` · ${r.lastError}` : ''}
                  </span>
                </div>
                <button
                  type="button"
                  className={`switch ${r.enabled ? 'on' : ''}`}
                  aria-label={r.enabled ? (isEn ? 'Enabled' : '已启用') : (isEn ? 'Disabled' : '未启用')}
                  disabled={readOnly || pending}
                  onClick={() => toggle(r.id, !r.enabled)}
                />
                <a className="btn small" href="#schedules">{isEn ? 'Manage' : '去改'}</a>
              </div>
            ))}
          </div>
        )}
      </section>

      <aside className="stack">
        <section className="surface">
          <div className="surface-head" style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
            <strong>{isEn ? 'Installed Agents' : '已装的智能体'}</strong>
          </div>
          {agents.length === 0 ? (
            <div className="surface-body small muted">{isEn ? 'No agents installed. Pick one from the market below.' : '还没装任何智能体。到下面的市场里装一个。'}</div>
          ) : (
            <div className="support-list">
              {agents.map((a) => {
                const st = AGENT_STATE_LABEL[a.state];
                return (
                  <Link key={a.id} href={`/workflows?agent=${a.id}`} className="support-row" style={{ textDecoration: 'none', color: 'inherit' }} title={a.stateReason}>
                    <div style={{ minWidth: 0 }}>
                      <strong>{a.emoji} {a.name}</strong>
                      <div className="meta" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.meta || (isEn ? 'No role note yet' : '还没写职责说明')}</div>
                    </div>
                    <span className={`badge ${st.cls}`}>{isEn ? st.en : st.zh}</span>
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      </aside>
    </div>
  );
}
