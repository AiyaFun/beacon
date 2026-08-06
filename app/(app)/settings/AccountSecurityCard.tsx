'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui';
import { Icon } from '@/components/icons';
import { actRequestBindPhoneCode, actBindPhone, actUnbindPhone, actUnbindWechat } from './actions';

type Props = {
  maskedPhone: string | null; // 已脱敏（138****1234）；null = 未绑定
  wechatBound: boolean;
  wechatEnabled: boolean; // 服务端未配微信 AppID 时不渲染绑定入口
  isDemo: boolean;
  // 微信 OAuth 绑定回跳结果（callback 落在 /settings?wx_bind=ok|wx_bind_error=…）
  wxBindOk?: boolean;
  wxBindError?: string;
};

export function AccountSecurityCard({
  maskedPhone,
  wechatBound,
  wechatEnabled,
  isDemo,
  wxBindOk,
  wxBindError,
}: Props) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [devCode, setDevCode] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [msg, setMsg] = useState('');
  const [changingPhone, setChangingPhone] = useState(false); // 已绑手机号时的「换绑」表单开关
  const [pending, start] = useTransition();
  const router = useRouter();

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  function resetPhoneForm() {
    setPhone('');
    setCode('');
    setCodeSent(false);
    setDevCode('');
    setMsg('');
    setChangingPhone(false);
  }

  function sendCode() {
    setMsg('');
    start(async () => {
      const r = await actRequestBindPhoneCode(phone);
      if (r.ok) {
        setCodeSent(true);
        setCooldown(60);
        const dev = (r as { devCode?: string }).devCode;
        if (dev) {
          setDevCode(dev);
          setCode(dev);
        }
      } else {
        setMsg(r.message ?? '发送失败');
      }
    });
  }

  function bindPhone() {
    setMsg('');
    start(async () => {
      const r = await actBindPhone(phone, code);
      if (r.ok) {
        resetPhoneForm();
        router.refresh(); // 服务端重新渲染，显示新的已绑定状态
      } else {
        setMsg(r.message ?? '绑定失败');
      }
    });
  }

  function unbindPhone() {
    if (!window.confirm('确定解绑手机号吗？解绑后将只能通过微信登录本账号。')) return;
    setMsg('');
    start(async () => {
      const r = await actUnbindPhone();
      if (r.ok) router.refresh();
      else setMsg(r.message ?? '解绑失败');
    });
  }

  function unbindWechat() {
    if (!window.confirm('确定解绑微信吗？解绑后将只能通过手机号验证码登录本账号。')) return;
    setMsg('');
    start(async () => {
      const r = await actUnbindWechat();
      if (r.ok) router.refresh();
      else setMsg(r.message ?? '解绑失败');
    });
  }

  const phoneBound = !!maskedPhone;

  const phoneForm = (
    <>
      <div className="row" style={{ gap: 8 }}>
        <input
          className="input"
          inputMode="numeric"
          placeholder={changingPhone ? '请输入新手机号' : '请输入手机号'}
          value={phone}
          maxLength={11}
          onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
        />
        <button
          className="btn btn-sm"
          onClick={sendCode}
          disabled={pending || cooldown > 0 || phone.length !== 11}
          style={{ whiteSpace: 'nowrap' }}
        >
          {cooldown > 0 ? `${cooldown}s` : codeSent ? '重新发送' : '获取验证码'}
        </button>
      </div>
      {codeSent && (
        <div className="row" style={{ gap: 8 }}>
          <input
            className="input"
            inputMode="numeric"
            placeholder="6 位验证码"
            value={code}
            maxLength={6}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
          <button className="btn btn-primary btn-sm" onClick={bindPhone} disabled={pending || code.length !== 6} style={{ whiteSpace: 'nowrap' }}>
            {pending ? '提交中…' : changingPhone ? '确认换绑' : '绑定'}
          </button>
        </div>
      )}
      {devCode && (
        <div className="small muted">
          开发模式验证码：<b className="mono">{devCode}</b>（已自动填入）
        </div>
      )}
      {changingPhone && (
        <div>
          <button className="btn btn-sm" onClick={resetPhoneForm} disabled={pending}>
            取消换绑
          </button>
        </div>
      )}
    </>
  );

  return (
    <Card
      title="账号与安全"
      sub="绑定手机号与微信后，两种方式都能登录同一账号 · 支持换绑与解绑（至少保留一种登录方式）"
      style={{ marginBottom: 16 }}
      action={
        <span className="badge badge-brand" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Icon.shield size={13} /> 登录方式
        </span>
      }
    >
      {wxBindOk && (
        <div className="small" style={{ color: 'var(--green)', marginBottom: 10 }}>
          ✓ 微信绑定成功，现在可以用微信扫码登录本账号了
        </div>
      )}
      {wxBindError && (
        <div className="small" style={{ color: 'var(--red)', marginBottom: 10 }}>
          {wxBindError}
        </div>
      )}

      <div className="grid grid-2" style={{ gap: 20, alignItems: 'start' }}>
        {/* 手机号 */}
        <div className="stack" style={{ gap: 10 }}>
          <div style={{ fontWeight: 600 }}>手机号</div>
          {isDemo ? (
            <div className="small muted">演示账号不支持绑定，注册后即可使用</div>
          ) : phoneBound ? (
            <>
              <div className="small">
                已绑定 <b className="mono">{maskedPhone}</b>
              </div>
              {!changingPhone && (
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn btn-sm" onClick={() => { setMsg(''); setChangingPhone(true); }} disabled={pending}>
                    换绑手机号
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={unbindPhone}
                    disabled={pending || !wechatBound}
                    title={wechatBound ? undefined : '请先绑定微信，账号至少要保留一种登录方式'}
                  >
                    解绑
                  </button>
                </div>
              )}
              {!changingPhone && !wechatBound && (
                <div className="small muted">绑定微信后才可解绑手机号（至少保留一种登录方式）</div>
              )}
              {changingPhone && phoneForm}
            </>
          ) : (
            <>
              {phoneForm}
              <div className="small muted">绑定后可用手机号验证码登录本账号</div>
            </>
          )}
        </div>

        {/* 微信 */}
        <div className="stack" style={{ gap: 10 }}>
          <div style={{ fontWeight: 600 }}>微信</div>
          {isDemo ? (
            <div className="small muted">演示账号不支持绑定，注册后即可使用</div>
          ) : !wechatEnabled ? (
            <div className="small muted">微信登录未启用（服务端未配置微信开放平台应用）</div>
          ) : wechatBound ? (
            <>
              <div className="small">
                已绑定 <span className="muted">（可微信扫码登录）</span>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <a className="btn btn-sm" href="/api/auth/wechat/redirect?mode=bind" title="扫新微信的码即可完成换绑">
                  换绑微信
                </a>
                <button
                  className="btn btn-sm"
                  onClick={unbindWechat}
                  disabled={pending || !phoneBound}
                  title={phoneBound ? undefined : '请先绑定手机号，账号至少要保留一种登录方式'}
                >
                  解绑
                </button>
              </div>
              {!phoneBound && (
                <div className="small muted">绑定手机号后才可解绑微信（至少保留一种登录方式）</div>
              )}
            </>
          ) : (
            <>
              <div>
                <a className="btn btn-sm" href="/api/auth/wechat/redirect?mode=bind">
                  一键绑定微信
                </a>
              </div>
              <div className="small muted">电脑上会打开微信扫码页，扫码确认后自动绑定到当前账号</div>
            </>
          )}
        </div>
      </div>

      {/* 到期/账单提醒怎么送达：不走邮件（产品决定不铺邮件通道）。
          三条腿都在产品内或用户已有的群里，不需要用户再绑一个新地址。 */}
      <div className="stack" style={{ gap: 6, marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--line)' }}>
        <div style={{ fontWeight: 600 }}>
          到期与账单提醒 <span className="small muted" style={{ fontWeight: 400 }}>· 怎么找到你</span>
        </div>
        <div className="small muted">
          ① 顶部横幅（到期前 7 天起常驻）· ② 通知中心小铃铛 · ③ 机器人推送到你的飞书/钉钉/企微群
          （在「设置 → 机器人集成」配一次即可）。<b>我们不发邮件</b>，也不需要你绑邮箱。
        </div>
      </div>

      {msg && (
        <div className="small" style={{ color: 'var(--red)', marginTop: 10 }}>
          {msg}
        </div>
      )}
    </Card>
  );
}
