'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ASSIGNABLE_ROLES, ROLE_LABEL } from '@/lib/rbac';
import { actChangeRole, actSetMemberStatus, actRemoveMember } from './actions';

// 单个成员的操作条：改角色 / 停用恢复 / 移除。
// locked=true 时（owner 或自己）只展示角色，不给任何入口——边界在 actions 里也再拦一次。
export function MemberRow({
  id,
  name,
  role,
  status,
  locked,
  lockReason,
}: {
  id: string;
  name: string;
  role: string;
  status: string;
  locked: boolean;
  lockReason?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState('');

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, confirm?: string) {
    if (confirm && !window.confirm(confirm)) return;
    setMsg('');
    start(async () => {
      const r = await fn();
      if (!r.ok) setMsg(r.error ?? '操作失败');
      else router.refresh();
      setTimeout(() => setMsg(''), 3500);
    });
  }

  if (locked) {
    return (
      <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
        <span className="badge badge-gray">{ROLE_LABEL[role as keyof typeof ROLE_LABEL] ?? role}</span>
        {lockReason && <span className="small muted">{lockReason}</span>}
      </div>
    );
  }

  return (
    <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
      <select
        className="select"
        style={{ width: 'auto' }}
        value={role}
        disabled={pending}
        onChange={(e) => run(() => actChangeRole(id, e.target.value))}
      >
        {ASSIGNABLE_ROLES.map((r) => (
          <option key={r} value={r}>{ROLE_LABEL[r]}</option>
        ))}
      </select>
      {status === 'active' ? (
        <button
          className="btn btn-sm btn-ghost"
          disabled={pending}
          onClick={() => run(() => actSetMemberStatus(id, 'suspended'), `确认停用「${name}」？其登录会话会立即失效，数据保留。`)}
        >
          停用
        </button>
      ) : (
        <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => run(() => actSetMemberStatus(id, 'active'))}>
          恢复
        </button>
      )}
      <button
        className="btn btn-sm btn-ghost"
        style={{ color: 'var(--red)' }}
        disabled={pending}
        onClick={() => run(() => actRemoveMember(id), `确认移除「${name}」？该成员将失去本工作区的全部访问权，此操作不可撤销。`)}
      >
        移除
      </button>
      {msg && <span className="small" style={{ color: 'var(--red)' }}>{msg}</span>}
    </div>
  );
}
