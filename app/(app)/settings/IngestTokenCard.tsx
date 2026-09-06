'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import {
  actIssueIngestToken,
  actRevokeIngestToken,
  actRevokeLegacyIngestToken,
  actDisableIngestToken,
} from './actions';
import { relTime, fmtDate } from '@/lib/format';

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
  const { lang } = useI18n();
  const isEn = lang === 'en';
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
    flash(isEn ? 'Copied, paste into "Ingestion Token" in extension settings' : '已复制，粘进插件设置页的「采集令牌」即可');
  }

  function issue(force: boolean) {
    start(async () => {
      const r = await actIssueIngestToken(force);
      setJustIssued(r.token);
      setShown((s) => ({ ...s, [r.id]: true }));
      flash(
        r.reused
          ? (isEn ? `This device (${r.label}) already has a token, use it directly` : `这台设备（${r.label}）已经有令牌了，直接用它`)
          : (isEn ? `Issued new token for "${r.label}"` : `已为「${r.label}」签发新令牌`),
      );
      router.refresh();
    });
  }

  function revoke(row: TokenRow) {
    if (!window.confirm(isEn ? `After revoking, the extension on "${row.label}" will immediately stop reporting data, stop scheduled tasks, and clear local cache. Continue?` : `吊销后「${row.label}」上的插件立即无法回传，且会自动停止定时采集、清空本机缓存。继续？`)) return;
    start(async () => {
      await actRevokeIngestToken(row.id);
      flash(isEn ? 'Revoked' : '已吊销');
      router.refresh();
    });
  }

  function revokeLegacy() {
    if (!window.confirm(isEn ? 'This is a legacy token shared across all devices. Revoking it will stop data reporting from ALL devices still using it. Continue?' : '这是所有设备共用的旧版令牌，吊销后「每一台」还在用它的插件都会停止回传。继续？')) return;
    start(async () => {
      await actRevokeLegacyIngestToken();
      flash(isEn ? 'Legacy token revoked' : '旧版令牌已吊销');
      router.refresh();
    });
  }

  function disableAll() {
    if (!window.confirm(isEn ? 'Disabling all tokens will prevent extensions on all devices from reporting data (can re-issue anytime). Continue?' : '全部停用后所有设备的插件都无法回传（可随时重新签发）。继续？')) return;
    start(async () => {
      await actDisableIngestToken();
      flash(isEn ? 'All disabled' : '已全部停用');
      router.refresh();
    });
  }

  const empty = active.length === 0 && !legacyToken;

  return (
    <div className="stack" style={{ gap: 10 }}>
      {empty ? (
        <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
          <span className="small muted">{isEn ? 'No devices authorized yet — issue a token and paste into the browser extension to start reporting' : '还没有授权任何设备——签发一枚令牌填进浏览器插件即可开始回传'}</span>
          <button className="btn btn-sm" onClick={() => issue(false)} disabled={pending}>
            {pending ? (isEn ? 'Issuing…' : '签发中…') : (isEn ? 'Issue token for this device' : '为这台设备签发令牌')}
          </button>
        </div>
      ) : (
        <>
          <div className="stack" style={{ gap: 8 }}>
            {legacyToken && (
              <div className="row wrap" style={{ gap: 8, alignItems: 'center', padding: '8px 10px', borderRadius: 8, background: 'var(--surface-2)' }}>
                <span className="badge badge-amber" style={{ flexShrink: 0 }}>{isEn ? 'Legacy' : '旧版'}</span>
                <div className="stack" style={{ gap: 2, flex: 1, minWidth: 180 }}>
                  <b className="small">{isEn ? 'Workspace Shared Token' : '工作区共用令牌'}</b>
                  <span className="small muted">{isEn ? 'Shared by all devices, cannot be revoked individually. Recommended to issue a separate token for each device then revoke this.' : '所有设备共用一枚，无法单独收回某一台。建议给每台设备各签一枚后吊销它。'}</span>
                </div>
                <code className="small mono" style={{ background: 'var(--surface)', padding: '4px 8px', borderRadius: 6, wordBreak: 'break-all' }}>
                  {shown.__legacy ? legacyToken : mask(legacyToken)}
                </code>
                <button className="btn btn-sm btn-ghost" onClick={() => setShown((s) => ({ ...s, __legacy: !s.__legacy }))} disabled={pending}>
                  {shown.__legacy ? (isEn ? 'Hide' : '隐藏') : (isEn ? 'Show' : '显示')}
                </button>
                <button className="btn btn-sm" onClick={() => copy(legacyToken)} disabled={pending}>{isEn ? 'Copy' : '复制'}</button>
                <button className="btn btn-sm btn-ghost" onClick={revokeLegacy} disabled={pending} style={{ color: 'var(--red)' }}>{isEn ? 'Revoke' : '吊销'}</button>
              </div>
            )}

            {active.map((row) => (
              <div key={row.id} className="row wrap" style={{ gap: 8, alignItems: 'center', padding: '8px 10px', borderRadius: 8, background: 'var(--surface-2)' }}>
                <div className="stack" style={{ gap: 2, flex: 1, minWidth: 180 }}>
                  <b className="small">
                    {row.label}
                    {justIssued === row.token && <span className="badge badge-green" style={{ marginLeft: 6 }}>{isEn ? 'Just Issued' : '刚签发'}</span>}
                  </b>
                  <span className="small muted">
                    {row.memberName ? (isEn ? `Issued by ${row.memberName}` : `${row.memberName} 签发`) : (isEn ? 'Unknown source' : '来源未知')} ·{' '}
                    {row.lastUsedAt ? (isEn ? `Last used ${relTime(row.lastUsedAt)}` : `最后使用 ${relTime(row.lastUsedAt)}`) : (isEn ? 'Never used' : '还没用过')}
                  </span>
                </div>
                <code className="small mono" style={{ background: 'var(--surface)', padding: '4px 8px', borderRadius: 6, wordBreak: 'break-all' }}>
                  {shown[row.id] ? row.token : mask(row.token)}
                </code>
                <button className="btn btn-sm btn-ghost" onClick={() => setShown((s) => ({ ...s, [row.id]: !s[row.id] }))} disabled={pending}>
                  {shown[row.id] ? (isEn ? 'Hide' : '隐藏') : (isEn ? 'Show' : '显示')}
                </button>
                <button className="btn btn-sm" onClick={() => copy(row.token)} disabled={pending}>{isEn ? 'Copy' : '复制'}</button>
                <button className="btn btn-sm btn-ghost" onClick={() => revoke(row)} disabled={pending} style={{ color: 'var(--red)' }}>{isEn ? 'Revoke' : '吊销'}</button>
              </div>
            ))}
          </div>

          <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
            <button className="btn btn-sm" onClick={() => issue(false)} disabled={pending}>
              {pending ? (isEn ? 'Processing…' : '处理中…') : (isEn ? 'Issue token for this device' : '为这台设备签发令牌')}
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => issue(true)} disabled={pending}>{isEn ? 'Issue Another' : '另发一枚'}</button>
            <button className="btn btn-sm btn-ghost" onClick={disableAll} disabled={pending} style={{ color: 'var(--red)' }}>
              {isEn ? 'Disable All' : '全部停用'}
            </button>
          </div>
        </>
      )}

      {revoked.length > 0 && (
        <details>
          <summary className="small muted" style={{ cursor: 'pointer' }}>{isEn ? `Recently revoked (${revoked.length})` : `最近吊销的 ${revoked.length} 枚`}</summary>
          <div className="stack" style={{ gap: 4, marginTop: 6 }}>
            {revoked.map((r) => (
              <span key={r.id} className="small muted">
                {r.label} · {fmtDate(r.revokedAt)} {isEn ? 'revoked' : '吊销'}{r.revokedNote ? ` · ${r.revokedNote}` : ''}
              </span>
            ))}
          </div>
        </details>
      )}

      {msg && <span className="small muted">{msg}</span>}
    </div>
  );
}
