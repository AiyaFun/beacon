'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ROLE_LABEL, ROLE_DESC, type Role } from '@/lib/rbac';
import { useI18n } from '@/lib/i18n';
import { actCreateInvite } from './actions';

const ROLE_LABEL_EN: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  editor: 'Editor',
  viewer: 'Viewer',
};

const ROLE_DESC_EN: Record<Role, string> = {
  owner: 'Full permissions including workspace deletion, ownership transfer, billing management',
  admin: 'Manage members & model configurations + all content actions; cannot modify owner',
  editor: 'Full content pipeline (topics/drafts/compliance/publishing); no member/model access',
  viewer: 'Read-only; can view all content without edit permissions',
};

// 邀请表单：手机号可选（留空 = 凭链接任何人可接受）+ 角色选择。
export function InviteForm({ roles }: { roles: Role[] }) {
  const { lang } = useI18n();
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
        setErr(r.error ?? (lang === 'en' ? 'Failed to create invite' : '创建邀请失败'));
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
          <label className="field-label">{lang === 'en' ? 'Invitee Phone Number (Optional)' : '被邀请人手机号（选填）'}</label>
          <input
            className="input"
            inputMode="numeric"
            maxLength={11}
            value={phone}
            placeholder={lang === 'en' ? 'Leave empty to allow anyone with link to join' : '留空则任何人凭链接可加入'}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field-label">{lang === 'en' ? 'Role' : '角色'}</label>
          <select className="select" value={role} onChange={(e) => setRole(e.target.value)}>
            {roles.map((r) => (
              <option key={r} value={r}>{lang === 'en' ? ROLE_LABEL_EN[r] : ROLE_LABEL[r]}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="small muted">
        {lang === 'en' ? ROLE_DESC_EN[role as Role] : ROLE_DESC[role as keyof typeof ROLE_DESC]}
      </div>

      {!phone && (
        <div className="small" style={{ color: 'var(--amber)', background: 'var(--surface-2)', padding: '8px 10px', borderRadius: 8 }}>
          {lang === 'en'
            ? 'Invite links without a phone number can be redeemed once by anyone who holds it. Specifying a phone number ensures the link cannot be misused even if leaked.'
            : '不填手机号的邀请链接谁拿到谁能用（仅限一次）。给确定的人发邀请时建议填手机号，链接泄漏也无法被冒用。'}
        </div>
      )}

      <div className="row wrap" style={{ gap: 10 }}>
        <button className="btn btn-primary btn-sm" onClick={submit} disabled={pending}>
          {pending ? (lang === 'en' ? 'Generating…' : '生成中…') : (lang === 'en' ? 'Generate Invite Link' : '生成邀请链接')}
        </button>
        {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
      </div>

      {link && (
        <div className="stack" style={{ gap: 6, background: 'var(--surface-2)', padding: '10px 12px', borderRadius: 8 }}>
          <div className="small muted">
            {lang === 'en'
              ? 'Invite link generated, valid for 7 days. Send this link to the recipient; they will join this workspace upon SMS verification.'
              : '邀请链接已生成，7 天内有效。复制发给对方，对方用手机验证码登录即加入本工作区。'}
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <span className="small mono" style={{ wordBreak: 'break-all', flex: 1, minWidth: 200 }}>{link}</span>
            <button className="btn btn-sm" onClick={copy}>{copied ? (lang === 'en' ? 'Copied ✓' : '已复制') : (lang === 'en' ? 'Copy' : '复制')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
