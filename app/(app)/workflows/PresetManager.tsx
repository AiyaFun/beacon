'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actSavePreset, actTogglePreset, actDeletePreset } from './preset-actions';
import { AUTH_GROUPS, groupOf, toolsForGroups, type AuthGroupKey } from '@/lib/agent/auth-groups';

// ── 一键任务的管理区（/workflows#presets）────────────────────────────────────
//
// 【零新路由】它挂在智能体那一页的锚点区块里，而不是造一个 /presets。
// 定时也在这一页——「配一次、以后一键或到点自动跑」本来就是同一件事的两种触发。

export type PresetRow = {
  id: string;
  title: string;
  goal: string;
  agentTemplateId: string | null;
  authMode: string;
  preauthorizedTools: string[];
  enabled: boolean;
};

export type AgentOption = { id: string; label: string; autonomous: boolean };
export type ToolOption = { name: string; label: string; costly?: boolean; contract?: boolean };

export function PresetManager({
  presets,
  agents,
  tools,
}: {
  presets: PresetRow[];
  agents: AgentOption[];
  tools: ToolOption[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState<PresetRow | null>(null);
  const [err, setErr] = useState('');

  const blank = (): PresetRow => ({
    id: '', title: '', goal: '', agentTemplateId: null,
    authMode: 'confirm_each', preauthorizedTools: [], enabled: true,
  });

  function save(row: PresetRow) {
    setErr('');
    start(async () => {
      const r = await actSavePreset({
        id: row.id || undefined,
        title: row.title,
        goal: row.goal,
        agentTemplateId: row.agentTemplateId,
        authMode: row.authMode,
        preauthorizedTools: row.preauthorizedTools,
      });
      if (!r.ok) { setErr(r.error ?? '没能保存'); return; }
      setEditing(null);
      router.refresh();
    });
  }

  function act(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setErr('');
    start(async () => {
      const r = await fn();
      if (!r.ok) { setErr(r.error ?? '没能完成'); return; }
      router.refresh();
    });
  }

  return (
    <div id="presets" style={{ scrollMarginTop: 80 }}>
      {/* 标题与说明**不在这里再印一遍**：外面包着的 Card 已经有同一句 title/sub
          （用户 2026-08-26 截图里「一键任务」上下两行连着出现两次）。这里只留动作按钮。 */}
      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 10 }}>
        <button className="btn btn-sm" disabled={pending} onClick={() => setEditing(blank())}>
          ＋ 新建一张
        </button>
      </div>

      {presets.length === 0 && !editing && (
        <p className="small muted">还没有一键任务。反复要做的事存成一张卡，以后点一下就派。</p>
      )}

      <div className="stack" style={{ gap: 8 }}>
        {presets.map((p) => (
          <div key={p.id} className="row-between wrap" style={{ gap: 8, padding: '8px 0', borderTop: '1px solid var(--line)' }}>
            <span className="row wrap" style={{ gap: 8, minWidth: 0, alignItems: 'baseline' }}>
              <strong className="small">⚡ {p.title}</strong>
              <span className="small muted" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {p.goal.slice(0, 40)}{p.goal.length > 40 ? '…' : ''}
              </span>
              {p.agentTemplateId && (
                <span className="badge badge-gray">
                  {agents.find((a) => a.id === p.agentTemplateId)?.label ?? '（智能体已删除）'}
                </span>
              )}
              {p.preauthorizedTools.length > 0 && (
                <span className="badge badge-amber">已授权 {p.preauthorizedTools.length} 个动作</span>
              )}
              {!p.enabled && <span className="badge badge-gray">已停用</span>}
            </span>
            <span className="row" style={{ gap: 6 }}>
              <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => setEditing(p)}>改</button>
              <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => act(() => actTogglePreset(p.id, !p.enabled))}>
                {p.enabled ? '停用' : '启用'}
              </button>
              <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => act(() => actDeletePreset(p.id))}>删</button>
            </span>
          </div>
        ))}
      </div>

      {editing && <PresetForm row={editing} agents={agents} tools={tools} pending={pending} onCancel={() => setEditing(null)} onSave={save} />}
      {err && <div className="small" style={{ marginTop: 8, color: 'var(--red)' }}>{err}</div>}
    </div>
  );
}

function PresetForm({
  row, agents, tools, pending, onCancel, onSave,
}: {
  row: PresetRow;
  agents: AgentOption[];
  tools: ToolOption[];
  pending: boolean;
  onCancel: () => void;
  onSave: (r: PresetRow) => void;
}) {
  const [draft, setDraft] = useState<PresetRow>(row);
  const checked = new Set<AuthGroupKey>(
    AUTH_GROUPS.filter((g) => tools.some((t) => groupOf(t) === g.key && draft.preauthorizedTools.includes(t.name))).map((g) => g.key),
  );

  function toggleGroup(key: AuthGroupKey) {
    const next = new Set(checked);
    if (next.has(key)) next.delete(key); else next.add(key);
    const names = toolsForGroups(tools, [...next]);
    setDraft({ ...draft, preauthorizedTools: names, authMode: names.length ? 'preauthorized' : 'confirm_each' });
  }

  return (
    <div className="card" style={{ padding: 14, marginTop: 12 }}>
      <div className="stack" style={{ gap: 10 }}>
        <input
          className="input" placeholder="卡片名字，例如：看昨天数据给建议"
          value={draft.title} disabled={pending}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        />
        <textarea
          className="textarea" rows={3} placeholder="派出去的那句话，例如：看看我最近三天的作品数据，挑两条值得复用的思路"
          value={draft.goal} disabled={pending}
          onChange={(e) => setDraft({ ...draft, goal: e.target.value })}
        />
        <label className="small">
          让谁干：
          <select
            className="select" style={{ marginLeft: 8, maxWidth: 280 }}
            value={draft.agentTemplateId ?? ''} disabled={pending}
            onChange={(e) => setDraft({ ...draft, agentTemplateId: e.target.value || null })}
          >
            <option value="">通用助手</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.label}{a.autonomous ? '（自主）' : ''}</option>
            ))}
          </select>
        </label>

        <div>
          <div className="small" style={{ marginBottom: 6 }}>这张卡派出去时，哪些动作不用再逐个问你：</div>
          {AUTH_GROUPS.map((g) => {
            const inGroup = tools.filter((t) => groupOf(t) === g.key);
            if (inGroup.length === 0) return null;
            return (
              <label key={g.key} className="row small" style={{ gap: 8, alignItems: 'flex-start', cursor: 'pointer', marginBottom: 6 }}>
                <input type="checkbox" checked={checked.has(g.key)} disabled={pending} onChange={() => toggleGroup(g.key)} style={{ marginTop: 3 }} />
                <span><strong>{g.name}</strong><span className="muted" style={{ marginLeft: 6 }}>{g.hint}</span></span>
              </label>
            );
          })}
          {/* 与派发卡同一条说明：签合约那几样是机制级的闸，勾了也仍然会问 */}
          <div className="small muted">
            建发布计划、写长期记忆、配定时、拼新智能体这几样<strong>无论如何都会再问你一次</strong>。
          </div>
        </div>

        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn btn-sm btn-primary" disabled={pending || !draft.title.trim() || !draft.goal.trim()} onClick={() => onSave(draft)}>
            {pending ? '保存中…' : '保存'}
          </button>
          <button className="btn btn-sm btn-ghost" disabled={pending} onClick={onCancel}>取消</button>
        </div>
      </div>
    </div>
  );
}
