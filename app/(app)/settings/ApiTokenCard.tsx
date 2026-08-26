'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui';
import { actIssueApiToken, actRevokeApiToken } from './api-token-actions';

// 对外调用令牌：让别的程序驱动这台烽火台。
//
// 【这一页要说清楚三件事，否则用户不知道自己在开什么】
//   ① 它能做什么——「让烽火台去做一件事」，与在网页上说一句话是同一条路；
//   ② 它**不能**做什么——确认不了写操作，那一步永远要人在网页上点；
//   ③ 明文只出现一次——丢了就重签，成本很低。
//
// 【为什么明文只给一次】能再看就意味着它随时可读，那么任何一次会话劫持
// 都等于拿到了长期凭证。这与别处「令牌一次性展示」是同一条口径。

export type TokenRow = { id: string; label: string; prefix: string; createdAt: string; lastUsedAt: string | null };

export function ApiTokenCard({ rows, siteUrl }: { rows: TokenRow[]; siteUrl: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [label, setLabel] = useState('');
  const [fresh, setFresh] = useState<{ token: string; label: string } | null>(null);
  const [err, setErr] = useState('');

  function issue() {
    setErr('');
    start(async () => {
      const r = await actIssueApiToken(label);
      if (!r.ok) { setErr(r.error ?? '签发失败'); return; }
      setFresh({ token: r.token!, label: r.label! });
      setLabel('');
      router.refresh();
    });
  }

  const mcpConfig = fresh
    ? JSON.stringify(
        {
          mcpServers: {
            beacon: {
              command: 'npx',
              args: ['tsx', '<烽火台目录>/mcp-server.ts'],
              env: { BEACON_API_URL: siteUrl, BEACON_API_TOKEN: fresh.token },
            },
          },
        },
        null,
        2,
      )
    : '';

  return (
    <Card
      id="api-tokens"
      title="对外调用令牌"
      sub="让脚本、系统定时任务，或 Claude 这类 MCP 客户端直接驱动这台烽火台"
      style={{ marginBottom: 16 }}
    >
      <p className="small muted" style={{ marginTop: 0, lineHeight: 1.85 }}>
        拿着令牌可以让烽火台<b>去做一件事</b>（查选题、看数据、写初稿…），
        与你在网页上说一句话走的是同一条路——<b>权限也按你自己的角色算</b>。
        <br />
        ⚠️ 它<b>确认不了</b>会改数据或花钱的步骤：那一步永远停下来等人在网页上点。
        调用方常常是另一个模型，让一个模型替你签下会花钱的事，这条线不开。
      </p>

      <div className="row wrap" style={{ gap: 8, marginBottom: 12 }}>
        <input
          className="input"
          placeholder="给它起个名字，如「我的 Mac mini」"
          value={label}
          maxLength={40}
          disabled={pending}
          onChange={(e) => setLabel(e.target.value)}
          style={{ minWidth: 240 }}
        />
        <button className="btn btn-sm btn-primary" disabled={pending || !label.trim()} onClick={issue}>
          {pending ? '签发中…' : '签一枚'}
        </button>
        {err && <span className="small" style={{ color: 'var(--red)' }}>{err}</span>}
      </div>

      {/* 明文只在这一刻出现一次 */}
      {fresh && (
        <div className="card" style={{ padding: 12, marginBottom: 12, borderColor: 'var(--amber)' }}>
          <b className="small">「{fresh.label}」的令牌（只显示这一次，关掉就看不到了）</b>
          <input
            className="input"
            readOnly
            value={fresh.token}
            onFocus={(e) => e.currentTarget.select()}
            style={{ width: '100%', margin: '8px 0', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
          />
          <details>
            <summary className="small" style={{ cursor: 'pointer' }}>配进 Claude 这类 MCP 客户端</summary>
            <pre
              className="small"
              style={{ marginTop: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'var(--bg-2)', padding: 10, borderRadius: 6 }}
            >
              {mcpConfig}
            </pre>
            <p className="small muted" style={{ margin: 0 }}>
              把 <code>&lt;烽火台目录&gt;</code> 换成这台机器上烽火台代码所在的路径。
              配好之后，在那个客户端里就能直接说「让烽火台看看我最近数据怎么样」。
            </p>
          </details>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="small muted">还没有签过令牌。</p>
      ) : (
        <div className="stack" style={{ gap: 2 }}>
          {rows.map((r) => (
            <div key={r.id} className="tool-row">
              <span className="run-main">
                <strong style={{ fontSize: 13 }}>{r.label}</strong>
                <span className="small muted">
                  <code>{r.prefix}</code> · 签于 {r.createdAt}
                  {r.lastUsedAt ? ` · 最近用于 ${r.lastUsedAt}` : ' · 还没用过'}
                </span>
              </span>
              <button
                className="btn btn-sm btn-ghost"
                disabled={pending}
                onClick={() => {
                  if (!window.confirm(`收回「${r.label}」？用它的程序会立刻调不动。`)) return;
                  start(async () => {
                    await actRevokeApiToken(r.id);
                    router.refresh();
                  });
                }}
              >
                收回
              </button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
