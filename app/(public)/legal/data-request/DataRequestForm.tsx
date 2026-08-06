'use client';

import { useState, useTransition } from 'react';
import { PLATFORM_LIST } from '@/lib/constants';
import { actSubmitDataRemoval } from './actions';

export function DataRequestForm() {
  const [platform, setPlatform] = useState('');
  const [handle, setHandle] = useState('');
  const [contact, setContact] = useState('');
  const [reason, setReason] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [pending, start] = useTransition();

  function submit() {
    setError('');
    start(async () => {
      const r = await actSubmitDataRemoval({ platform, handle, contact, reason });
      if (r.ok) setDone(true);
      else setError(r.error ?? '提交失败，请稍后再试');
    });
  }

  if (done) {
    return (
      <div className="card" style={{ padding: 20, background: 'var(--surface-2)', boxShadow: 'none', textAlign: 'center' }}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>申请已收到</div>
        <div className="small muted" style={{ lineHeight: 1.7 }}>
          我们将在 15 个工作日内核实并处理，处理结果会通过你留下的联系方式回复。
          核实期间会暂停对该账号的新增采集。
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 20, background: 'var(--surface-2)', boxShadow: 'none' }}>
      <div className="stack" style={{ gap: 14 }}>
        <div className="field">
          <label className="field-label">所在平台 <span style={{ color: 'var(--red)' }}>*</span></label>
          <select className="input" value={platform} onChange={(e) => setPlatform(e.target.value)}>
            <option value="">请选择…</option>
            {PLATFORM_LIST.map((p) => (
              <option key={p.key} value={p.key}>{p.name}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label">被监控账号主页链接 / 标识 <span style={{ color: 'var(--red)' }}>*</span></label>
          <input
            className="input"
            placeholder="如账号主页 URL 或用户名，便于我们定位"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            maxLength={200}
          />
        </div>
        <div className="field">
          <label className="field-label">你的联系方式 <span style={{ color: 'var(--red)' }}>*</span></label>
          <input
            className="input"
            placeholder="邮箱或手机号，用于回复处理结果"
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            maxLength={100}
          />
        </div>
        <div className="field">
          <label className="field-label">补充说明（选填）</label>
          <textarea
            className="textarea"
            rows={3}
            placeholder="如你与该账号的关系、移除诉求等"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={1000}
          />
        </div>
        <div className="row" style={{ gap: 12, alignItems: 'center' }}>
          <button className="btn btn-primary" onClick={submit} disabled={pending || !platform || !handle.trim() || !contact.trim()}>
            {pending ? '提交中…' : '提交移除申请'}
          </button>
          {error && <span className="small" style={{ color: 'var(--red)' }}>{error}</span>}
        </div>
      </div>
    </div>
  );
}
