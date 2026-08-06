'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  actIssueIngestToken,
  actRevokeIngestToken,
  actRevokeLegacyIngestToken,
  actDisableIngestToken,
} from './actions';
import { relTime, fmtDate } from '@/lib/format';

// 插件采集令牌 = 「已授权的设备」清单。
//
// 此前这里只有一串令牌加「轮换/停用」两个按钮，因为服务端也只有一枚（Workspace.ingestToken）。
// 那个形状下「吊销」只有全有或全无两档：同事离职、笔记本丢了、只想收回自己那一台，
// 都只能把整个工作区的采集一起掐掉。现在每台设备一枚，这张卡就是逐枚收回的地方。
//
// 令牌默认打码但**可以展开看全文**：用户要把它粘进另一台设备的插件设置页，
// 只给「复制」按钮的话，跨设备场景（在电脑上看着、在另一台机器上手输）就断了。

export type TokenRow = {
  id: string;
  token: string;
  label: string;
  memberName: string | null;
  createdAt: string | Date;
  lastUsedAt: string | Date | null;
  revokedAt: string | Date | null;
  revokedNote: string | null;
};

function mask(t: string) {
  return t.length > 14 ? `${t.slice(0, 10)}…${t.slice(-4)}` : t;
}

export function IngestTokenCard({
  active,
  revoked,
  legacyToken,
}: {
  active: TokenRow[];
  revoked: TokenRow[];
  /** 旧的工作区级令牌。存量用户的插件里装的就是它，迁完之前不能下线 */
  legacyToken: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState('');
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [justIssued, setJustIssued] = useState<string | null>(null);

  function flash(m: string) {
    setMsg(m);
    setTimeout(() => setMsg(''), 4000);
  }

  async function copy(token: string) {
    await navigator.clipboard.writeText(token);
    flash('已复制，粘进插件设置页的「采集令牌」即可');
  }

  function issue(force: boolean) {
    start(async () => {
      const r = await actIssueIngestToken(force);
      setJustIssued(r.token);
      setShown((s) => ({ ...s, [r.id]: true }));
      flash(r.reused ? `这台设备（${r.label}）已经有令牌了，直接用它` : `已为「${r.label}」签发新令牌`);
      router.refresh();
    });
  }

  function revoke(row: TokenRow) {
    if (!window.confirm(`吊销后「${row.label}」上的插件立即无法回传，且会自动停止定时采集、清空本机缓存。继续？`)) return;
    start(async () => {
      await actRevokeIngestToken(row.id);
      flash('已吊销');
      router.refresh();
    });
  }

  function revokeLegacy() {
    if (!window.confirm('这是所有设备共用的旧版令牌，吊销后**每一台**还在用它的插件都会停止回传。继续？')) return;
    start(async () => {
      await actRevokeLegacyIngestToken();
      flash('旧版令牌已吊销');
      router.refresh();
    });
  }

  function disableAll() {
    if (!window.confirm('全部停用后所有设备的插件都无法回传（可随时重新签发）。继续？')) return;
    start(async () => {
      await actDisableIngestToken();
      flash('已全部停用');
      router.refresh();
    });
  }

  const empty = active.length === 0 && !legacyToken;

  return (
    <div className="stack" style={{ gap: 10 }}>
      {empty ? (
        <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
          <span className="small muted">还没有授权任何设备——签发一枚令牌填进浏览器插件即可开始回传</span>
          <button className="btn btn-sm" onClick={() => issue(false)} disabled={pending}>
            {pending ? '签发中…' : '为这台设备签发令牌'}
          </button>
        </div>
      ) : (
        <>
          <div className="stack" style={{ gap: 8 }}>
            {legacyToken && (
              <div className="row wrap" style={{ gap: 8, alignItems: 'center', padding: '8px 10px', borderRadius: 8, background: 'var(--surface-2)' }}>
                <span className="badge badge-amber" style={{ flexShrink: 0 }}>旧版</span>
                <div className="stack" style={{ gap: 2, flex: 1, minWidth: 180 }}>
                  <b className="small">工作区共用令牌</b>
                  <span className="small muted">所有设备共用一枚，无法单独收回某一台。建议给每台设备各签一枚后吊销它。</span>
                </div>
                <code className="small mono" style={{ background: 'var(--surface)', padding: '4px 8px', borderRadius: 6, wordBreak: 'break-all' }}>
                  {shown.__legacy ? legacyToken : mask(legacyToken)}
                </code>
                <button className="btn btn-sm btn-ghost" onClick={() => setShown((s) => ({ ...s, __legacy: !s.__legacy }))} disabled={pending}>
                  {shown.__legacy ? '隐藏' : '显示'}
                </button>
                <button className="btn btn-sm" onClick={() => copy(legacyToken)} disabled={pending}>复制</button>
                <button className="btn btn-sm btn-ghost" onClick={revokeLegacy} disabled={pending} style={{ color: 'var(--red)' }}>吊销</button>
              </div>
            )}

            {active.map((row) => (
              <div key={row.id} className="row wrap" style={{ gap: 8, alignItems: 'center', padding: '8px 10px', borderRadius: 8, background: 'var(--surface-2)' }}>
                <div className="stack" style={{ gap: 2, flex: 1, minWidth: 180 }}>
                  <b className="small">
                    {row.label}
                    {justIssued === row.token && <span className="badge badge-green" style={{ marginLeft: 6 }}>刚签发</span>}
                  </b>
                  <span className="small muted">
                    {row.memberName ? `${row.memberName} 签发` : '来源未知'} ·{' '}
                    {row.lastUsedAt ? `最后使用 ${relTime(row.lastUsedAt)}` : '还没用过'}
                  </span>
                </div>
                <code className="small mono" style={{ background: 'var(--surface)', padding: '4px 8px', borderRadius: 6, wordBreak: 'break-all' }}>
                  {shown[row.id] ? row.token : mask(row.token)}
                </code>
                <button className="btn btn-sm btn-ghost" onClick={() => setShown((s) => ({ ...s, [row.id]: !s[row.id] }))} disabled={pending}>
                  {shown[row.id] ? '隐藏' : '显示'}
                </button>
                <button className="btn btn-sm" onClick={() => copy(row.token)} disabled={pending}>复制</button>
                <button className="btn btn-sm btn-ghost" onClick={() => revoke(row)} disabled={pending} style={{ color: 'var(--red)' }}>吊销</button>
              </div>
            ))}
          </div>

          <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
            <button className="btn btn-sm" onClick={() => issue(false)} disabled={pending}>
              {pending ? '处理中…' : '为这台设备签发令牌'}
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => issue(true)} disabled={pending}>另发一枚</button>
            <button className="btn btn-sm btn-ghost" onClick={disableAll} disabled={pending} style={{ color: 'var(--red)' }}>
              全部停用
            </button>
          </div>
        </>
      )}

      {revoked.length > 0 && (
        <details>
          <summary className="small muted" style={{ cursor: 'pointer' }}>最近吊销的 {revoked.length} 枚</summary>
          <div className="stack" style={{ gap: 4, marginTop: 6 }}>
            {revoked.map((r) => (
              <span key={r.id} className="small muted">
                {r.label} · {fmtDate(r.revokedAt)} 吊销{r.revokedNote ? ` · ${r.revokedNote}` : ''}
              </span>
            ))}
          </div>
        </details>
      )}

      {msg && <span className="small muted">{msg}</span>}
    </div>
  );
}
