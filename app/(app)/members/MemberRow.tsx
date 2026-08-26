'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ROLE_LABEL, type Role } from '@/lib/rbac';
import { actIssueLoginLink, actChangeRole, actSetMemberStatus, actRemoveMember } from './actions';

// 单个成员的操作条：改角色 / 停用恢复 / 移除。
// locked=true 时（owner 或自己）只展示角色，不给任何入口——边界在 actions 里也再拦一次。
export function MemberRow({
  id,
  name,
  role,
  status,
  locked,
  lockReason,
  roles,
  canIssueLoginLink,
}: {
  id: string;
  name: string;
  role: string;
  status: string;
  locked: boolean;
  lockReason?: string;
  /** 可授予的角色由服务端按部署形态算好传进来（客户端读不到 BEACON_EDITION） */
  roles: Role[];
  /** 这个部署形态给不给「本机登录链接」（SaaS 有短信/微信登录，不需要也不该有） */
  canIssueLoginLink: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState('');
  const [link, setLink] = useState('');

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
        {roles.map((r) => (
          <option key={r} value={r}>{ROLE_LABEL[r]}</option>
        ))}
      </select>
      {/* 一次性登录链接：企业版里客户可能压根没配企业应用机器人，
          那样同事从头到尾登不进来。权力来源是「已登录的管理员」，
          不是「知道装机口令的人」——那个口令是印在桌面说明书上的一次性凭证。 */}
      {canIssueLoginLink && status === 'active' && (
        <button
          className="btn btn-sm btn-ghost"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setMsg(''); setLink('');
              const r = await actIssueLoginLink(id);
              if (!r.ok) { setMsg(r.error ?? '生成失败'); return; }
              setLink(r.url ?? '');
            })
          }
        >
          生成登录链接
        </button>
      )}
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
      {link && (
        <span className="row wrap" style={{ gap: 6, flexBasis: '100%', marginTop: 6 }}>
          <input className="input" readOnly value={link} onFocus={(e) => e.currentTarget.select()} style={{ flex: 1, minWidth: 240, fontSize: 12 }} />
          <button
            className="btn btn-sm"
            onClick={() => { void navigator.clipboard?.writeText(link); setMsg('已复制'); setTimeout(() => setMsg(''), 2000); }}
          >
            复制
          </button>
          {/* 有效期必须写在脸上：用户会以为这是个长期地址，存下来下次再用 */}
          <span className="small muted" style={{ flexBasis: '100%' }}>
            5 分钟内有效、只能用一次。发给「{name}」本人，用过就失效。
          </span>
        </span>
      )}
    </div>
  );
}
