'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Overlay } from '@/components/Overlay';
import { actSetTenantPlan, actSuspendTenant, actResumeTenant, actSetPlatformAdmin, ASSIGNABLE_PLANS } from './actions';

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
        setErr(r.error ?? '操作失败');
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
            {tenant.isDemo && <span className="badge badge-gray">演示租户</span>}
            {suspended && <span className="badge badge-red">已封禁</span>}
            <span className={`badge ${tenant.effectivePlan === 'free' ? 'badge-gray' : 'badge-green'}`}>
              {PLAN_LABEL[tenant.effectivePlan] ?? tenant.effectivePlan}
            </span>
            {tenant.expired && <span className="badge badge-amber">已过期（按免费档算）</span>}
          </div>
          <div className="small muted" style={{ marginTop: 4 }}>
            {tenant.id} · 注册于 {tenant.createdAt} · {members.length} 名成员
          </div>
          {suspended && tenant.suspendReason && (
            <div className="small" style={{ marginTop: 4, color: 'var(--amber)' }}>封禁原因：{tenant.suspendReason}</div>
          )}
        </div>

        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <select className="select" value={plan} disabled={pending} onChange={(e) => setPlan(e.target.value)} style={{ fontSize: 12.5 }}>
            {ASSIGNABLE_PLANS.map((p) => (
              <option key={p} value={p}>{PLAN_LABEL[p] ?? p}</option>
            ))}
          </select>
          <input
            className="input"
            type="date"
            value={expires}
            disabled={pending || plan === 'free'}
            onChange={(e) => setExpires(e.target.value)}
            style={{ maxWidth: 150, fontSize: 12.5 }}
            title="留空 = 永不过期"
          />
          <button
            className="btn btn-sm btn-primary"
            disabled={pending}
            onClick={() => run(() => actSetTenantPlan(tenant.id, plan, expires || null), '档位已更新')}
          >
            保存档位
          </button>
          {suspended ? (
            <button className="btn btn-sm" disabled={pending} onClick={() => run(() => actResumeTenant(tenant.id), '已解封')}>
              解封
            </button>
          ) : (
            <button className="btn btn-sm" disabled={pending || tenant.isDemo} onClick={() => setSuspendOpen(true)}>
              封禁
            </button>
          )}
          <button className="btn btn-sm btn-ghost" onClick={() => setExpanded((v) => !v)}>
            {expanded ? '收起成员' : '成员'}
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
                <th>姓名</th>
                <th>联系方式</th>
                <th>租户内角色</th>
                <th>状态</th>
                <th>平台管理员</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td className="muted">{m.contact}</td>
                  <td>{m.role}</td>
                  <td>{m.status === 'active' ? '正常' : '已停用'}</td>
                  <td>
                    <button
                      className={`btn btn-sm ${m.platformAdmin ? 'btn-primary' : ''}`}
                      disabled={pending || (m.id === selfMemberId && m.platformAdmin)}
                      title={m.id === selfMemberId && m.platformAdmin ? '不能收回自己的权限' : ''}
                      onClick={() =>
                        run(() => actSetPlatformAdmin(m.id, !m.platformAdmin), m.platformAdmin ? '已收回' : '已授予')
                      }
                    >
                      {m.platformAdmin ? '是（点击收回）' : '否（点击授予）'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {suspendOpen && (
        <Overlay label="封禁工作区" onClose={() => setSuspendOpen(false)} closable={!pending}>
          <div className="card" style={{ width: 420, maxWidth: '92vw', padding: 24 }}>
            <h3 style={{ margin: '0 0 8px' }}>封禁「{tenant.name}」</h3>
            <p className="small muted" style={{ marginTop: 0 }}>
              封禁后该工作区所有成员立即无法登录，已登录的下一次点击即失效。数据全部保留，解封即恢复。
            </p>
            <textarea
              className="textarea"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="封禁原因（会原样展示给该工作区的用户，请写人话）"
              style={{ width: '100%', marginBottom: 12 }}
            />
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-sm" disabled={pending} onClick={() => setSuspendOpen(false)}>取消</button>
              <button
                className="btn btn-sm btn-primary"
                disabled={pending || !reason.trim()}
                onClick={() =>
                  run(async () => {
                    const r = await actSuspendTenant(tenant.id, reason);
                    if (r.ok) setSuspendOpen(false);
                    return r;
                  }, '已封禁')
                }
              >
                确认封禁
              </button>
            </div>
          </div>
        </Overlay>
      )}
    </div>
  );
}
