'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actTestProvider, actDeleteProvider, actSetDefault } from './actions';

// 单个 BYOK 渠道的操作条：连通性测试 / 设为默认 / 删除。
export function ProviderRow({ id, isDefault }: { id: string; isDefault: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState('');

  function run(fn: () => Promise<{ ok?: boolean; status?: string; detail?: string }>, label: string, confirm?: string) {
    if (confirm && !window.confirm(confirm)) return;
    setMsg('');
    start(async () => {
      try {
        const r = await fn();
        if (label === 'test') {
          setMsg(r.status === 'ok' ? '连通正常' : `连通失败${r.detail ? '：' + r.detail : ''}`);
        } else {
          setMsg('完成');
        }
        router.refresh();
      } catch (e) {
        setMsg('网络错误：' + (e as Error).message.slice(0, 40));
      }
      setTimeout(() => setMsg(''), 3500);
    });
  }

  return (
    <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
      <button className="btn btn-sm" disabled={pending} onClick={() => run(() => actTestProvider(id), 'test')}>
        {pending ? '测试中…' : '连通性测试'}
      </button>
      {!isDefault && (
        <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => run(() => actSetDefault(id), 'default')}>
          设为默认
        </button>
      )}
      <button
        className="btn btn-sm btn-ghost"
        disabled={pending}
        onClick={() => run(() => actDeleteProvider(id), 'delete', '确认删除该渠道？此操作不可撤销。')}
        style={{ color: 'var(--red)' }}
      >
        删除
      </button>
      {msg && <span className="small muted">{msg}</span>}
    </div>
  );
}
