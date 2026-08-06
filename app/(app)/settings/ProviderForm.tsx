'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actAddProvider } from './actions';
import { LLM_VENDORS, LLM_VENDOR_KEYS } from '@/lib/constants';

// 供应商白名单来自 lib/constants.ts —— 与服务端校验同一份表（单一事实来源）。
// 这里**没有「自定义端点」选项**：PRD §10.5 L3「任意端点永不开放」，UI 提供该入口本身就是错的。
// base_url 与 region 都由供应商预置、不可编辑（F12-1 验收③：UI 与 API 双层锁定）。

export function ProviderForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState('');
  const [failed, setFailed] = useState(false); // 拒绝文案不能用成功的绿色
  const [vendor, setVendor] = useState('deepseek');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(LLM_VENDORS.deepseek.model);

  const preset = LLM_VENDORS[vendor];

  function pickVendor(v: string) {
    setVendor(v);
    setModel(LLM_VENDORS[v].model);
  }

  function submit() {
    setMsg('');
    setFailed(false);
    start(async () => {
      const r = await actAddProvider({ label: label || preset.name, vendor, baseUrl: preset.baseUrl, apiKey, model });
      if (r.ok) {
        setMsg('已添加渠道，请点「连通性测试」验证');
        setLabel('');
        setApiKey('');
        router.refresh();
        setTimeout(() => setMsg(''), 3000);
      } else {
        setFailed(true);
        setMsg(r.error ?? '添加失败');
      }
    });
  }

  const isOverseas = preset.region === 'overseas';

  return (
    <form className="stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <div className="grid grid-2" style={{ gap: 12 }}>
        <div className="field">
          <label className="field-label">供应商</label>
          <select className="select" value={vendor} onChange={(e) => pickVendor(e.target.value)}>
            {LLM_VENDOR_KEYS.map((v) => (
              <option key={v} value={v}>{LLM_VENDORS[v].name}{LLM_VENDORS[v].region === 'overseas' ? '（海外）' : ''}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label">渠道名称（自定义标识）</label>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={preset.name} />
        </div>
      </div>

      <div className="field">
        <label className="field-label">API 端点 base_url（平台锁定·不可改）</label>
        <input className="input mono" value={preset.baseUrl} readOnly disabled />
        <div className="small" style={{ color: 'var(--muted)', marginTop: 4 }}>
          端点由平台按供应商白名单预置，不开放自定义端点——防止流量被转去来路不明的中转服务
        </div>
      </div>

      <div className="grid grid-2" style={{ gap: 12 }}>
        <div className="field">
          <label className="field-label">模型名（豆包填接入点 ID）</label>
          <input className="input mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-chat" />
        </div>
        <div className="field">
          <label className="field-label">合规区域（随供应商，不可选）</label>
          <input className="input" value={isOverseas ? '海外（限企业版·出海场景）' : '国内已备案'} readOnly disabled />
        </div>
      </div>

      <div className="field">
        <label className="field-label">API Key（只写不读，入库即加密）</label>
        <input className="input mono" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
      </div>

      {isOverseas && (
        <div className="small" style={{ color: 'var(--amber)', background: 'var(--surface-2)', padding: '8px 10px', borderRadius: 8 }}>
          海外模型仅企业版的出海内容场景可启用；发送给模型的内容会先脱敏个人信息，生成结果照常过平台合规检测。
        </div>
      )}

      <div className="row" style={{ gap: 10 }}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={pending || !apiKey}>
          {pending ? '添加中…' : '添加渠道'}
        </button>
        {msg && <span className="small" style={{ color: failed ? 'var(--red)' : 'var(--green)' }}>{msg}</span>}
      </div>
    </form>
  );
}
