'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actRequestCode, actVerifyCode } from './actions';

// invite 由 /login?invite=<token> 经服务端校验后传入；带上它则登录即加入受邀工作区。
export type InviteHint = { token: string; tenantName: string; roleLabel: string; targeted: boolean };

export function LoginForm({ invite, wechatEnabled, wxError }: { invite?: InviteHint | null; wechatEnabled?: boolean; wxError?: string }) {
  // 微信可用且非邀请流时，微信一键登录是首选；手机验证码收为次选入口。
  // 邀请流保持手机号表单（定向邀请按手机号核身，见 verifyLoginCode 的 invite 分叉）。
  const wechatFirst = !!wechatEnabled && !invite;
  const [method, setMethod] = useState<'wechat' | 'phone'>(wechatFirst ? 'wechat' : 'phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [msg, setMsg] = useState('');
  const [devCode, setDevCode] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [consent, setConsent] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();

  function tick() {
    setCooldown(60);
    const timer = setInterval(() => {
      setCooldown((c) => {
        if (c <= 1) { clearInterval(timer); return 0; }
        return c - 1;
      });
    }, 1000);
  }

  function sendCode() {
    // 同意闸必须挡在**发码**这一步，不能只挡在验证那一步。
    // 手机号是个人信息，发短信就是处理它——真机 2026-07-30：不勾同意直接点「获取验证码」，
    // 号码照样提交到服务端、短信照样发出（火山通道还按条计费）。
    // verify()、微信登录入口、提交按钮此前都查了 consent，唯独这里漏了。
    if (!consent) { setMsg('请先阅读并同意隐私政策与服务条款'); return; }
    setMsg('');
    start(async () => {
      const r = await actRequestCode(phone);
      if (r.ok) {
        setStep('code');
        tick();
        if (r.devCode) { setDevCode(r.devCode); setCode(r.devCode); }
      } else {
        setMsg(r.message ?? '发送失败');
      }
    });
  }

  function verify() {
    if (!consent) { setMsg('请先阅读并同意隐私政策与服务条款'); return; }
    setMsg('');
    start(async () => {
      const r = await actVerifyCode(phone, code, invite?.token, consent);
      if (r.ok) {
        router.replace('/');
        router.refresh();
      } else {
        setMsg(r.message ?? '登录失败');
      }
    });
  }

  const consentRow = (
    <label className="row" style={{ gap: 8, cursor: 'pointer', userSelect: 'none' }}>
      <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
      <span className="small">
        我已阅读并同意
        <a href="/legal/privacy" target="_blank" rel="noopener" style={{ color: 'var(--brand)' }}>《隐私政策》</a>
        和
        <a href="/legal/terms" target="_blank" rel="noopener" style={{ color: 'var(--brand)' }}>《服务条款》</a>
      </span>
    </label>
  );

  const wechatIcon = (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
      <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.534c0 2.22 1.174 4.142 3.016 5.49a.58.58 0 0 1 .218.636l-.366 1.394a.37.37 0 0 0 .506.422l1.724-.862a.833.833 0 0 1 .608-.063 10.15 10.15 0 0 0 2.985.446c.329 0 .653-.02.974-.052a5.94 5.94 0 0 1-.253-1.726c0-3.562 3.222-6.452 7.196-6.452.347 0 .687.027 1.022.067C16.888 4.68 13.095 2.188 8.691 2.188zm-2.8 4.17a1.07 1.07 0 1 1 0 2.14 1.07 1.07 0 0 1 0-2.14zm5.617 0a1.07 1.07 0 1 1 0 2.14 1.07 1.07 0 0 1 0-2.14zM16.608 9.82c-3.47 0-6.283 2.514-6.283 5.615 0 3.103 2.812 5.616 6.283 5.616.667 0 1.312-.1 1.923-.277a.7.7 0 0 1 .508.05l1.4.7a.306.306 0 0 0 .42-.35l-.298-1.134a.484.484 0 0 1 .182-.53C22.32 18.3 23.29 16.62 23.29 15.436c0-3.101-2.99-5.616-6.682-5.616zm-2.15 3.39a.903.903 0 1 1 0 1.806.903.903 0 0 1 0-1.807zm4.3 0a.903.903 0 1 1 0 1.806.903.903 0 0 1 0-1.807z"/>
    </svg>
  );

  // ── 微信优先视图 ──
  if (method === 'wechat') {
    return (
      <div className="stack" style={{ gap: 14 }}>
        <a
          href="/api/auth/wechat/redirect"
          onClick={(e) => {
            if (!consent) { e.preventDefault(); setMsg('请先阅读并同意隐私政策与服务条款'); }
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            width: '100%',
            padding: '13px 0',
            borderRadius: 8,
            border: 'none',
            background: '#07C160',
            color: '#fff',
            fontSize: 15,
            fontWeight: 600,
            textDecoration: 'none',
            cursor: 'pointer',
          }}
        >
          {wechatIcon}
          微信一键登录
        </a>
        <div className="small muted" style={{ textAlign: 'center' }}>
          电脑上扫码、微信里点一下即可，无需密码
        </div>

        {msg && <div className="small" style={{ color: 'var(--red)' }}>{msg}</div>}
        {wxError && <div className="small" style={{ color: 'var(--red)', textAlign: 'center' }}>{wxError}</div>}

        {consentRow}

        <div className="row" style={{ alignItems: 'center', gap: 10, marginTop: 4 }}>
          <div style={{ flex: 1, height: 1, background: '#e2e8f0' }} />
          <span style={{ fontSize: 12, color: '#94a3b8' }}>其他登录方式</span>
          <div style={{ flex: 1, height: 1, background: '#e2e8f0' }} />
        </div>
        <button className="btn" onClick={() => { setMsg(''); setMethod('phone'); }}>
          手机验证码登录
        </button>

        <div className="small muted" style={{ textAlign: 'center' }}>
          未注册的微信/手机号登录后将自动创建账号，注册即送 30 天标准版（AI 额度 200 次/天）
        </div>
      </div>
    );
  }

  // ── 手机验证码视图（邀请流 / 微信未启用 / 用户主动切换）──
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="field">
        <label className="field-label">手机号</label>
        <input
          className="input"
          inputMode="numeric"
          placeholder="请输入手机号"
          value={phone}
          maxLength={11}
          onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
          disabled={step === 'code'}
        />
      </div>

      {step === 'code' && (
        <div className="field">
          <label className="field-label">验证码</label>
          <div className="row" style={{ gap: 8 }}>
            <input
              className="input"
              inputMode="numeric"
              placeholder="6 位验证码"
              value={code}
              maxLength={6}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
            <button className="btn btn-sm" onClick={sendCode} disabled={pending || cooldown > 0} style={{ whiteSpace: 'nowrap' }}>
              {cooldown > 0 ? `${cooldown}s` : '重新发送'}
            </button>
          </div>
          {devCode && (
            <div className="small muted" style={{ marginTop: 6 }}>
              开发模式验证码：<b className="mono">{devCode}</b>（已自动填入）
            </div>
          )}
        </div>
      )}

      {msg && <div className="small" style={{ color: 'var(--red)' }}>{msg}</div>}

      {consentRow}

      {step === 'phone' ? (
        <button className="btn btn-primary" onClick={sendCode} disabled={pending || phone.length !== 11 || !consent}>
          {pending ? '发送中…' : '获取验证码'}
        </button>
      ) : (
        <button className="btn btn-primary" onClick={verify} disabled={pending || code.length !== 6 || !consent}>
          {pending ? (invite ? '加入中…' : '登录中…') : invite ? '验证并加入工作区' : '登录 / 注册'}
        </button>
      )}

      <div className="small muted" style={{ textAlign: 'center' }}>
        {invite
          ? `验证通过后将以${invite.roleLabel}身份加入${invite.tenantName}`
          : '未注册的手机号验证后将自动创建账号，注册即送 30 天标准版（AI 额度 200 次/天）'}
      </div>

      {wechatFirst && (
        <>
          <div className="row" style={{ alignItems: 'center', gap: 10, marginTop: 4 }}>
            <div style={{ flex: 1, height: 1, background: '#e2e8f0' }} />
            <span style={{ fontSize: 12, color: '#94a3b8' }}>其他登录方式</span>
            <div style={{ flex: 1, height: 1, background: '#e2e8f0' }} />
          </div>
          <button
            className="btn"
            onClick={() => { setMsg(''); setMethod('wechat'); }}
            style={{ color: '#07C160', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="#07C160">
              <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.534c0 2.22 1.174 4.142 3.016 5.49a.58.58 0 0 1 .218.636l-.366 1.394a.37.37 0 0 0 .506.422l1.724-.862a.833.833 0 0 1 .608-.063 10.15 10.15 0 0 0 2.985.446c.329 0 .653-.02.974-.052a5.94 5.94 0 0 1-.253-1.726c0-3.562 3.222-6.452 7.196-6.452.347 0 .687.027 1.022.067C16.888 4.68 13.095 2.188 8.691 2.188zm-2.8 4.17a1.07 1.07 0 1 1 0 2.14 1.07 1.07 0 0 1 0-2.14zm5.617 0a1.07 1.07 0 1 1 0 2.14 1.07 1.07 0 0 1 0-2.14zM16.608 9.82c-3.47 0-6.283 2.514-6.283 5.615 0 3.103 2.812 5.616 6.283 5.616.667 0 1.312-.1 1.923-.277a.7.7 0 0 1 .508.05l1.4.7a.306.306 0 0 0 .42-.35l-.298-1.134a.484.484 0 0 1 .182-.53C22.32 18.3 23.29 16.62 23.29 15.436c0-3.101-2.99-5.616-6.682-5.616zm-2.15 3.39a.903.903 0 1 1 0 1.806.903.903 0 0 1 0-1.807zm4.3 0a.903.903 0 1 1 0 1.806.903.903 0 0 1 0-1.807z"/>
            </svg>
            微信一键登录
          </button>
        </>
      )}

      {wxError && !wechatFirst && (
        <div className="small" style={{ color: 'var(--red)', textAlign: 'center' }}>{wxError}</div>
      )}
    </div>
  );
}
