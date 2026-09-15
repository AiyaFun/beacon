import Link from 'next/link';
import { AGENT_STATE_LABEL } from '@/lib/agent/overview-state';
import type { AgentOverviewView } from '@/lib/agent/overview';
import { fmtUsd } from '@/lib/agent/economics';
import { fmtDateTime } from '@/lib/format';
import { AgentOverviewActions } from './AgentOverviewActions';
import { KnowledgeBindings } from './KnowledgeBindings';
import type { KnowledgeBinding } from '@/lib/agent/knowledge-scope';
import type { PerformanceView } from '@/lib/agent/performance';

// 数字员工档案（2026-09-11 P0-2）：一处回答「它会什么、现在能不能干、正在干什么、最近交付如何」。
// 全部数据来自 lib/agent/overview.ts 的只读聚合；每个数字都能点回原始运行。
// **空数据不补默认值**：没跑过就写「还没跑过」，不印 0% 也不印 100%。

const AUTH_LABEL: Record<string, string> = {
  confirm_each: '逐步确认',
  preauthorized: '预授权',
  unattended: '无人值守',
};

const ORIGIN_LABEL: Record<string, string> = {
  manual: '手动', preset: '一键任务', schedule: '定时', api: '对外调用', bot: '群里派的', agent: 'AI 派的', workflow: '接力派的',
};

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中', running: '正在跑', awaiting_confirm: '等你确认', waiting_browser: '等执行器', waiting_quota: '等额度',
  done: '已完成', failed: '失败', cancelled: '已取消',
};

function Stat({ label, value, foot }: { label: string; value: React.ReactNode; foot?: React.ReactNode }) {
  return (
    <div className="metric-cell">
      <span>{label}</span>
      <strong>{value}</strong>
      {foot && <div className="small muted">{foot}</div>}
    </div>
  );
}

function rateText(rate: number | null, total: number, isEn: boolean): React.ReactNode {
  if (rate === null) return <span className="muted" title={isEn ? 'No finished runs in this window' : '这个窗口内没有已结束的执行，不补分'}>{isEn ? 'n/a' : '样本不足'}</span>;
  return `${rate}%`;
}

export function AgentOverviewPanel({ v, isEn, readOnly, bindings, libraryOptions, materialTypes, performance }: {
  v: AgentOverviewView; isEn: boolean; readOnly: boolean;
  bindings: KnowledgeBinding[]; libraryOptions: { id: string; title: string }[]; materialTypes: string[];
  performance: PerformanceView;
}) {
  const st = AGENT_STATE_LABEL[v.state];
  const cost = v.cost30;
  return (
    <section className="surface" style={{ marginBottom: 16 }}>
      <div className="surface-head" style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div className="row wrap" style={{ gap: 8, alignItems: 'center', minWidth: 0 }}>
          <span className="persona-avatar" style={{ background: 'var(--brand-soft)', fontSize: 17 }}>{v.emoji}</span>
          <strong style={{ fontSize: 15 }}>{v.name}</strong>
          <span className={`badge ${st.cls}`} title={v.stateReason}>{isEn ? st.en : st.zh}</span>
          <span className="badge badge-gray">{v.mode === 'autonomous' ? (isEn ? 'Autonomous' : '自主型') : (isEn ? 'Pipeline' : '流水线')}</span>
          {v.isBuiltin && <span className="badge badge-gray">{isEn ? 'Built-in' : '内置'}</span>}
          <span className="small muted">{v.stateReason}</span>
        </div>
        <span className="row" style={{ gap: 6, alignItems: 'center' }}>
          {!readOnly && <AgentOverviewActions id={v.id} installed={v.installed} persona={v.persona} name={v.name} />}
          <Link href="/workflows" className="btn btn-sm btn-ghost">{isEn ? 'Back' : '返回'}</Link>
        </span>
      </div>

      <div className="surface-body stack" style={{ gap: 14 }}>
        {(v.persona || v.description) && (
          <p className="small" style={{ margin: 0 }}>
            {v.persona || v.description}
            {v.requires && <span className="muted">{isEn ? ' · Requires: ' : ' · 跑之前得先有：'}{v.requires}</span>}
          </p>
        )}

        <div className="metric-ribbon">
          <Stat label={isEn ? '7-day success' : '近 7 天成功率'} value={rateText(v.stat7.rate, v.stat7.total, isEn)} foot={`${v.stat7.done} ${isEn ? 'done' : '成'} / ${v.stat7.failed} ${isEn ? 'failed' : '败'}`} />
          <Stat label={isEn ? '30-day success' : '近 30 天成功率'} value={rateText(v.stat30.rate, v.stat30.total, isEn)} foot={`${v.stat30.done} ${isEn ? 'done' : '成'} / ${v.stat30.failed} ${isEn ? 'failed' : '败'} / ${v.stat30.cancelled} ${isEn ? 'cancelled' : '取消'}`} />
          <Stat
            label={isEn ? '30-day cost' : '近 30 天花费'}
            value={cost.calls === 0 && cost.mockedCalls === 0 ? <span className="muted">{isEn ? 'none' : '没花'}</span> : fmtUsd(cost.costUsd)}
            foot={
              <>
                {cost.calls} {isEn ? 'calls' : '次调用'} · {(cost.tokens / 1000).toFixed(1)}k tokens
                {cost.mockedCalls > 0 && <span style={{ color: 'var(--red)' }}> · {cost.mockedCalls} {isEn ? 'mocked' : '次落 Mock'}</span>}
                {cost.degradedCalls > 0 && <span style={{ color: 'var(--red)' }}>（{cost.degradedCalls} {isEn ? 'degraded' : '次是供应商失败兜底'}）</span>}
              </>
            }
          />
          <Stat
            label={isEn ? 'Budget / auth' : '预算 / 授权'}
            value={v.callBudget != null ? `${v.callBudget} ${isEn ? 'calls' : '次'}` : <span className="muted">—</span>}
            foot={v.defaultAuthMode ? (AUTH_LABEL[v.defaultAuthMode] ?? v.defaultAuthMode) : (v.mode === 'pipeline' ? (isEn ? 'Fixed steps' : '步骤定死') : (isEn ? 'Default' : '缺省档'))}
          />
        </div>
        <p className="small muted" style={{ margin: '-6px 0 0' }}>
          {isEn
            ? `Cost covers ${v.costAttributableRuns} autonomous runs attributable via run id; pipeline step calls carry no run id and are not included.`
            : `花费只算得到近 30 天 ${v.costAttributableRuns} 次自主执行（账本按运行 id 归因）；流水线步骤的调用没有运行 id，不在里面。钱是谁出的：平台 ${cost.bySource.platform} · 自带 Key ${cost.bySource.byok}${cost.bySource.unknown ? ` · 历史未标 ${cost.bySource.unknown}` : ''}。`}
        </p>

        <div className="two-panel" style={{ gap: 14 }}>
          <div className="stack" style={{ gap: 12 }}>
            <div>
              <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>{isEn ? 'Now' : '现在在干什么'}</div>
              {v.live.length === 0 ? (
                <p className="small muted" style={{ margin: 0 }}>{isEn ? 'Idle.' : '空闲，没有在跑的执行。'}</p>
              ) : (
                <div className="stack" style={{ gap: 4 }}>
                  {v.live.map((r) => (
                    <div key={r.id} className="row wrap small" style={{ gap: 6 }}>
                      <span className="badge badge-amber">{STATUS_LABEL[r.status] ?? r.status}</span>
                      <Link href={r.href} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title}</Link>
                      <span className="muted">{ORIGIN_LABEL[r.origin] ?? r.origin}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>{isEn ? 'Recent runs' : '最近的执行'}{v.listTruncated && <span className="muted" style={{ fontWeight: 400 }}>{isEn ? ' · list sampled (200); rates use full counts' : ' · 列表只取了 200 条，成功率按全量计数'}</span>}</div>
              {v.recent.length === 0 ? (
                <p className="small muted" style={{ margin: 0 }}>{isEn ? 'No finished runs in 30 days.' : '近 30 天没有已结束的执行。'}</p>
              ) : (
                <div className="stack" style={{ gap: 4 }}>
                  {v.recent.map((r) => (
                    <div key={r.id} className="row wrap small" style={{ gap: 6 }}>
                      <span className={`badge ${r.status === 'done' ? 'badge-green' : r.status === 'failed' ? 'badge-red' : 'badge-gray'}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
                      <span className="muted">{fmtDateTime(r.at)}</span>
                      <Link href={r.href} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title}</Link>
                      <span className="muted">{ORIGIN_LABEL[r.origin] ?? r.origin}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {v.lastError && (
              <div>
                <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>{isEn ? 'Last error' : '最近一次错误'}</div>
                <p className="small" style={{ margin: 0, color: 'var(--red)' }}>
                  {v.lastError.text} <span className="muted">· {fmtDateTime(v.lastError.at)} · <Link href={v.lastError.href}>{isEn ? 'open' : '去看'}</Link></span>
                </p>
              </div>
            )}

            <div>
              <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>{isEn ? 'Recent artifacts' : '最近做出来的东西'}</div>
              {v.artifacts.length === 0 ? (
                <p className="small muted" style={{ margin: 0 }}>{isEn ? 'No artifacts recorded yet.' : '还没有登记过产物。'}</p>
              ) : (
                <div className="stack" style={{ gap: 4 }}>
                  {v.artifacts.map((a, i) => (
                    <div key={`${a.kind}-${i}`} className="row wrap small" style={{ gap: 6 }}>
                      <span className="badge badge-gray">{a.kindLabel}</span>
                      {a.href ? <Link href={a.href}>{a.label}</Link> : <span>{a.label}</span>}
                      <span className="muted">{fmtDateTime(a.at)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="stack" style={{ gap: 12 }}>
            <div>
              <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>{v.mode === 'autonomous' ? (isEn ? `Tools (${v.tools.length})` : `能用的工具（${v.tools.length}）`) : (isEn ? `Steps (${v.stepLabels.length})` : `步骤（${v.stepLabels.length}）`)}</div>
              {v.mode === 'autonomous' ? (
                v.tools.length === 0 ? <p className="small muted" style={{ margin: 0 }}>{isEn ? 'No tool allowlist: inherits user permissions.' : '没配白名单：按用户自己的权限来。'}</p> : (
                  <div className="row wrap" style={{ gap: 4 }}>
                    {v.tools.map((t) => (
                      <span key={t.name} className={`badge ${t.contract ? 'badge-red' : t.write || t.costly ? 'badge-amber' : 'badge-gray'}`} title={`${t.name}${t.write ? ' · 会改数据' : ''}${t.costly ? ' · 会花钱' : ''}${t.contract ? ' · 签合约类（无人值守也会停下来问）' : ''}`}>
                        {t.label}
                      </span>
                    ))}
                  </div>
                )
              ) : (
                <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>{v.stepLabels.map((s, i) => <li key={i}>{s}</li>)}</ol>
              )}
            </div>

            {/* 知识范围（P1）：它能读什么。只对自主型有意义（流水线步骤不走工具检索） */}
            {v.mode === 'autonomous' && (
              <KnowledgeBindings templateId={v.id} bindings={bindings} libraryOptions={libraryOptions} materialTypes={materialTypes} readOnly={readOnly} />
            )}

            {/* 可解释绩效 v1（P2）：五项各自可下钻；样本不足写不足；没有总分 */}
            <div>
              <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>{isEn ? `Performance (${performance.rangeDays}d · ${performance.metricVersion})` : `绩效（近 ${performance.rangeDays} 天 · 口径 ${performance.metricVersion}）`}</div>
              <div className="stack" style={{ gap: 3 }}>
                {performance.metrics.map((m) => (
                  <div key={m.key} className="row wrap small" style={{ gap: 6 }} title={m.definition}>
                    <span style={{ minWidth: 96 }}>{m.label}</span>
                    <strong>{m.value === null ? <span className="muted">{isEn ? 'n/a' : '样本不足'}</span> : m.unit === '%' ? `${m.value}%` : m.unit === 'min' ? `${m.value} 分钟` : m.unit === 'usd' ? `$${m.value}` : `${m.value} 次`}</strong>
                    <Link href={m.href} className="muted">{isEn ? `${m.samples} samples` : `${m.samples} 个样本`}</Link>
                  </div>
                ))}
              </div>
              {performance.failureReasons.length > 0 && (
                <p className="small muted" style={{ margin: '6px 0 0' }}>{isEn ? 'Top failures: ' : '失败原因：'}{performance.failureReasons.map((f) => `${f.reason}×${f.count}`).join('；')}</p>
              )}
            </div>

            <div>
              <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>{isEn ? `Schedules (${v.schedules.length})` : `定时（${v.schedules.length}）`}</div>
              {v.schedules.length === 0 ? <p className="small muted" style={{ margin: 0 }}>{isEn ? 'Not scheduled.' : '没挂定时。'}</p> : (
                <div className="stack" style={{ gap: 4 }}>
                  {v.schedules.map((s) => (
                    <div key={s.id} className="row wrap small" style={{ gap: 6 }}>
                      <span className="badge badge-gray">{s.when}</span>
                      {!s.enabled && <span className={`badge ${s.autoPaused ? 'badge-red' : 'badge-gray'}`}>{s.autoPaused ? (isEn ? 'Auto-paused' : '连败自停') : (isEn ? 'Disabled' : '已停用')}</span>}
                      {s.enabled && s.lastStatus === 'failed' && <span className="badge badge-red">{isEn ? 'Last failed' : '上次失败'}</span>}
                      <span className="muted">{s.lastRunAt ? `${isEn ? 'last' : '上次'} ${fmtDateTime(s.lastRunAt)}` : (isEn ? 'never ran' : '还没跑过')}</span>
                      <a href="/workflows#schedules" className="muted">{isEn ? 'manage' : '去改'}</a>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>{isEn ? `Presets (${v.presets.length})` : `一键任务卡（${v.presets.length}）`}</div>
              {v.presets.length === 0 ? <p className="small muted" style={{ margin: 0 }}>{isEn ? 'None.' : '没有指向它的一键任务。'}</p> : (
                <div className="row wrap" style={{ gap: 4 }}>
                  {v.presets.map((p) => (
                    <span key={p.id} className={`badge ${p.enabled ? 'badge-gray' : 'badge-amber'}`} title={AUTH_LABEL[p.authMode] ?? p.authMode}>⚡ {p.title}{!p.enabled && (isEn ? ' (off)' : '（停用）')}</span>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>{isEn ? `Channels (${v.channels.length})` : `绑定的消息渠道（${v.channels.length}）`}</div>
              {v.channels.length === 0 ? <p className="small muted" style={{ margin: 0 }}>{isEn ? 'No bot channel bound.' : '没有群机器人绑到它。'}</p> : (
                <div className="row wrap" style={{ gap: 4 }}>
                  {v.channels.map((c) => (
                    <span key={c.id} className={`badge ${c.enabled ? 'badge-green' : 'badge-gray'}`}>{c.provider}{c.label ? ` · ${c.label}` : ''}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
