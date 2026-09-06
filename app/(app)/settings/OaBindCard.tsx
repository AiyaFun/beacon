'use client';

import { useState, useTransition } from 'react';
import { useI18n } from '@/lib/i18n';
import { actIssueOaBindCode } from './account-actions';

// 绑定企业应用账号。企业版专属——SaaS 上这张卡不渲染（页面侧用 can('oaLogin') 判）。
export function OaBindCard({ providerName, bound }: { providerName: string | null; bound: boolean }) {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState('');
  const [pending, start] = useTransition();

  function issue() {
    setMsg('');
    start(async () => {
      const r = await actIssueOaBindCode();
      if (r.ok && r.code) setCode(r.code);
      else setMsg(r.message ?? (isEn ? 'Failed to get binding code' : '获取失败'));
    });
  }

  const appName = providerName ?? (isEn ? 'Enterprise App' : '企业应用');

  return (
    <div className="card">
      <div className="card-title">{isEn ? `Bind ${appName} Account` : `绑定${appName}账号`}</div>
      <p className="card-sub">
        {bound
          ? (isEn ? 'Bound. Send "Login" to the bot in direct message to receive a login link.' : '已绑定。以后私聊机器人发「登录」就能拿到登录链接。')
          : (isEn ? 'After binding, you can send "Login" to the bot to self-service log in. If not bound, you cannot log back in after this session expires.' : '绑定之后就能私聊机器人发「登录」自助进来 —— 不绑的话，这次会话过期后你自己也登不回来。')}
      </p>

      {!bound && (
        <>
          {code ? (
            <div className="field">
              <div className="field-label">{isEn ? `In ${appName}, send this in direct message to the bot:` : `在${appName}里私聊机器人，发送这条：`}</div>
              <code style={{ display: 'block', padding: 10, borderRadius: 8, background: 'var(--bg-subtle, #f6f7f9)' }}>
                {isEn ? `bind ${code}` : `绑定 ${code}`}
              </code>
              <p className="card-sub">{isEn ? 'Valid for 10 minutes, single use.' : '10 分钟内有效，只能用一次。'}</p>
            </div>
          ) : (
            <button className="btn btn-primary" disabled={pending} onClick={issue}>
              {pending ? (isEn ? 'Generating…' : '生成中…') : (isEn ? 'Get Binding Code' : '获取绑定码')}
            </button>
          )}
        </>
      )}
      {msg && <p style={{ color: 'var(--red, #e5484d)' }}>{msg}</p>}
    </div>
  );
}
