'use client';

import { useState, useTransition } from 'react';
import { Card } from '@/components/ui';
import { actSetPassword } from './password-actions';

// 本机密码（个人创作者小站，仅 appliance/private 渲染——能力闸在 server action 再拦一道）。
// 设过的改密码要先输旧的；没设过直接设。
export function PasswordCard({ hasPassword }: { hasPassword: boolean }) {
  const [pending, start] = useTransition();
  const [oldPwd, setOldPwd] = useState('');
  const [pwd, setPwd] = useState('');
  const [pwd2, setPwd2] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function submit() {
    setMsg(null);
    start(async () => {
      const r = await actSetPassword(hasPassword ? oldPwd : null, pwd);
      if (!r.ok) {
        setMsg({ ok: false, text: r.message ?? '没改成' });
        return;
      }
      setMsg({ ok: true, text: hasPassword ? '密码已更新' : '密码已设置，以后可在登录页凭它进来' });
      setOldPwd(''); setPwd(''); setPwd2('');
    });
  }

  return (
    <Card
      title="本机登录密码"
      sub={hasPassword ? '登录页凭它进来；企业应用失效时它是备用门' : '还没设置。设一个之后，登录页就多一条不依赖企业应用的入口'}
    >
      <div style={{ display: 'grid', gap: 10, maxWidth: 360 }}>
        {hasPassword && (
          <div className="field" style={{ margin: 0 }}>
            <div className="field-label">当前密码</div>
            <input type="password" value={oldPwd} onChange={(e) => setOldPwd(e.target.value)} autoComplete="current-password" />
          </div>
        )}
        <div className="field" style={{ margin: 0 }}>
          <div className="field-label">新密码（至少 8 位）</div>
          <input type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} autoComplete="new-password" />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <div className="field-label">再输一遍</div>
          <input type="password" value={pwd2} onChange={(e) => setPwd2(e.target.value)} autoComplete="new-password" />
          {pwd2 && pwd !== pwd2 && <div className="small" style={{ color: 'var(--red)', marginTop: 4 }}>两次输入不一致</div>}
        </div>
        {msg && <div className="small" style={{ color: msg.ok ? 'var(--green)' : 'var(--red)' }}>{msg.text}</div>}
        <div>
          <button
            className="btn btn-sm btn-primary"
            disabled={pending || pwd.length < 8 || pwd !== pwd2 || (hasPassword && !oldPwd)}
            onClick={submit}
          >
            {pending ? '保存中…' : hasPassword ? '更新密码' : '设置密码'}
          </button>
        </div>
      </div>
    </Card>
  );
}
