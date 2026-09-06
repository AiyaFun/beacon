'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { actTestProvider, actDeleteProvider, actSetDefault } from './actions';

// 单个 BYOK 渠道的操作条：连通性测试 / 设为默认 / 删除。
export function ProviderRow({ id, isDefault }: { id: string; isDefault: boolean }) {
  const { lang } = useI18n();
  const isEn = lang === 'en';
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
          setMsg(
            r.status === 'ok'
              ? r.detail
                ? (isEn ? `No chat test performed: ${r.detail}` : `未做对话测试：${r.detail}`)
                : (isEn ? 'Connected successfully' : '连通正常')
              : (isEn ? `Connection failed${r.detail ? ': ' + r.detail : ''}` : `连通失败${r.detail ? '：' + r.detail : ''}`),
          );
        } else {
          setMsg(isEn ? 'Completed' : '完成');
        }
        router.refresh();
      } catch (e) {
        setMsg((isEn ? 'Network error: ' : '网络错误：') + (e as Error).message.slice(0, 40));
      }
      setTimeout(() => setMsg(''), 8000);
    });
  }

  return (
    <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
      <button className="btn btn-sm" disabled={pending} onClick={() => run(() => actTestProvider(id), 'test')}>
        {pending ? (isEn ? 'Testing…' : '测试中…') : (isEn ? 'Test Connection' : '连通性测试')}
      </button>
      {!isDefault && (
        <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => run(() => actSetDefault(id), 'default')}>
          {isEn ? 'Set as Default' : '设为默认'}
        </button>
      )}
      <button
        className="btn btn-sm btn-ghost"
        disabled={pending}
        onClick={() => run(() => actDeleteProvider(id), 'delete', isEn ? 'Are you sure you want to delete this channel? This action cannot be undone.' : '确认删除该渠道？此操作不可撤销。')}
        style={{ color: 'var(--red)' }}
      >
        {isEn ? 'Delete' : '删除'}
      </button>
      {msg && <span className="small muted">{msg}</span>}
    </div>
  );
}
