'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actAddTask, actToggleTask } from '@/app/(app)/actions';

type Task = { id: string; title: string; done: boolean; source: string };

export function TaskList({ tasks }: { tasks: Task[] }) {
  const [input, setInput] = useState('');
  const [pending, start] = useTransition();
  const router = useRouter();

  function add() {
    if (!input.trim()) return;
    start(async () => {
      await actAddTask(input);
      setInput('');
      router.refresh();
    });
  }
  function toggle(id: string, done: boolean) {
    start(async () => {
      await actToggleTask(id, done);
      router.refresh();
    });
  }

  return (
    <div>
      <form className="row" style={{ gap: 8, marginBottom: 12 }} onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input
          className="input"
          placeholder="加一条今天要做的事，回车添加…"
          aria-label="添加任务"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={pending}>添加</button>
      </form>
      {tasks.length === 0 && <div className="small muted">还没有任务，上面加一条吧。</div>}
      <div className="stack" style={{ gap: 6 }}>
        {tasks.map((t) => (
          <label key={t.id} className="row" style={{ gap: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={t.done} onChange={() => toggle(t.id, !t.done)} />
            <span style={{ textDecoration: t.done ? 'line-through' : 'none', color: t.done ? 'var(--text-3)' : 'var(--text)' }}>
              {t.title}
            </span>
            {t.source === 'suggestion' && <span className="badge badge-accent" style={{ marginLeft: 'auto' }}>AI建议</span>}
          </label>
        ))}
      </div>
    </div>
  );
}
