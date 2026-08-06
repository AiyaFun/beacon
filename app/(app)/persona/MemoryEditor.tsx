'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actUpdateMemory } from './actions';
import { MemoryDeleteButton } from './MemoryDeleteButton';

// 单条记忆的「查看 / 就地编辑 / 删除」。
//
// 此前只有删除：看到一条学错的记忆（比如把偶尔一次的长文当成长期偏好），
// 用户唯一的选择是删掉、然后指望系统重新学对——而系统很可能再学错一次。
// 改一个字比删掉重学便宜得多，也更贴合「记忆是你的资产」这个叙事。
export function MemoryEditor({ id, content }: { id: string; content: string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(content);
  const [err, setErr] = useState('');
  const [pending, start] = useTransition();
  const router = useRouter();

  function save() {
    setErr('');
    start(async () => {
      const r = await actUpdateMemory(id, text);
      if (!r.ok) {
        setErr(r.error ?? '保存失败');
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  function cancel() {
    setText(content); // 丢弃改动，回到库里那份
    setErr('');
    setEditing(false);
  }

  if (!editing) {
    return (
      <div className="row-between" style={{ alignItems: 'flex-start', gap: 10 }}>
        <div className="small" style={{ flex: 1 }}>{content}</div>
        <div className="row" style={{ gap: 4, flexShrink: 0 }}>
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => setEditing(true)}
            title="改写这条记忆（改完视为你亲口确认，置信度提到高）"
            style={{ padding: '2px 8px' }}
          >
            编辑
          </button>
          <MemoryDeleteButton id={id} />
        </div>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 6 }}>
      <textarea
        className="textarea"
        rows={2}
        maxLength={300}
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') cancel();
          // Cmd/Ctrl+Enter 保存：多行输入里回车要留给换行
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) save();
        }}
      />
      <div className="row" style={{ gap: 6, alignItems: 'center' }}>
        <button className="btn btn-sm btn-primary" onClick={save} disabled={pending || !text.trim()}>
          {pending ? '保存中…' : '保存'}
        </button>
        <button className="btn btn-sm btn-ghost" onClick={cancel} disabled={pending}>取消</button>
        <span className="small muted">改完这条会标为「你确认过」，并立即参与推荐</span>
      </div>
      {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
    </div>
  );
}
