'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actPasswordLogin } from './actions';

// 本机密码登录表单（个人创作者小站）。
// 只在 OaLoginPanel 查到「有人设过密码」时被渲染——没人设过就不摆一个必然失败的表单。
export function PasswordLoginForm({ defaultName }: { defaultName?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState(defaultName ?? '');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');

  function submit() {
    setErr('');
    start(async () => {
      const r = await actPasswordLogin(name, password);
      if (!r.ok) {
        setErr(r.message ?? '登录失败');
        return;
      }
      router.replace('/');
      router.refresh();
    });
  }

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      style={{ marginTop: 4, display: 'grid', gap: 10 }}
    >
      <div className="field" style={{ margin: 0 }}>
        <div className="field-label">成员名</div>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="装机时填的管理员称呼" autoComplete="username" />
      </div>
      <div className="field" style={{ margin: 0 }}>
        <div className="field-label">本机密码</div>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="装机向导里设的那个密码" autoComplete="current-password" />
      </div>
      {err && <div className="small" style={{ color: 'var(--red, #b91c1c)' }}>{err}</div>}
      <button className="btn btn-primary" type="submit" disabled={pending || !name.trim() || !password}>
        {pending ? '登录中…' : '登录'}
      </button>
    </form>
  );
}
