'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actCheckSetupToken, actCompleteSetup } from './actions';

type Vendor = { key: string; name: string; model: string };
type OaProvider = 'feishu' | 'dingtalk' | 'wecom';

const OA: { key: OaProvider; name: string; idLabel: string; secretLabel: string; needsVerify: boolean; needsCorp: boolean }[] = [
  { key: 'feishu', name: '飞书', idLabel: 'App ID', secretLabel: 'App Secret', needsVerify: true, needsCorp: false },
  { key: 'dingtalk', name: '钉钉', idLabel: 'AppKey', secretLabel: 'AppSecret', needsVerify: false, needsCorp: false },
  { key: 'wecom', name: '企业微信', idLabel: 'AgentID', secretLabel: 'Secret', needsVerify: true, needsCorp: true },
];

const STEPS = ['装机口令', '团队与管理员', '大模型 Key', '企业应用'] as const;

export function SetupWizard({
  vendors,
  tokenConfigured,
  edition,
}: {
  vendors: Vendor[];
  tokenConfigured: boolean;
  edition: string;
}) {
  const [step, setStep] = useState(0);
  const [msg, setMsg] = useState('');
  const [pending, start] = useTransition();
  const router = useRouter();

  const [token, setToken] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [adminName, setAdminName] = useState('');
  // 本机登录密码：必设。OA 是可选步、一次性链接又要已登录的管理员才能生成——
  // 不设密码的话，会话一过期人就被锁在门外只能重装（个人创作者小站的第一课）。
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [vendor, setVendor] = useState(vendors[0]?.key ?? '');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');

  const [oaProvider, setOaProvider] = useState<OaProvider>('feishu');
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [verificationToken, setVerificationToken] = useState('');
  const [encryptKeyVal, setEncryptKeyVal] = useState('');
  const [corpId, setCorpId] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');

  const oaSpec = OA.find((o) => o.key === oaProvider)!;

  function checkToken() {
    setMsg('');
    start(async () => {
      const r = await actCheckSetupToken(token);
      if (r.ok) setStep(1);
      else setMsg(r.message ?? '口令不正确');
    });
  }

  function submit(withOa: boolean) {
    setMsg('');
    start(async () => {
      const r = await actCompleteSetup({
        token,
        companyName,
        adminName,
        password,
        llm: { vendor, apiKey, model: model || undefined },
        oa:
          withOa && appId.trim() && appSecret.trim()
            ? {
                provider: oaProvider,
                appId,
                appSecret,
                verificationToken: verificationToken || undefined,
                encryptKey: encryptKeyVal || undefined,
                corpId: corpId || undefined,
                webhookUrl: webhookUrl || undefined,
              }
            : undefined,
      });
      // 成功后跳独立的完成页。**不要**在这里切本地状态：
      // 写 cookie 会让 Next 重新拉 /setup 的 RSC，而那时 isInitialized() 已为真、
      // 服务端立刻 redirect 走，本地这一屏根本来不及渲染（真机 2026-08-18 实测）。
      if (r.ok) router.replace('/setup/done');
      else setMsg(r.message ?? '初始化失败');
    });
  }

  return (
    <div className="app-shell" style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
      <div className="card">
        <div className="card-title">烽火台 · 初始化</div>
        <p className="card-sub">
          本机版本：<span className="badge badge-brand">{edition}</span> · 这台实例还没有配置过，
          下面四步做完就能给团队用。
        </p>

        <div style={{ display: 'flex', gap: 8, margin: '14px 0', flexWrap: 'wrap' }}>
          {STEPS.map((s, i) => (
            <span key={s} className={`badge ${i === step ? 'badge-brand' : 'badge-gray'}`}>
              {i + 1}. {s}
            </span>
          ))}
        </div>

        {/* ① 装机口令 */}
        {step === 0 && (
          <>
            {!tokenConfigured && (
              <div className="alert-gradient-amber" style={{ padding: 12, borderRadius: 8, marginBottom: 12 }}>
                这台实例没有配置装机口令（BEACON_SETUP_TOKEN）。请重新运行安装脚本 —— 
                没有口令的话，同一个网络里任何人都能抢先成为管理员。
              </div>
            )}
            <div className="field">
              <div className="field-label">装机口令</div>
              <input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="安装脚本结束时打印的那一串，也写在桌面的《安装说明》里"
                autoComplete="off"
              />
            </div>
            <button className="btn btn-primary" disabled={pending || !token.trim()} onClick={checkToken}>
              {pending ? '校验中…' : '下一步'}
            </button>
          </>
        )}

        {/* ② 团队与管理员 */}
        {step === 1 && (
          <>
            <div className="field">
              <div className="field-label">团队 / 公司名称</div>
              <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="例如：星野文化" />
            </div>
            <div className="field">
              <div className="field-label">管理员称呼</div>
              <input value={adminName} onChange={(e) => setAdminName(e.target.value)} placeholder="例如：老王" />
            </div>
            <div className="field">
              <div className="field-label">本机登录密码（至少 8 位）</div>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="以后就凭它登录这台烽火台" autoComplete="new-password" />
            </div>
            <div className="field">
              <div className="field-label">再输一遍</div>
              <input type="password" value={password2} onChange={(e) => setPassword2(e.target.value)} autoComplete="new-password" />
              {password2 && password !== password2 && (
                <div className="small" style={{ color: 'var(--red, #b91c1c)', marginTop: 4 }}>两次输入不一致</div>
              )}
            </div>
            <p className="small" style={{ color: '#64748b', lineHeight: 1.7, marginTop: -4 }}>
              这是你进系统的钥匙：配了企业应用的团队也建议记好——企业应用没配好或失效时，凭它照样能进来。
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => setStep(0)}>上一步</button>
              <button
                className="btn btn-primary"
                disabled={!companyName.trim() || password.length < 8 || password !== password2}
                onClick={() => setStep(2)}
              >
                下一步
              </button>
            </div>
          </>
        )}

        {/* ③ 大模型 Key */}
        {step === 2 && (
          <>
            <p className="card-sub">
              企业版的 AI 全部走你自己的 Key（BYOK）—— 调用直连厂商，费用与限额都在你自己账号下，
              我们这边不经手也不垫付。
            </p>
            <div className="field">
              <div className="field-label">模型厂商</div>
              <select value={vendor} onChange={(e) => setVendor(e.target.value)}>
                {vendors.map((v) => (
                  <option key={v.key} value={v.key}>{v.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <div className="field-label">API Key</div>
              <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." autoComplete="off" />
            </div>
            <div className="field">
              <div className="field-label">
                模型名（可留空，默认 {vendors.find((v) => v.key === vendor)?.model}）
              </div>
              <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="留空即用默认" />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => setStep(1)}>上一步</button>
              <button className="btn btn-primary" disabled={apiKey.trim().length < 8} onClick={() => setStep(3)}>下一步</button>
            </div>
          </>
        )}

        {/* ④ 企业应用（可跳过） */}
        {step === 3 && (
          <>
            <p className="card-sub">
              配好之后，公司同事在群里 @机器人 就能下令；现在没建好也没关系，
              装完可以在「设置 → 机器人」里补。
            </p>
            <div className="field">
              <div className="field-label">企业应用</div>
              <select value={oaProvider} onChange={(e) => setOaProvider(e.target.value as OaProvider)}>
                {OA.map((o) => (
                  <option key={o.key} value={o.key}>{o.name}</option>
                ))}
              </select>
            </div>
            {oaSpec.needsCorp && (
              <div className="field">
                <div className="field-label">Corp ID</div>
                <input value={corpId} onChange={(e) => setCorpId(e.target.value)} autoComplete="off" />
              </div>
            )}
            <div className="field">
              <div className="field-label">{oaSpec.idLabel}</div>
              <input value={appId} onChange={(e) => setAppId(e.target.value)} autoComplete="off" />
            </div>
            <div className="field">
              <div className="field-label">{oaSpec.secretLabel}</div>
              <input value={appSecret} onChange={(e) => setAppSecret(e.target.value)} autoComplete="off" />
            </div>
            {oaSpec.needsVerify && (
              <>
                <div className="field">
                  <div className="field-label">Verification Token（事件订阅，可留空）</div>
                  <input value={verificationToken} onChange={(e) => setVerificationToken(e.target.value)} autoComplete="off" />
                </div>
                <div className="field">
                  <div className="field-label">Encrypt Key（开了加密才填）</div>
                  <input value={encryptKeyVal} onChange={(e) => setEncryptKeyVal(e.target.value)} autoComplete="off" />
                </div>
              </>
            )}
            <div className="field">
              <div className="field-label">群机器人 Webhook（出站推送用，可留空）</div>
              <input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." />
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-ghost" onClick={() => setStep(2)}>上一步</button>
              <button className="btn btn-ghost" disabled={pending} onClick={() => submit(false)}>
                跳过，先装好
              </button>
              <button className="btn btn-primary" disabled={pending || !appId.trim() || !appSecret.trim()} onClick={() => submit(true)}>
                {pending ? '初始化中…' : '完成初始化'}
              </button>
            </div>
          </>
        )}

        {msg && <p style={{ color: 'var(--red, #e5484d)', marginTop: 12 }}>{msg}</p>}
      </div>
    </div>
  );
}
