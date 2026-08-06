'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/icons';
import { actVerdict } from './actions';

// 人物提案的采纳/否决按钮：命中检验闭环，结果写入记忆并反哺人物权重
export function VerdictButtons({ opinionId, adopted }: { opinionId: string; adopted: boolean | null }) {
  const [pending, start] = useTransition();
  const router = useRouter();

  function run(next: boolean) {
    start(async () => {
      await actVerdict(opinionId, next);
      router.refresh();
    });
  }

  if (adopted !== null) {
    return (
      <div className="row" style={{ gap: 8 }}>
        <span className={`badge ${adopted ? 'badge-green' : 'badge-gray'}`}>
          {adopted ? '已采纳' : '已否决'}
        </span>
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => run(!adopted)}
          disabled={pending}
          title="改判"
        >
          {pending ? '…' : '改判'}
        </button>
      </div>
    );
  }

  return (
    <div className="row" style={{ gap: 8 }}>
      <button className="btn btn-sm btn-primary" onClick={() => run(true)} disabled={pending}>
        <Icon.check size={14} /> 采纳
      </button>
      <button className="btn btn-sm btn-ghost" onClick={() => run(false)} disabled={pending}>
        <Icon.x size={14} /> 否决
      </button>
    </div>
  );
}
