'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actDeleteMemory } from './actions';

// 单条记忆删除：体现"全程可编辑/可删除"。
export function MemoryDeleteButton({ id }: { id: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();

  function del() {
    if (!window.confirm('确定删除这条记忆？删除后账号大脑将不再参考它。')) return;
    start(async () => {
      await actDeleteMemory(id);
      router.refresh();
    });
  }

  return (
    <button
      className="btn btn-sm btn-ghost"
      onClick={del}
      disabled={pending}
      title="删除这条记忆"
      style={{ padding: '2px 8px' }}
    >
      {pending ? '删除中…' : '删除'}
    </button>
  );
}
