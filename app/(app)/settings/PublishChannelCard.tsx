'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { WEIBO_MAX_CHARS } from '@/lib/publish/capability';
import { actSavePublishCredential, actDeletePublishCredential, actTestPublishCredential } from './actions';

export type CredView = {
  platform: string;
  appId: string;
  status: string;
  lastError: string | null;
  linkUrl?: string | null;
  externalUid?: string | null;
  tokenExpiresAt?: string | null;
} | null;

const STATUS_TEXT: Record<string, { zh: string; en: string }> = {
  ok: { zh: '凭证有效', en: 'Valid' },
  failed: { zh: '凭证无效', en: 'Invalid' },
  untested: { zh: '未测试', en: 'Untested' },
};

// 发布通道：**能填凭证的只有走官方接口的平台**（公众号、微博）。
export function PublishChannelCard({
  wechat,
  weibo,
  readOnly,
}: {
  wechat: CredView;
  weibo: CredView;
  readOnly: boolean;
}) {
  const { lang } = useI18n();
  const isEn = lang === 'en';

  return (
    <Card
      title={isEn ? 'Publishing Channels · Official APIs' : '发布通道 · 官方接口'}
      sub={isEn ? 'Once configured, "One-Click Publish" to these two platforms can be performed directly by the server; other platforms use the extension or manual posting.' : '填了之后，「一键发布」这两个平台可以由服务端直接发；其余平台走插件半自动或手动'}
      style={{ marginBottom: 16 }}
    >
      <ChannelRow
        platform="wechat"
        title={isEn ? 'WeChat Official Account' : '微信公众号'}
        note={isEn ? 'Drafts are saved to the draft box (editable and revokable); broadcast options can be checked at publish time.' : '写进的是草稿箱，可撤可改；是否群发由你在发布时另外勾选。'}
        idLabel={isEn ? 'AppID (Official Account Admin · Basic Config)' : 'AppID（公众号后台 · 基本配置）'}
        secretLabel="AppSecret"
        cred={wechat}
        readOnly={readOnly}
        footer={
          isEn ? (
            <>Official Account API requires an <strong>IP Whitelist</strong>: add this server's outbound IP in the admin backend under "Settings & Dev → Basic Config → IP Whitelist", otherwise calls will be rejected (error 40164).</>
          ) : (
            <>
              公众号接口有 <strong>IP 白名单</strong>：要在公众号后台「设置与开发 → 基本配置 → IP 白名单」里
              加上本服务器的出口 IP，否则调用会被拒（错误码 40164）。
            </>
          )
        }
      />

      <div className="divider" style={{ margin: '16px 0' }} />

      <ChannelRow
        platform="weibo"
        title={isEn ? 'Weibo' : '微博'}
        note={isEn ? `Posts are published directly as public weibo (no draft box). Weibo's 3 strict rules: text ≤${WEIBO_MAX_CHARS} chars, single image, and text must include a link under your "Safe Domain".` : `发出去就是公开博文，没有草稿箱这一档。微博的三条硬规则：正文 ≤${WEIBO_MAX_CHARS} 字、单张配图、正文里必须带一条你「安全域名」下的链接。`}
        idLabel={isEn ? 'AppKey (Weibo Open Platform · My Apps)' : 'AppKey（微博开放平台 · 我的应用）'}
        secretLabel="AppSecret"
        cred={weibo}
        readOnly={readOnly}
        needsOauth
        footer={
          isEn ? (
            <>Create an application on the <strong>Weibo Open Platform</strong>: set "Safe Domain" to your domain, set "Authorization Callback URL" to <code className="mono"> Site URL/api/auth/weibo/callback </code>. After entering AppKey/AppSecret, click "Authorize Weibo". Personal app tokens <strong>do not auto-renew</strong>; re-authorize when expired.</>
          ) : (
            <>
              到 <strong>微博开放平台</strong> 建一个应用：把「安全域名」设成你自己的域名，「授权回调页」填
              <code className="mono"> 本站地址/api/auth/weibo/callback </code>。填完 AppKey/AppSecret 后点「授权微博」走一次授权。
              微博个人应用的 token <strong>不会自动续期</strong>，过期后回来再点一次授权即可。
            </>
          )
        }
      />
    </Card>
  );
}

function ChannelRow({
  platform,
  title,
  note,
  idLabel,
  secretLabel,
  cred,
  readOnly,
  needsOauth,
  footer,
}: {
  platform: string;
  title: string;
  note: string;
  idLabel: string;
  secretLabel: string;
  cred: CredView;
  readOnly: boolean;
  needsOauth?: boolean;
  footer: React.ReactNode;
}) {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const router = useRouter();
  const [pending, start] = useTransition();
  const [appId, setAppId] = useState(cred?.appId ?? '');
  const [secret, setSecret] = useState('');
  const [linkUrl, setLinkUrl] = useState(cred?.linkUrl ?? '');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  function run(fn: () => Promise<{ ok: boolean; error?: string; detail?: string }>, okMsg: string) {
    setErr('');
    setMsg('');
    start(async () => {
      const r = await fn();
      if (!r.ok) {
        setErr(r.error ?? (isEn ? 'Operation failed' : '操作失败'));
        return;
      }
      setMsg(r.detail ?? okMsg);
      setSecret('');
      router.refresh();
    });
  }

  const authorized = needsOauth ? !!cred?.externalUid || !!cred?.tokenExpiresAt : true;

  return (
    <div>
      <div className="row-between wrap" style={{ gap: 8, marginBottom: 8 }}>
        <strong>{title}</strong>
        {cred && (
          <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span className="badge badge-gray">{platform === 'weibo' ? 'AppKey' : 'AppID'} {cred.appId}</span>
            <span
              className={`badge ${cred.status === 'ok' ? 'badge-green' : cred.status === 'failed' ? 'badge-red' : 'badge-amber'}`}
            >
              {STATUS_TEXT[cred.status] ? (isEn ? STATUS_TEXT[cred.status].en : STATUS_TEXT[cred.status].zh) : cred.status}
            </span>
            {needsOauth && (
              <span className={`badge ${authorized ? 'badge-green' : 'badge-amber'}`}>
                {authorized ? (isEn ? 'Authorized' : '已授权') : (isEn ? 'Unauthorized' : '未授权')}
              </span>
            )}
          </span>
        )}
      </div>
      <p className="small muted" style={{ marginTop: 0, lineHeight: 1.7 }}>{note}</p>
      {cred?.lastError && (
        <div className="small" style={{ color: 'var(--red)', marginBottom: 8 }}>{cred.lastError}</div>
      )}

      {!readOnly && (
        <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
          <input
            className="input"
            placeholder={idLabel}
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            style={{ maxWidth: 240 }}
          />
          <input
            className="input"
            type="password"
            placeholder={cred ? (isEn ? `${secretLabel} (overwrites)` : `${secretLabel}（重填即覆盖）`) : secretLabel}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            style={{ maxWidth: 240 }}
          />
          {platform === 'weibo' && (
            <input
              className="input"
              placeholder={isEn ? 'Callback link URL (under safe domain)' : '回链地址（必须在安全域名下）'}
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              style={{ maxWidth: 260 }}
            />
          )}
          <button
            className="btn btn-sm btn-primary"
            disabled={pending || !appId.trim() || !secret.trim()}
            onClick={() =>
              run(
                () => actSavePublishCredential({ platform, appId, appSecret: secret, linkUrl }),
                isEn ? 'Saved' : '已保存',
              )
            }
          >
            {isEn ? 'Save' : '保存'}
          </button>
          {cred && needsOauth && (
            // 授权是整页跳转（要去微博的授权页），不能走 server action
            <a className="btn btn-sm" href="/api/auth/weibo/redirect">
              {authorized ? (isEn ? 'Re-authorize' : '重新授权') : (isEn ? 'Authorize Weibo' : '授权微博')}
            </a>
          )}
          {cred && (
            <>
              <button
                className="btn btn-sm"
                disabled={pending}
                onClick={() => run(() => actTestPublishCredential(platform), isEn ? 'Check completed' : '检查完成')}
              >
                {platform === 'weibo' ? (isEn ? 'Check Auth' : '查授权状态') : (isEn ? 'Test Connection' : '测试连通')}
              </button>
              <button
                className="btn btn-sm btn-ghost"
                disabled={pending}
                onClick={() => run(() => actDeletePublishCredential(platform), isEn ? 'Deleted' : '已删除')}
              >
                {isEn ? 'Delete' : '删除'}
              </button>
            </>
          )}
        </div>
      )}

      <p className="small muted" style={{ marginTop: 10, lineHeight: 1.7 }}>
        {footer} {isEn ? 'AppSecret and authorization tokens are encrypted and never shown on screen; delete them when no longer needed.' : 'AppSecret 与授权 token 都加密存储、界面不回显；不用了请及时删除。'}
      </p>

      {(msg || err) && (
        <div className="small" style={{ marginTop: 8, color: err ? 'var(--red)' : 'var(--green)' }}>{err || msg}</div>
      )}
    </div>
  );
}
