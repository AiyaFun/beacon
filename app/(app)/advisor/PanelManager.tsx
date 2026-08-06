'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Meter } from '@/components/ui';
import { Icon } from '@/components/icons';
import { actUpsertAdvisorPersona, actToggleAdvisorPersona, actDeleteAdvisorPersona, type PersonaInput } from './actions';

export type PanelPersona = {
  id: string;
  key: string;
  name: string;
  role: 'audience' | 'expert';
  emoji: string;
  stance: string;
  focus: string[];
  source: string;
  enabled: boolean;
  weight: number;
  adoptedCount: number;
  rejectedCount: number;
  learnedNotes: { verdict: string; text: string; at: string }[];
};

const EMPTY_FORM = { name: '', role: 'expert' as 'audience' | 'expert', emoji: '🧠', stance: '', focusText: '' };

// 智囊团人物管理：自定义身份（增删改/启停），并展示自学习出的权重与经验
export function PanelManager({ personas, maxEnabled }: { personas: PanelPersona[]; maxEnabled: number }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null); // 'new' = 新建
  const [form, setForm] = useState(EMPTY_FORM);
  const router = useRouter();

  const enabledCount = personas.filter((p) => p.enabled).length;

  function refreshAfter(r: { ok: boolean; error?: string }) {
    if (!r.ok) {
      setErr(r.error ?? '操作失败');
      return;
    }
    setErr('');
    setEditingId(null);
    setForm(EMPTY_FORM);
    router.refresh();
  }

  function submit(id?: string) {
    const input: PersonaInput = {
      id,
      name: form.name,
      role: form.role,
      emoji: form.emoji,
      stance: form.stance,
      focus: form.focusText.split(/[,，、]/).map((x) => x.trim()).filter(Boolean),
    };
    start(async () => refreshAfter(await actUpsertAdvisorPersona(input)));
  }

  const editForm = (id?: string) => (
    <div className="stack" style={{ gap: 8, marginTop: 10 }}>
      <div className="row wrap" style={{ gap: 8 }}>
        <input className="input" style={{ width: 72 }} placeholder="emoji" value={form.emoji} onChange={(e) => setForm({ ...form, emoji: e.target.value })} />
        <input className="input" style={{ width: 160 }} placeholder="人物名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <select className="select" style={{ width: 110 }} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'audience' | 'expert' })}>
          <option value="audience">受众视角</option>
          <option value="expert">专家视角</option>
        </select>
      </div>
      <input className="input" placeholder="立场/世界观（一句话），如：只认可有数据支撑的结论" value={form.stance} onChange={(e) => setForm({ ...form, stance: e.target.value })} />
      <input className="input" placeholder="关注点（逗号分隔），如：转化率, 信任感, 差异化" value={form.focusText} onChange={(e) => setForm({ ...form, focusText: e.target.value })} />
      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-sm btn-primary" onClick={() => submit(id)} disabled={pending || !form.name.trim() || !form.stance.trim()}>
          {pending ? '保存中…' : id ? '保存修改' : '创建人物'}
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => { setEditingId(null); setErr(''); }} disabled={pending}>取消</button>
      </div>
    </div>
  );

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="small muted">
        人物身份完全可自定义；采纳/否决会更新人物「说话分量」并沉淀经验（注入其下次发言）——智囊团越用越懂你。
        当前启用 <b style={{ color: 'var(--text)' }}>{enabledCount}</b> / 上限 {maxEnabled} 席。
      </div>

      <div className="grid grid-2" style={{ gap: 10 }}>
        {personas.map((p) => {
          const total = p.adoptedCount + p.rejectedCount;
          return (
            <div key={p.id} className="card" style={{ padding: 12, boxShadow: 'none', background: 'var(--surface-2)', opacity: p.enabled ? 1 : 0.55 }}>
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <span className="persona-avatar" style={{ fontSize: 20 }}>{p.emoji}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                    <b className="small">{p.name}</b>
                    <span className={`badge ${p.role === 'audience' ? 'badge-brand' : 'badge-accent'}`}>{p.role === 'audience' ? '受众' : '专家'}</span>
                    {p.source === 'custom' && <span className="badge badge-gray">自定义</span>}
                    {!p.enabled && <span className="badge badge-gray">已停用</span>}
                  </div>
                  <div className="small muted" style={{ marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.stance}</div>
                </div>
              </div>

              <div className="row" style={{ gap: 10, alignItems: 'center', marginTop: 10 }}>
                <span className="small muted" style={{ width: 56, flexShrink: 0 }}>说话分量</span>
                <div style={{ flex: 1 }}>
                  <Meter value={(p.weight / 2) * 100} />
                </div>
                <span className="small mono">×{p.weight.toFixed(2)}</span>
              </div>
              <div className="row wrap" style={{ gap: 8, marginTop: 6 }}>
                <span className="small muted">采纳 <b style={{ color: 'var(--green)' }}>{p.adoptedCount}</b> · 否决 <b>{p.rejectedCount}</b>{total > 0 ? ` · 采纳率 ${Math.round((p.adoptedCount / total) * 100)}%` : ''}</span>
              </div>

              {p.learnedNotes.length > 0 && (
                <details style={{ marginTop: 6 }}>
                  <summary className="small muted" style={{ cursor: 'pointer' }}>成长记录（最近 {Math.min(p.learnedNotes.length, 5)} 条）</summary>
                  <div className="stack" style={{ gap: 4, marginTop: 6 }}>
                    {p.learnedNotes.slice(-5).reverse().map((n, i) => (
                      <div key={i} className="small" style={{ opacity: 0.85 }}>
                        <span className={`badge ${n.verdict === 'adopted' ? 'badge-green' : 'badge-gray'}`} style={{ marginRight: 6 }}>
                          {n.verdict === 'adopted' ? '被采纳' : '被否决'}
                        </span>
                        {n.text}
                      </div>
                    ))}
                  </div>
                </details>
              )}

              <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
                <button
                  className="btn btn-sm btn-ghost"
                  disabled={pending}
                  onClick={() => start(async () => refreshAfter(await actToggleAdvisorPersona(p.id, !p.enabled)))}
                >
                  {p.enabled ? '停用' : '启用'}
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  disabled={pending}
                  onClick={() => {
                    setEditingId(p.id);
                    setForm({ name: p.name, role: p.role, emoji: p.emoji, stance: p.stance, focusText: p.focus.join('、') });
                  }}
                >
                  编辑
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  disabled={pending}
                  title={p.source === 'custom' ? '删除自定义人物' : '内置人物将转为停用'}
                  onClick={() => start(async () => refreshAfter(await actDeleteAdvisorPersona(p.id)))}
                >
                  删除
                </button>
              </div>
              {editingId === p.id && editForm(p.id)}
            </div>
          );
        })}
      </div>

      {editingId === 'new' ? (
        <div className="card" style={{ padding: 12, boxShadow: 'none', background: 'var(--surface-2)' }}>
          <b className="small">添加自定义人物</b>
          {editForm()}
        </div>
      ) : (
        <div>
          <button className="btn btn-sm btn-primary" onClick={() => { setEditingId('new'); setForm(EMPTY_FORM); }}>
            <Icon.plus size={14} /> 添加自定义人物
          </button>
        </div>
      )}
      {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
    </div>
  );
}
