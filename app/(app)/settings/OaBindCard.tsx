'use client';

import { useState, useTransition } from 'react';
import { actIssueOaBindCode } from './account-actions';

// 绑定企业应用账号。企业版专属——SaaS 上这张卡不渲染（页面侧用 can('oaLogin') 判）。
export function OaBindCard({ providerName, bound }: { providerName: string | null; bound: boolean }) {
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState('');
  const [pending, start] = useTransition();

  function issue() {
    setMsg('');
    start(async () => {
      const r = await actIssueOaBindCode();
      if (r.ok && r.code) setCode(r.code);
      else setMsg(r.message ?? '获取失败');
    });
  }

  return (
    <div className="card">
      <div className="card-title">绑定{providerName ?? '企业应用'}账号</div>
      <p className="card-sub">
        {bound
          ? '已绑定。以后私聊机器人发「登录」就能拿到登录链接。'
          : '绑定之后就能私聊机器人发「登录」自助进来 —— 不绑的话，这次会话过期后你自己也登不回来。'}
      </p>

      {!bound && (
        <>
          {code ? (
            <div className="field">
              <div className="field-label">在{providerName ?? '企业应用'}里私聊机器人，发送这条：</div>
              <code style={{ display: 'block', padding: 10, borderRadius: 8, background: 'var(--bg-subtle, #f6f7f9)' }}>
                绑定 {code}
              </code>
              <p className="card-sub">10 分钟内有效，只能用一次。</p>
            </div>
          ) : (
            <button className="btn btn-primary" disabled={pending} onClick={issue}>
              {pending ? '生成中…' : '获取绑定码'}
            </button>
          )}
        </>
      )}
      {msg && <p style={{ color: 'var(--red, #e5484d)' }}>{msg}</p>}
    </div>
  );
}
