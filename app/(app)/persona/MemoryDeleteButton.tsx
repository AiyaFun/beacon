'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actDeleteMemory } from './actions';
import { useI18n } from '@/lib/i18n';

// 单条记忆删除：体现"全程可编辑/可删除"。
export function MemoryDeleteButton({ id }: { id: string }) {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const [pending, start] = useTransition();
  const router = useRouter();

  function del() {
    if (!window.confirm(isEn ? 'Delete this memory? The account brain will no longer refer to it.' : '确定删除这条记忆？删除后账号大脑将不再参考它。')) return;
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
      title={isEn ? 'Delete this memory' : '删除这条记忆'}
      style={{ padding: '2px 8px' }}
    >
      {pending ? (isEn ? 'Deleting…' : '删除中…') : (isEn ? 'Delete' : '删除')}
    </button>
  );
}
