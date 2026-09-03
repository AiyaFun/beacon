'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { MEMORY_TYPES } from '@/lib/constants';
import { actAddMemory } from './actions';

// 手动新增一条记忆。此前只能删/改系统写的，想让 AI 记住一件事得绕道助手对话。
export function MemoryAddForm() {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<keyof typeof MEMORY_TYPES>('preference');
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [pending, start] = useTransition();
  const router = useRouter();

  function save() {
    setErr('');
    start(async () => {
      const r = await actAddMemory(type, text);
      if (!r.ok) {
        setErr(r.error ?? '保存失败');
        return;
      }
      setText('');
      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <button className="btn btn-sm btn-ghost" onClick={() => setOpen(true)} title="直接告诉它一件要记住的事">
        ＋ 手动记一条
      </button>
    );
  }
  return (
    <div className="stack" style={{ gap: 6, padding: 12, background: 'var(--surface-2)', borderRadius: 8 }}>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <select className="input" value={type} onChange={(e) => setType(e.target.value as keyof typeof MEMORY_TYPES)} style={{ width: 'auto' }}>
          {(Object.keys(MEMORY_TYPES) as (keyof typeof MEMORY_TYPES)[]).map((k) => (
            <option key={k} value={k}>{MEMORY_TYPES[k].name}</option>
          ))}
        </select>
        <span className="small muted">一句话、陈述句，比如「我的粉丝主要在三线城市」</span>
      </div>
      <textarea
        className="textarea"
        rows={2}
        maxLength={300}
        autoFocus
        value={text}
        placeholder="要它记住什么"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setOpen(false); setText(''); setErr(''); }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) save();
        }}
      />
      <div className="row" style={{ gap: 6, alignItems: 'center' }}>
        <button className="btn btn-sm btn-primary" onClick={save} disabled={pending || !text.trim()}>
          {pending ? '保存中…' : '记住'}
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => { setOpen(false); setText(''); setErr(''); }} disabled={pending}>取消</button>
        <span className="small muted">你亲口说的按高置信记录，立即参与生成</span>
      </div>
      {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
    </div>
  );
}
