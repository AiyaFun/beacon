'use client';

import { useState, useTransition } from 'react';
import { Icon } from '@/components/icons';
import { PLATFORM_LIST, platformName } from '@/lib/constants';
import { actAddCustomWord, actRemoveCustomWord, actToggleCustomWord, type CustomWord } from './actions';
import { useI18n } from '@/lib/i18n';

export function WordManager({ words }: { words: CustomWord[] }) {
  const { lang } = useI18n();
  const isEn = lang === 'en';
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
        setError(res.error ?? (isEn ? 'Failed to add' : '添加失败'));
      }
    });
  }

  function handleRemove(id: string) {
    startBusy(async () => {
      const res = await actRemoveCustomWord(id);
      if (!res.ok) setError(res.error ?? (isEn ? 'Failed to delete' : '删除失败'));
    });
  }

  function handleToggle(id: string) {
    startBusy(async () => {
      const res = await actToggleCustomWord(id);
      if (!res.ok) setError(res.error ?? (isEn ? 'Failed to toggle' : '切换失败'));
    });
  }

  const ACTION_OPTS = [
    { value: 'block', label: isEn ? 'Block' : '禁用', cls: 'badge-red' },
    { value: 'warn', label: isEn ? 'Warn' : '警告', cls: 'badge-amber' },
    { value: 'suggest', label: isEn ? 'Suggest' : '建议', cls: 'badge-brand' },
  ] as const;

  return (
    <div className="stack" style={{ gap: 14 }}>
      {/* 添加表单 */}
      <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: 1, minWidth: 120 }}>
          <label className="field-label">{isEn ? 'Term' : '词条'}</label>
          <input
            className="input"
            value={newWord}
            onChange={(e) => setNewWord(e.target.value)}
            placeholder={isEn ? 'Enter sensitive word…' : '输入敏感词…'}
            maxLength={20}
          />
        </div>
        <div className="field" style={{ minWidth: 90 }}>
          <label className="field-label">{isEn ? 'Action' : '动作'}</label>
          <select className="select" value={action} onChange={(e) => setAction(e.target.value as typeof action)}>
            {ACTION_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="field" style={{ minWidth: 110 }}>
          <label className="field-label">{isEn ? 'Platform (optional)' : '平台（可选）'}</label>
          <select className="select" value={platform} onChange={(e) => setPlatform(e.target.value)}>
            <option value="">{isEn ? 'All platforms' : '全平台'}</option>
            {PLATFORM_LIST.map((p) => <option key={p.key} value={p.key}>{platformName(p.key, lang)}</option>)}
          </select>
        </div>
        <div className="field" style={{ flex: 1, minWidth: 100 }}>
          <label className="field-label">{isEn ? 'Replacement (optional)' : '替代建议（可选）'}</label>
          <input
            className="input"
            value={suggestion}
            onChange={(e) => setSuggestion(e.target.value)}
            placeholder={isEn ? 'Recommended replacement…' : '推荐改为…'}
          />
        </div>
        <button className="btn btn-primary" onClick={handleAdd} disabled={adding || !newWord.trim()}>
          {adding ? (isEn ? 'Adding…' : '添加中…') : (isEn ? 'Add' : '添加')}
        </button>
      </div>

      {error && <div className="small" style={{ color: 'var(--red)' }}>{error}</div>}

      {/* 词条列表 */}
      {words.length === 0 ? (
        <div className="small muted" style={{ padding: '16px 0' }}>
          {isEn
            ? 'No custom words yet. Once added, the compliance checker will automatically match your custom lexicon.'
            : '暂无自定义词条。添加后，合规检测器会自动匹配你的自定义词库。'}
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
                {w.action === 'block' ? (isEn ? 'Block' : '禁用') : w.action === 'warn' ? (isEn ? 'Warn' : '警告') : (isEn ? 'Suggest' : '建议')}
              </span>
              <span className="small muted" style={{ flex: 1 }}>
                {w.platform ? platformName(w.platform, lang) : (isEn ? 'All platforms' : '全平台')}
                {w.suggestion ? ` · ${isEn ? 'Replace with ' : '改为 '}${w.suggestion}` : ''}
              </span>
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => handleToggle(w.id)}
                disabled={busy}
                title={w.enabled ? (isEn ? 'Disable' : '停用') : (isEn ? 'Enable' : '启用')}
              >
                {w.enabled ? <Icon.check size={14} /> : <Icon.x size={14} />}
              </button>
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => handleRemove(w.id)}
                disabled={busy}
                title={isEn ? 'Delete' : '删除'}
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
