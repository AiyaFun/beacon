'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ROLE_LABEL, ROLE_DESC, type Role } from '@/lib/rbac';
import { actCreateInvite } from './actions';

// 邀请表单：手机号可选（留空 = 凭链接任何人可接受）+ 角色选择。
export function InviteForm({ roles }: { roles: Role[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState('editor');
  const [err, setErr] = useState('');
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);

  function submit() {
    setErr('');
    setLink('');
    start(async () => {
      const r = await actCreateInvite({ phone: phone || undefined, role });
      if (r.ok && r.token) {
        setLink(`${window.location.origin}/login?invite=${r.token}`);
        setPhone('');
        router.refresh();
      } else {
        setErr(r.error ?? '创建邀请失败');
      }
    });
  }

  function copy() {
    navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="grid grid-2" style={{ gap: 12 }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field-label">被邀请人手机号（选填）</label>
          <input
            className="input"
            inputMode="numeric"
            maxLength={11}
            value={phone}
            placeholder="留空则任何人凭链接可加入"
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field-label">角色</label>
          <select className="select" value={role} onChange={(e) => setRole(e.target.value)}>
            {roles.map((r) => (
              <option key={r} value={r}>{ROLE_LABEL[r]}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="small muted">{ROLE_DESC[role as keyof typeof ROLE_DESC]}</div>

      {!phone && (
        <div className="small" style={{ color: 'var(--amber)', background: 'var(--surface-2)', padding: '8px 10px', borderRadius: 8 }}>
          不填手机号的邀请链接谁拿到谁能用（仅限一次）。给确定的人发邀请时建议填手机号，链接泄漏也无法被冒用。
        </div>
      )}

      <div className="row wrap" style={{ gap: 10 }}>
        <button className="btn btn-primary btn-sm" onClick={submit} disabled={pending}>
          {pending ? '生成中…' : '生成邀请链接'}
        </button>
        {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
      </div>

      {link && (
        <div className="stack" style={{ gap: 6, background: 'var(--surface-2)', padding: '10px 12px', borderRadius: 8 }}>
          <div className="small muted">邀请链接已生成，7 天内有效。复制发给对方，对方用手机验证码登录即加入本工作区。</div>
          <div className="row wrap" style={{ gap: 8 }}>
            <span className="small mono" style={{ wordBreak: 'break-all', flex: 1, minWidth: 200 }}>{link}</span>
            <button className="btn btn-sm" onClick={copy}>{copied ? '已复制' : '复制'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
