'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '@/components/ui';
import { actSavePublishCredential, actDeletePublishCredential, actTestPublishCredential } from './actions';

type CredView = { platform: string; appId: string; status: string; lastError: string | null } | null;

const STATUS_TEXT: Record<string, string> = { ok: '凭证有效', failed: '凭证无效', untested: '未测试' };

// 发布通道：公众号官方接口凭证。
// 只有公众号有这一栏，因为**只有它有对个人开放的发布接口**——
// 给别的平台也摆一个输入框，等于承诺了一条不存在的通道。
export function PublishChannelCard({ cred, readOnly }: { cred: CredView; readOnly: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [appId, setAppId] = useState(cred?.appId ?? '');
  const [secret, setSecret] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  function run(fn: () => Promise<{ ok: boolean; error?: string; detail?: string }>, okMsg: string) {
    setErr('');
    setMsg('');
    start(async () => {
      const r = await fn();
      if (!r.ok) {
        setErr(r.error ?? '操作失败');
        return;
      }
      setMsg(r.detail ?? okMsg);
      setSecret('');
      router.refresh();
    });
  }

  return (
    <Card
      title="发布通道 · 微信公众号"
      sub="填了之后，创作工坊的「一键发布」可以直接把图文写进公众号草稿箱"
      style={{ marginBottom: 16 }}
    >
      {cred && (
        <div className="row" style={{ gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          <span className="badge badge-gray">AppID {cred.appId}</span>
          <span className={`badge ${cred.status === 'ok' ? 'badge-green' : cred.status === 'failed' ? 'badge-red' : 'badge-amber'}`}>
            {STATUS_TEXT[cred.status] ?? cred.status}
          </span>
          {cred.lastError && <span className="small" style={{ color: 'var(--red)' }}>{cred.lastError}</span>}
        </div>
      )}

      {!readOnly && (
        <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
          <input
            className="input"
            placeholder="AppID（公众号后台 · 基本配置）"
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            style={{ maxWidth: 240 }}
          />
          <input
            className="input"
            type="password"
            placeholder={cred ? 'AppSecret（重填即覆盖）' : 'AppSecret'}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            style={{ maxWidth: 240 }}
          />
          <button
            className="btn btn-sm btn-primary"
            disabled={pending || !appId.trim() || !secret.trim()}
            onClick={() => run(() => actSavePublishCredential({ platform: 'wechat', appId, appSecret: secret }), '已保存')}
          >
            保存
          </button>
          {cred && (
            <>
              <button className="btn btn-sm" disabled={pending} onClick={() => run(() => actTestPublishCredential('wechat'), '测试完成')}>
                测试连通
              </button>
              <button className="btn btn-sm btn-ghost" disabled={pending} onClick={() => run(() => actDeletePublishCredential('wechat'), '已删除')}>
                删除
              </button>
            </>
          )}
        </div>
      )}

      <p className="small muted" style={{ marginTop: 10 }}>
        公众号接口有 <strong>IP 白名单</strong>：要在公众号后台「设置与开发 → 基本配置 → IP 白名单」里
        加上本服务器的出口 IP，否则调用会被拒（错误码 40164）。
        另外，AppSecret 等同于公众号的钥匙，加密存储、界面不回显；不用了请及时删除。
      </p>
    </Card>
  );
}
