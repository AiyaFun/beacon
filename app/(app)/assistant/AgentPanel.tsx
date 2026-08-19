'use client';

import { useState, useTransition } from 'react';
import { Icon } from '@/components/icons';
import { actStartAgent, actDecideAgentStep, actCancelAgent } from './agent-actions';
import type { AgentTurn } from '@/lib/agent/run';

// 执行模式面板：一句话 → AI 自己查、自己做，写操作停下来等你点头。
//
// 界面上必须让人看清三件事，否则「AI 帮我做了什么」永远是个黑箱：
//   ① 它调了哪些工具、参数是什么；② 哪一步在等你确认；③ 最后到底做成了什么。

const QUICK = [
  '看看我最近作品数据怎么样，给点建议',
  '按我的人设生成 6 条选题推荐',
  '把我最近这篇草稿读一下，帮我改标题',
];

type ToolInfo = { name: string; label: string; write: boolean; costly: boolean; description: string };

export function AgentPanel({ tools }: { tools: ToolInfo[] }) {
  const [pending, start] = useTransition();
  const [goal, setGoal] = useState('');
  const [turn, setTurn] = useState<AgentTurn | null>(null);
  const [err, setErr] = useState('');

  function run(fn: () => Promise<{ ok: boolean; turn?: AgentTurn; error?: string }>) {
    setErr('');
    start(async () => {
      const r = await fn();
      if (!r.ok || !r.turn) {
        setErr(r.error ?? '执行失败');
        return;
      }
      setTurn(r.turn);
    });
  }

  const busy = pending;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="card" style={{ padding: 16 }}>
        <div className="row" style={{ gap: 8, marginBottom: 10 }}>
          <span className="badge badge-brand"><Icon.sparkles size={13} /> 执行模式</span>
          <span className="small muted">
            AI 会真的操作这个系统。凡是会改数据或花钱的动作，都会先停下来问你。
          </span>
        </div>

        <textarea
          className="textarea"
          rows={3}
          value={goal}
          disabled={busy}
          placeholder="说清楚你要它做什么，例如：把我监控的对标账号都采一遍最新数据，然后告诉我谁涨得最快"
          onChange={(e) => setGoal(e.target.value)}
          style={{ width: '100%', marginBottom: 10 }}
        />

        <div className="row wrap" style={{ gap: 8 }}>
          <button
            className="btn btn-primary"
            disabled={busy || !goal.trim()}
            onClick={() => run(() => actStartAgent(goal))}
          >
            {busy ? '执行中…' : '开始执行'}
          </button>
          {QUICK.map((q) => (
            <button key={q} className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setGoal(q)}>
              {q}
            </button>
          ))}
        </div>

        {err && <div className="small" style={{ marginTop: 10, color: 'var(--red)' }}>{err}</div>}
      </div>

      {turn && (
        <div className="card" style={{ padding: 16 }}>
          <div className="row-between" style={{ marginBottom: 10 }}>
            <strong>执行过程</strong>
            <span className="row" style={{ gap: 8 }}>
              <StatusBadge status={turn.status} />
              {(turn.status === 'awaiting_confirm' || turn.status === 'running') && (
                <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => run(() => actCancelAgent(turn.runId))}>
                  终止
                </button>
              )}
            </span>
          </div>

          {turn.steps.length === 0 && <p className="small muted">还没有步骤。</p>}

          <ol style={{ display: 'grid', gap: 8, margin: 0, paddingLeft: 18 }}>
            {turn.steps.map((s) => (
              <li key={s.seq} className="small">
                <StepLine step={s} />
              </li>
            ))}
          </ol>

          {turn.pending && (
            <div
              className="card"
              style={{ marginTop: 14, padding: 14, borderColor: 'var(--amber)', background: 'var(--amber-soft)' }}
            >
              <div style={{ fontWeight: 650, marginBottom: 6 }}>
                需要你确认：{turn.pending.label}
                {turn.pending.costly && <span className="badge badge-amber" style={{ marginLeft: 8 }}>会消耗额度/产生费用</span>}
              </div>
              <pre
                className="small"
                style={{ margin: '0 0 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 180, overflow: 'auto' }}
              >
                {JSON.stringify(turn.pending.args, null, 2)}
              </pre>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => actDecideAgentStep(turn.runId, true))}>
                  确认执行
                </button>
                <button className="btn btn-sm" disabled={busy} onClick={() => run(() => actDecideAgentStep(turn.runId, false))}>
                  不执行这一步
                </button>
              </div>
            </div>
          )}

          {turn.answer && (
            <div style={{ marginTop: 14, whiteSpace: 'pre-wrap', lineHeight: 1.75 }}>{turn.answer}</div>
          )}
          {turn.error && (
            <div className="small" style={{ marginTop: 14, color: 'var(--red)' }}>{turn.error}</div>
          )}
        </div>
      )}

      <details className="card" style={{ padding: 16 }}>
        <summary className="small" style={{ cursor: 'pointer', fontWeight: 600 }}>
          AI 能调用的系统能力（{tools.length} 项，按你的角色过滤）
        </summary>
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table className="table">
            <thead><tr><th>能力</th><th>说明</th><th style={{ width: 110 }}>是否需确认</th></tr></thead>
            <tbody>
              {tools.map((t) => (
                <tr key={t.name}>
                  <td>{t.label}</td>
                  <td className="small muted">{t.description}</td>
                  <td className="small">
                    {t.write || t.costly ? <span className="badge badge-amber">要你点头</span> : <span className="badge badge-gray">只读</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>
          这张表就是 AI 能做的全部事情——表外的它做不了，也没有「让 AI 写段代码跑一下」的通道。
        </p>
      </details>
    </div>
  );
}

function StatusBadge({ status }: { status: AgentTurn['status'] }) {
  const map: Record<string, { cls: string; text: string }> = {
    running: { cls: 'badge-gray', text: '进行中' },
    awaiting_confirm: { cls: 'badge-amber', text: '等你确认' },
    done: { cls: 'badge-green', text: '已完成' },
    failed: { cls: 'badge-red', text: '未完成' },
    cancelled: { cls: 'badge-gray', text: '已终止' },
  };
  const m = map[status] ?? map.running;
  return <span className={`badge ${m.cls}`}>{m.text}</span>;
}

function StepLine({ step }: { step: AgentTurn['steps'][number] }) {
  if (step.kind === 'tool_call') {
    return (
      <span>
        <span className="badge badge-gray">调用</span> {step.label}
        <span className="muted"> {JSON.stringify(step.args).slice(0, 120)}</span>
      </span>
    );
  }
  if (step.kind === 'tool_result') {
    return (
      <span style={{ color: step.ok ? 'inherit' : 'var(--red)' }}>
        <span className={`badge ${step.ok ? 'badge-green' : 'badge-red'}`}>{step.ok ? '完成' : '失败'}</span>{' '}
        {step.label}
        <span className="muted"> {summaryOf(step.result)}</span>
      </span>
    );
  }
  if (step.kind === 'rejected') {
    return <span><span className="badge badge-amber">已拒绝</span> {step.label}（你选择了不执行）</span>;
  }
  return <span><span className="badge badge-brand">回答</span> {step.result.slice(0, 100)}</span>;
}

/** 工具结果是给模型看的 JSON；界面上只展示它的 summary 字段，展不开就截断。 */
function summaryOf(result: string): string {
  try {
    const j = JSON.parse(result) as { summary?: string; error?: string };
    return j.summary || j.error || '';
  } catch {
    return result.slice(0, 100);
  }
}
