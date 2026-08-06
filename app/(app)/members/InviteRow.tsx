'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actRevokeInvite } from './actions';

// 待处理邀请的操作条：复制链接 / 撤销。
export function InviteRow({ id, token }: { id: string; token: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState('');

  function copy() {
    navigator.clipboard.writeText(`${window.location.origin}/login?invite=${token}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function revoke() {
    if (!window.confirm('确认撤销该邀请？链接将立即失效。')) return;
    setMsg('');
    start(async () => {
      const r = await actRevokeInvite(id);
      if (!r.ok) setMsg(r.error ?? '撤销失败');
      else router.refresh();
    });
  }

  return (
    <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
      <button className="btn btn-sm" onClick={copy}>{copied ? '已复制' : '复制链接'}</button>
      <button className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} disabled={pending} onClick={revoke}>
        撤销
      </button>
      {msg && <span className="small" style={{ color: 'var(--red)' }}>{msg}</span>}
    </div>
  );
}
