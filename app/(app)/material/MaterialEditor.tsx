'use client';

import { useState, useTransition } from 'react';
import { Icon } from '@/components/icons';
import { actCreateMaterial, actUpdateMaterial, actDeleteMaterial } from './actions';
import { MATERIAL_TYPES, type MaterialItem, type MaterialType } from './types';
import { fmtDateFull } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

type Props = { items: MaterialItem[] };

const TYPE_KEYS = Object.keys(MATERIAL_TYPES) as MaterialType[];
const TYPE_BADGES: Record<MaterialType, string> = {
  experience: 'badge-brand',
  case: 'badge-green',
  opinion: 'badge-amber',
  catchphrase: 'badge-gray',
  sample: 'badge-brand',
};

export function MaterialEditor({ items }: Props) {
  const { lang } = useI18n();
  const [list, setList] = useState(items);
  const [editId, setEditId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [filter, setFilter] = useState<MaterialType | 'all'>('all');

  const filtered = filter === 'all' ? list : list.filter((m) => m.type === filter);

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <button
          className={`btn btn-sm ${filter === 'all' ? 'btn-primary' : ''}`}
          onClick={() => setFilter('all')}
        >
          {lang === 'en' ? 'All' : '全部'} ({list.length})
        </button>
        {TYPE_KEYS.map((t) => (
          <button
            key={t}
            className={`btn btn-sm ${filter === t ? 'btn-primary' : ''}`}
            onClick={() => setFilter(t)}
          >
            {lang === 'en' ? MATERIAL_TYPES[t].nameEn : MATERIAL_TYPES[t].name} ({list.filter((m) => m.type === t).length})
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button className="btn btn-sm btn-primary" onClick={() => { setShowForm(true); setEditId(null); }}>
          <Icon.plus size={13} /> {lang === 'en' ? 'Add Material' : '添加素材'}
        </button>
      </div>

      {showForm && (
        <MaterialForm
          lang={lang}
          onDone={(item) => {
            if (item) setList([item, ...list]);
            setShowForm(false);
          }}
        />
      )}

      {filtered.length === 0 && !showForm && (
        <div className="small muted" style={{ textAlign: 'center', padding: 32 }}>
          {list.length === 0
            ? (lang === 'en' ? 'No materials yet. Click "Add Material" to record your experiences, cases, views, or catchphrases.' : '还没有素材，点「添加素材」录入你的经历、案例、观点或口头禅')
            : (lang === 'en' ? 'No materials in this category' : '该分类暂无素材')}
        </div>
      )}

      <div className="stack" style={{ gap: 10 }}>
        {filtered.map((m) => (
          <MaterialCard
            key={m.id}
            item={m}
            editing={editId === m.id}
            onEdit={() => setEditId(editId === m.id ? null : m.id)}
            onUpdated={(updated) => setList(list.map((x) => x.id === updated.id ? updated : x))}
            onDeleted={() => setList(list.filter((x) => x.id !== m.id))}
            lang={lang}
          />
        ))}
      </div>
    </div>
  );
}

function MaterialForm({ onDone, lang }: { onDone: (item?: MaterialItem) => void; lang?: string }) {
  const [type, setType] = useState<MaterialType>('experience');
  const [content, setContent] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [error, setError] = useState('');
  const [pending, start] = useTransition();

  function submit() {
    setError('');
    const tags = tagInput.split(/[,，\s]+/).filter(Boolean);
    start(async () => {
      const r = await actCreateMaterial(type, content, tags);
      if (r.ok) {
        onDone({
          id: Date.now().toString(),
          type,
          content: content.trim(),
          tags,
          createdAt: new Date().toISOString(),
        });
      } else {
        setError(r.error ?? (lang === 'en' ? 'Failed to add' : '添加失败'));
      }
    });
  }

  return (
    <div className="card" style={{ padding: 14, background: 'var(--surface-2)', boxShadow: 'none' }}>
      <div className="stack" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 8 }}>
          {TYPE_KEYS.map((t) => (
            <button
              key={t}
              className={`btn btn-sm ${type === t ? 'btn-primary' : ''}`}
              onClick={() => setType(t)}
            >
              {lang === 'en' ? MATERIAL_TYPES[t].nameEn : MATERIAL_TYPES[t].name}
            </button>
          ))}
        </div>
        <textarea
          className="textarea"
          rows={4}
          placeholder={lang === 'en' ? MATERIAL_TYPES[type].placeholderEn : MATERIAL_TYPES[type].placeholder}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          maxLength={2000}
        />
        <input
          className="input"
          placeholder={lang === 'en' ? 'Tags (comma separated, max 5)' : '标签（逗号分隔，最多5个）'}
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
        />
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <button className="btn btn-primary btn-sm" onClick={submit} disabled={pending || !content.trim()}>
            {pending ? (lang === 'en' ? 'Saving…' : '保存中…') : (lang === 'en' ? 'Save' : '保存')}
          </button>
          <button className="btn btn-sm" onClick={() => onDone()} disabled={pending}>
            {lang === 'en' ? 'Cancel' : '取消'}
          </button>
          {error && <span className="small" style={{ color: 'var(--red)' }}>{error}</span>}
        </div>
      </div>
    </div>
  );
}

function MaterialCard({
  item,
  editing,
  onEdit,
  onUpdated,
  onDeleted,
  lang,
}: {
  item: MaterialItem;
  editing: boolean;
  onEdit: () => void;
  onUpdated: (m: MaterialItem) => void;
  onDeleted: () => void;
  lang?: string;
}) {
  const [content, setContent] = useState(item.content);
  const [tagInput, setTagInput] = useState(item.tags.join(', '));
  const [pending, start] = useTransition();

  function save() {
    const tags = tagInput.split(/[,，\s]+/).filter(Boolean);
    start(async () => {
      const r = await actUpdateMaterial(item.id, content, tags);
      if (r.ok) {
        onUpdated({ ...item, content: content.trim(), tags });
        onEdit();
      }
    });
  }

  function remove() {
    start(async () => {
      const r = await actDeleteMaterial(item.id);
      if (r.ok) onDeleted();
    });
  }

  const typeInfo = MATERIAL_TYPES[item.type] || MATERIAL_TYPES.experience;
  const badge = TYPE_BADGES[item.type] || 'badge-gray';

  if (editing) {
    return (
      <div className="card" style={{ padding: 12, boxShadow: 'none', background: 'var(--surface-2)' }}>
        <textarea
          className="textarea"
          rows={3}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          maxLength={2000}
        />
        <input
          className="input"
          placeholder={lang === 'en' ? 'Tags' : '标签'}
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          style={{ marginTop: 8 }}
        />
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <button className="btn btn-primary btn-sm" onClick={save} disabled={pending}>
            {lang === 'en' ? 'Save' : '保存'}
          </button>
          <button className="btn btn-sm" onClick={onEdit} disabled={pending}>
            {lang === 'en' ? 'Cancel' : '取消'}
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn btn-sm" style={{ color: 'var(--red)' }} onClick={remove} disabled={pending}>
            {lang === 'en' ? 'Delete' : '删除'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="card"
      style={{ padding: 12, boxShadow: 'none', background: 'var(--surface-2)', cursor: 'pointer' }}
      onClick={onEdit}
    >
      <div className="row" style={{ gap: 8, marginBottom: 6 }}>
        <span className={`badge ${badge}`} style={{ fontSize: 10 }}>
          {lang === 'en' ? typeInfo.nameEn : typeInfo.name}
        </span>
        {item.tags.map((t, i) => (
          <span key={i} className="badge badge-gray" style={{ fontSize: 10 }}>{t}</span>
        ))}
        <div style={{ flex: 1 }} />
        <span className="small muted">{fmtDateFull(item.createdAt)}</span>
      </div>
      <div className="small" style={{ lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
        {item.content.length > 200 ? item.content.slice(0, 200) + '…' : item.content}
      </div>
    </div>
  );
}
