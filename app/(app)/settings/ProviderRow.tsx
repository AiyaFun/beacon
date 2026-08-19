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
          // 图像/视频模型走的是「不判 failed」那条路（见 actions.ts 的 nonChat 分支）——
          // 那时并没有真的验通，只是没有理由判它坏。这种情况必须把 detail 说出来，
          // 否则一个连不上的端点也会显示「连通正常」，就是新的文案-行为不一致。
          setMsg(
            r.status === 'ok'
              ? r.detail
                ? `未做对话测试：${r.detail}`
                : '连通正常'
              : `连通失败${r.detail ? '：' + r.detail : ''}`,
          );
        } else {
          setMsg('完成');
        }
        router.refresh();
      } catch (e) {
        setMsg('网络错误：' + (e as Error).message.slice(0, 40));
      }
      setTimeout(() => setMsg(''), 8000);
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
