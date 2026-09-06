'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Overlay } from '@/components/Overlay';
import { useI18n } from '@/lib/i18n';
import { actSetTenantPlan, actSuspendTenant, actResumeTenant, actSetPlatformAdmin } from './actions';
import { ASSIGNABLE_PLANS } from './plans';

type TenantView = {
  id: string;
  name: string;
  plan: string;
  effectivePlan: string;
  expired: boolean;
  planExpiresAt: string; // yyyy-mm-dd，空 = 永不过期
  createdAt: string;
  status: string;
  suspendReason: string;
  isDemo: boolean;
};

type MemberView = {
  id: string;
  name: string;
  contact: string;
  role: string;
  status: string;
  platformAdmin: boolean;
};

const PLAN_LABEL: Record<string, string> = {
  free: '免费',
  trial: '试用',
  personal: '标准版',
  byok: '自带 Key 版',
  enterprise: '企业版',
};

const PLAN_LABEL_EN: Record<string, string> = {
  free: 'Free',
  trial: 'Trial',
  personal: 'Standard',
  byok: 'BYOK',
  enterprise: 'Enterprise',
};

// 一个租户一张卡：左边身份与档位，右边动作。封禁弹层走 Overlay——
// 卡片上有 hover transform，就地渲染 fixed 遮罩会被关进卡片里（这个坑踩过两次，见项目备忘）。
export function TenantRow({
  tenant,
  members,
  selfMemberId,
}: {
  tenant: TenantView;
  members: MemberView[];
  selfMemberId: string;
}) {
  const { lang } = useI18n();
  const isEn = lang === 'en';
  const planLabels = isEn ? PLAN_LABEL_EN : PLAN_LABEL;

  const router = useRouter();
  const [pending, start] = useTransition();
  const [plan, setPlan] = useState(tenant.plan);
  const [expires, setExpires] = useState(tenant.planExpiresAt);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [expanded, setExpanded] = useState(false);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) {
    setErr('');
    setMsg('');
    start(async () => {
      const r = await fn();
      if (!r.ok) {
        setErr(r.error ?? (isEn ? 'Operation failed' : '操作失败'));
        return;
      }
      setMsg(okMsg);
      router.refresh();
    });
  }

  const suspended = tenant.status !== 'active';

  return (
    <div className="card" style={{ padding: 16 }}>
      <div className="row-between" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ minWidth: 240 }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <strong>{tenant.name}</strong>
            {tenant.isDemo && <span className="badge badge-gray">{isEn ? 'Demo Tenant' : '演示租户'}</span>}
            {suspended && <span className="badge badge-red">{isEn ? 'Suspended' : '已封禁'}</span>}
            <span className={`badge ${tenant.effectivePlan === 'free' ? 'badge-gray' : 'badge-green'}`}>
              {planLabels[tenant.effectivePlan] ?? tenant.effectivePlan}
            </span>
            {tenant.expired && <span className="badge badge-amber">{isEn ? 'Expired (treated as Free)' : '已过期（按免费档算）'}</span>}
          </div>
          <div className="small muted" style={{ marginTop: 4 }}>
            {isEn
              ? `${tenant.id} · Registered on ${tenant.createdAt} · ${members.length} member(s)`
              : `${tenant.id} · 注册于 ${tenant.createdAt} · ${members.length} 名成员`}
          </div>
          {suspended && tenant.suspendReason && (
            <div className="small" style={{ marginTop: 4, color: 'var(--amber)' }}>
              {isEn ? 'Suspension reason: ' : '封禁原因：'}{tenant.suspendReason}
            </div>
          )}
        </div>

        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <select className="select" value={plan} disabled={pending} onChange={(e) => setPlan(e.target.value)} style={{ fontSize: 12.5 }}>
            {ASSIGNABLE_PLANS.map((p) => (
              <option key={p} value={p}>{planLabels[p] ?? p}</option>
            ))}
          </select>
          <input
            className="input"
            type="date"
            value={expires}
            disabled={pending || plan === 'free'}
            onChange={(e) => setExpires(e.target.value)}
            style={{ maxWidth: 150, fontSize: 12.5 }}
            title={isEn ? 'Leave empty for lifetime' : '留空 = 永不过期'}
          />
          <button
            className="btn btn-sm btn-primary"
            disabled={pending}
            onClick={() => run(() => actSetTenantPlan(tenant.id, plan, expires || null), isEn ? 'Plan updated' : '档位已更新')}
          >
            {isEn ? 'Save Plan' : '保存档位'}
          </button>
          {suspended ? (
            <button className="btn btn-sm" disabled={pending} onClick={() => run(() => actResumeTenant(tenant.id), isEn ? 'Resumed' : '已解封')}>
              {isEn ? 'Resume' : '解封'}
            </button>
          ) : (
            <button className="btn btn-sm" disabled={pending || tenant.isDemo} onClick={() => setSuspendOpen(true)}>
              {isEn ? 'Suspend' : '封禁'}
            </button>
          )}
          <button className="btn btn-sm btn-ghost" onClick={() => setExpanded((v) => !v)}>
            {expanded ? (isEn ? 'Hide Members' : '收起成员') : (isEn ? 'Members' : '成员')}
          </button>
        </div>
      </div>

      {(msg || err) && (
        <div className="small" style={{ marginTop: 8, color: err ? 'var(--red)' : 'var(--green)' }}>{err || msg}</div>
      )}

      {expanded && (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="table">
            <thead>
              <tr>
                <th>{isEn ? 'Name' : '姓名'}</th>
                <th>{isEn ? 'Contact' : '联系方式'}</th>
                <th>{isEn ? 'Role' : '租户内角色'}</th>
                <th>{isEn ? 'Status' : '状态'}</th>
                <th>{isEn ? 'Platform Admin' : '平台管理员'}</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td className="muted">{m.contact}</td>
                  <td>{m.role}</td>
                  <td>{m.status === 'active' ? (isEn ? 'Active' : '正常') : (isEn ? 'Disabled' : '已停用')}</td>
                  <td>
                    <button
                      className={`btn btn-sm ${m.platformAdmin ? 'btn-primary' : ''}`}
                      disabled={pending || (m.id === selfMemberId && m.platformAdmin)}
                      title={m.id === selfMemberId && m.platformAdmin ? (isEn ? 'Cannot revoke own permissions' : '不能收回自己的权限') : ''}
                      onClick={() =>
                        run(() => actSetPlatformAdmin(m.id, !m.platformAdmin), m.platformAdmin ? (isEn ? 'Revoked' : '已收回') : (isEn ? 'Granted' : '已授予'))
                      }
                    >
                      {m.platformAdmin ? (isEn ? 'Yes (Click to revoke)' : '是（点击收回）') : (isEn ? 'No (Click to grant)' : '否（点击授予）')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {suspendOpen && (
        <Overlay label={isEn ? 'Suspend Workspace' : '封禁工作区'} onClose={() => setSuspendOpen(false)} closable={!pending}>
          <div className="card" style={{ width: 420, maxWidth: '92vw', padding: 24 }}>
            <h3 style={{ margin: '0 0 8px' }}>{isEn ? `Suspend "${tenant.name}"` : `封禁「${tenant.name}」`}</h3>
            <p className="small muted" style={{ marginTop: 0 }}>
              {isEn
                ? 'Once suspended, all members cannot log in and active sessions expire immediately. All data is preserved and restored upon resumption.'
                : '封禁后该工作区所有成员立即无法登录，已登录的下一次点击即失效。数据全部保留，解封即恢复。'}
            </p>
            <textarea
              className="textarea"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={isEn ? 'Suspension reason (displayed directly to users in this workspace)' : '封禁原因（会原样展示给该工作区的用户，请写人话）'}
              style={{ width: '100%', marginBottom: 12 }}
            />
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-sm" disabled={pending} onClick={() => setSuspendOpen(false)}>{isEn ? 'Cancel' : '取消'}</button>
              <button
                className="btn btn-sm btn-primary"
                disabled={pending || !reason.trim()}
                onClick={() =>
                  run(async () => {
                    const r = await actSuspendTenant(tenant.id, reason);
                    if (r.ok) setSuspendOpen(false);
                    return r;
                  }, isEn ? 'Suspended' : '已封禁')
                }
              >
                {isEn ? 'Confirm Suspension' : '确认封禁'}
              </button>
            </div>
          </div>
        </Overlay>
      )}
    </div>
  );
}
