'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actBindKnowledge, actSetBindingEnabled, actRemoveBinding } from './knowledge-actions';
import { SOURCE_TYPE_LABEL, type KnowledgeBinding, type KnowledgeSourceType } from '@/lib/agent/knowledge-scope';
import { useI18n } from '@/lib/i18n';

// 员工档案里的「它能读什么」（2026-09-11 P1）。
// 一条都没绑 = 不收窄（读整个库）；绑了 ≥1 条就只读范围内的。界面上必须把这条规则写在脸上。

export function KnowledgeBindings({ templateId, bindings, libraryOptions, materialTypes, readOnly }: {
  templateId: string;
  bindings: KnowledgeBinding[];
  libraryOptions: { id: string; title: string }[];
  materialTypes: string[];
  readOnly: boolean;
}) {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState('');
  const [type, setType] = useState<KnowledgeSourceType>('library_item');
  const [sourceId, setSourceId] = useState(libraryOptions[0]?.id ?? '');
  const [purpose, setPurpose] = useState('');

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setErr('');
    start(async () => {
      const r = await fn();
      if (!r.ok) { setErr(r.error ?? (isEn ? 'Failed' : '没成功')); return; }
      router.refresh();
    });
  }

  function pickType(t: KnowledgeSourceType) {
    setType(t);
    setSourceId(t === 'library_item' ? (libraryOptions[0]?.id ?? '') : t === 'material_type' ? '*' : t === 'memory' ? '*' : '');
  }

  const labelOf = (b: KnowledgeBinding) => {
    if (b.sourceType === 'library_item') return libraryOptions.find((o) => o.id === b.sourceId)?.title ?? `${b.sourceId}（条目已不在最近列表里）`;
    if (b.sourceType === 'material_type') return b.sourceId === '*' ? (isEn ? 'All materials' : '全部素材') : b.sourceId;
    if (b.sourceType === 'memory') return isEn ? 'Persona memory' : '人设记忆';
    return b.sourceId;
  };

  return (
    <div>
      <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>{isEn ? `Knowledge scope (${bindings.length})` : `它能读什么（${bindings.length}）`}</div>
      <p className="small muted" style={{ margin: '0 0 6px' }}>
        {bindings.length === 0
          ? (isEn ? 'No bindings: reads the whole library, all materials and memory (default).' : '没绑任何来源：按缺省读整个资讯库、全部素材和人设记忆。绑了第一条之后就只读范围内的。')
          : (isEn ? 'Bound: only enabled sources are searched; disabling the last one leaves nothing readable (never falls back to the whole library).' : '已收窄：只在启用的来源里检索，范围外的工具调用会直说「不在范围里」。把最后一条也禁用 = 什么都读不到，不会退回读整库。')}
      </p>
      {err && <p className="small" style={{ color: 'var(--red)', margin: '0 0 6px' }}>{err}</p>}
      {bindings.length > 0 && (
        <div className="stack" style={{ gap: 4, marginBottom: 8 }}>
          {bindings.map((b) => (
            <div key={b.id} className="row wrap small" style={{ gap: 6, alignItems: 'center' }}>
              <span className={`badge ${b.enabled ? 'badge-gray' : 'badge-amber'}`}>{SOURCE_TYPE_LABEL[b.sourceType]}</span>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{labelOf(b)}</span>
              {b.purpose && <span className="muted">· {b.purpose}</span>}
              {!b.enabled && <span className="muted">{isEn ? '(disabled)' : '（已禁用）'}</span>}
              {!readOnly && (
                <>
                  <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => run(() => actSetBindingEnabled(b.id, !b.enabled))}>{b.enabled ? (isEn ? 'Disable' : '禁用') : (isEn ? 'Enable' : '启用')}</button>
                  <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => run(() => actRemoveBinding(b.id))}>{isEn ? 'Remove' : '移除'}</button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {!readOnly && (
        <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
          <select className="input" style={{ width: 'auto' }} value={type} onChange={(e) => pickType(e.target.value as KnowledgeSourceType)}>
            <option value="library_item">{SOURCE_TYPE_LABEL.library_item}</option>
            <option value="library_tag">{SOURCE_TYPE_LABEL.library_tag}</option>
            <option value="material_type">{SOURCE_TYPE_LABEL.material_type}</option>
            <option value="memory">{SOURCE_TYPE_LABEL.memory}</option>
          </select>
          {type === 'library_item' && (
            libraryOptions.length === 0
              ? <span className="small muted">{isEn ? 'Library is empty' : '资讯库还是空的，先剪藏几条'}</span>
              : <select className="input" style={{ width: 'auto', maxWidth: 260 }} value={sourceId} onChange={(e) => setSourceId(e.target.value)}>{libraryOptions.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}</select>
          )}
          {type === 'library_tag' && <input className="input" style={{ width: 140 }} placeholder={isEn ? 'tag' : '标签'} value={sourceId} onChange={(e) => setSourceId(e.target.value)} />}
          {type === 'material_type' && (
            <select className="input" style={{ width: 'auto' }} value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              <option value="*">{isEn ? 'All materials' : '全部素材'}</option>
              {materialTypes.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
          <input className="input" style={{ width: 200 }} placeholder={isEn ? 'purpose (optional)' : '用途（可选）：写稿时引用案例'} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
          <button className="btn btn-sm" disabled={pending || !sourceId} onClick={() => run(() => actBindKnowledge(templateId, { sourceType: type, sourceId, purpose }))}>{isEn ? 'Bind' : '绑定'}</button>
        </div>
      )}
    </div>
  );
}
