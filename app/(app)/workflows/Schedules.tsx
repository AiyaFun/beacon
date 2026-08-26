'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actCreateSchedule, actToggleSchedule, actDeleteSchedule } from './schedule-actions';
import { scheduleWhen, DOW } from '@/lib/workflow/schedule-format';

// 定时智能体：让一条模板每天/每周自己跑。
//
// 【界面上必须先把账说清楚】这是唯一一个「用户睡着时会花他钱」的功能。
// 所以三件事写在脸上，不藏进说明文档：每天最多跑几次、连续失败会自动停、只建计划不真发。

export type ScheduleRow = {
  id: string;
  templateName: string;
  atHour: number;
  atMinute: number;
  weekdays: number[];
  enabled: boolean;
  failStreak: number;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
};

export type AgentOption = { id: string; name: string };

// 「什么时候跑」的说法搬到 lib/workflow/schedule-format.ts：AI 的 list_schedules
// 也要说同一句话，两处各写一份迟早对不上（空数组=每天这个口径尤其容易写反）
const whenText = (r: ScheduleRow) => scheduleWhen(r.weekdays, r.atHour, r.atMinute);

export function Schedules({
  rows,
  agents,
  maxSchedules,
  maxRunsPerDay,
  autoPauseFails,
  readOnly,
  scheduleWorks,
}: {
  rows: ScheduleRow[];
  agents: AgentOption[];
  maxSchedules: number;
  maxRunsPerDay: number;
  autoPauseFails: number;
  readOnly: boolean;
  /** 这个部署形态的后台定时**真的会跑**吗（见 lib/edition.ts 的 backgroundSchedule） */
  scheduleWorks: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState('');
  const [form, setForm] = useState({ templateId: agents[0]?.id ?? '', hour: 9, minute: 0, weekdays: [] as number[] });

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setErr('');
    start(async () => {
      const r = await fn();
      if (!r.ok) { setErr(r.error ?? '操作失败'); return; }
      router.refresh();
    });
  }

  const full = rows.length >= maxSchedules;

  // 定时不会跑的形态（整机版只启一个 next start，用的是空实现的进程内队列）：
  // 直接说清楚，不给配。让用户配一个永不执行的计划比不给这个功能更糟——
  // 他会以为配好了，然后等着看不存在的稿子。
  if (!scheduleWorks) {
    return (
      <div>
        {/* 措辞不写死成某一档形态：这条分支现在**只剩本机开发**会走到
            （整机版 2026-08-21 起是 BEACON_QUEUE=local，定时跑在 web 进程里）。
            只说事实——这台机器上没有在跑，以及怎么才有。 */}
        <p className="small muted" style={{ marginTop: 0 }}>
          这台机器上没有在跑定时，配了也不会到点触发，所以这里暂不提供定时计划。
          需要的话：在上面的智能体卡片上点「跑一遍」手动触发；
          或把 <code>BEACON_QUEUE</code> 设成 <code>local</code>（定时跑在网站进程里，整机版就是这么装的）、
          设成 <code>bullmq</code> 并起一个 worker 进程（私有化 compose 里有这个服务）。
        </p>
      </div>
    );
  }

  return (
    <div>
      <p className="small muted" style={{ marginTop: 0 }}>
        {/* 这里是 JSX 不是 markdown：写 **粗体** 会把星号原样印在页面上 */}
        定时跑的是会花钱的东西，所以有三道闸：每个工作区<strong>每天最多跑 {maxRunsPerDay} 次</strong>、
        连续失败 {autoPauseFails} 次自动停用、发布那一步只建计划不会真的发出去。时刻按北京时间。
      </p>

      {err && <p className="small" style={{ color: 'var(--red)' }}>{err}</p>}

      {rows.length === 0 ? (
        <p className="small muted">还没有定时计划。</p>
      ) : (
        <div className="stack" style={{ gap: 2, marginBottom: 14 }}>
          {rows.map((r) => (
            <div key={r.id} className="tool-row">
              <span className="run-main">
                <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 13 }}>{r.templateName}</strong>
                  <span className="badge badge-gray">{whenText(r)}</span>
                  {!r.enabled && (
                    <span className="badge badge-amber">
                      {r.failStreak >= autoPauseFails ? '连续失败已自动停用' : '已停用'}
                    </span>
                  )}
                  {r.lastStatus === 'failed' && r.enabled && <span className="badge badge-red">上次失败</span>}
                  {r.lastStatus === 'skipped' && <span className="badge badge-amber">上次被上限拦下</span>}
                </span>
                <span className="small muted">
                  {r.lastRunAt ? `上次 ${r.lastRunAt}` : '还没跑过'}
                  {r.lastError ? ` · ${r.lastError}` : ''}
                </span>
              </span>
              {!readOnly && (
                <span className="row" style={{ gap: 6, flexShrink: 0 }}>
                  <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => run(() => actToggleSchedule(r.id, !r.enabled))}>
                    {r.enabled ? '停用' : '启用'}
                  </button>
                  <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => run(() => actDeleteSchedule(r.id))}>
                    删除
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {!readOnly && agents.length > 0 && (
        <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
          {/* ⚠️ .input 类自带 width:100%——三个 select 直接用它会在 row wrap 里
              一人独占一行（用户截图里模板/时/分竖着摞了三层）。逐个钉回 auto 宽。 */}
          <select className="input" value={form.templateId} onChange={(e) => setForm({ ...form, templateId: e.target.value })} style={{ width: 'auto', minWidth: 200, maxWidth: 320 }} aria-label="选智能体">
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <select className="input" value={form.hour} onChange={(e) => setForm({ ...form, hour: Number(e.target.value) })} style={{ width: 'auto' }} aria-label="小时">
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')} 点</option>)}
          </select>
          {/* 只给整十分：扫描每 10 分钟一轮，配 09:07 会让用户以为「说好 7 分却 10 分才跑」 */}
          <select className="input" value={form.minute} onChange={(e) => setForm({ ...form, minute: Number(e.target.value) })} style={{ width: 'auto' }} aria-label="分钟">
            {[0, 10, 20, 30, 40, 50].map((m) => <option key={m} value={m}>{String(m).padStart(2, '0')} 分</option>)}
          </select>
          <span className="row" style={{ gap: 4 }}>
            {DOW.map((d, i) => (
              <label key={i} className="small" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={form.weekdays.includes(i)}
                  onChange={() => setForm({ ...form, weekdays: form.weekdays.includes(i) ? form.weekdays.filter((x) => x !== i) : [...form.weekdays, i].sort() })}
                />
                {d}
              </label>
            ))}
            <span className="small muted">（都不勾 = 每天）</span>
          </span>
          <button
            className="btn btn-sm btn-primary"
            disabled={pending || full || !form.templateId}
            title={full ? `最多 ${maxSchedules} 条` : undefined}
            onClick={() => run(() => actCreateSchedule({ templateId: form.templateId, atHour: form.hour, atMinute: form.minute, weekdays: form.weekdays }))}
          >
            {full ? `已满 ${maxSchedules} 条` : '加一条'}
          </button>
        </div>
      )}

      {agents.length === 0 && <p className="small muted">先装一个智能体，才能给它排定时。</p>}
    </div>
  );
}
