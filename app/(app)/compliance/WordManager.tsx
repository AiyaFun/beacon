'use client';

import { useState, useTransition } from 'react';
import { Icon } from '@/components/icons';
import { PLATFORM_LIST } from '@/lib/constants';
import { actAddCustomWord, actRemoveCustomWord, actToggleCustomWord, type CustomWord } from './actions';

export function WordManager({ words }: { words: CustomWord[] }) {
  const [newWord, setNewWord] = useState('');
  const [action, setAction] = useState<'block' | 'warn' | 'suggest'>('warn');
  const [platform, setPlatform] = useState('');
  const [suggestion, setSuggestion] = useState('');
  const [error, setError] = useState('');
  const [adding, startAdd] = useTransition();
  const [busy, startBusy] = useTransition();

  function handleAdd() {
    setError('');
    startAdd(async () => {
      const res = await actAddCustomWord({
        word: newWord,
        action,
        platform: platform || undefined,
        suggestion: suggestion || undefined,
      });
      if (res.ok) {
        setNewWord('');
        setSuggestion('');
      } else {
        setError(res.error ?? '添加失败');
      }
    });
  }

  function handleRemove(id: string) {
    startBusy(async () => {
      const res = await actRemoveCustomWord(id);
      if (!res.ok) setError(res.error ?? '删除失败');
    });
  }

  function handleToggle(id: string) {
    startBusy(async () => {
      const res = await actToggleCustomWord(id);
      if (!res.ok) setError(res.error ?? '切换失败');
    });
  }

  const ACTION_OPTS = [
    { value: 'block', label: '禁用', cls: 'badge-red' },
    { value: 'warn', label: '警告', cls: 'badge-amber' },
    { value: 'suggest', label: '建议', cls: 'badge-brand' },
  ] as const;

  return (
    <div className="stack" style={{ gap: 14 }}>
      {/* 添加表单 */}
      <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: 1, minWidth: 120 }}>
          <label className="field-label">词条</label>
          <input
            className="input"
            value={newWord}
            onChange={(e) => setNewWord(e.target.value)}
            placeholder="输入敏感词…"
            maxLength={20}
          />
        </div>
        <div className="field" style={{ minWidth: 90 }}>
          <label className="field-label">动作</label>
          <select className="select" value={action} onChange={(e) => setAction(e.target.value as typeof action)}>
            {ACTION_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="field" style={{ minWidth: 110 }}>
          <label className="field-label">平台（可选）</label>
          <select className="select" value={platform} onChange={(e) => setPlatform(e.target.value)}>
            <option value="">全平台</option>
            {PLATFORM_LIST.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
          </select>
        </div>
        <div className="field" style={{ flex: 1, minWidth: 100 }}>
          <label className="field-label">替代建议（可选）</label>
          <input
            className="input"
            value={suggestion}
            onChange={(e) => setSuggestion(e.target.value)}
            placeholder="推荐改为…"
          />
        </div>
        <button className="btn btn-primary" onClick={handleAdd} disabled={adding || !newWord.trim()}>
          {adding ? '添加中…' : '添加'}
        </button>
      </div>

      {error && <div className="small" style={{ color: 'var(--red)' }}>{error}</div>}

      {/* 词条列表 */}
      {words.length === 0 ? (
        <div className="small muted" style={{ padding: '16px 0' }}>
          暂无自定义词条。添加后，合规检测器会自动匹配你的自定义词库。
        </div>
      ) : (
        <div className="stack" style={{ gap: 6 }}>
          {words.map((w) => (
            <div
              key={w.id}
              className="list-row"
              style={{ alignItems: 'center', opacity: w.enabled ? 1 : 0.5 }}
            >
              <span className="mono" style={{ minWidth: 84, fontWeight: 600 }}>{w.word}</span>
              <span className={`badge ${w.action === 'block' ? 'badge-red' : w.action === 'warn' ? 'badge-amber' : 'badge-brand'}`}>
                {w.action === 'block' ? '禁用' : w.action === 'warn' ? '警告' : '建议'}
              </span>
              <span className="small muted" style={{ flex: 1 }}>
                {w.platform || '全平台'}
                {w.suggestion ? ` · 改为 ${w.suggestion}` : ''}
              </span>
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => handleToggle(w.id)}
                disabled={busy}
                title={w.enabled ? '停用' : '启用'}
              >
                {w.enabled ? <Icon.check size={14} /> : <Icon.x size={14} />}
              </button>
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => handleRemove(w.id)}
                disabled={busy}
                title="删除"
                style={{ color: 'var(--red)' }}
              >
                <Icon.x size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
