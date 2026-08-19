import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { fmtDate } from '@/lib/format';
import { can, ROLE_LABEL, ROLE_DESC, ROLES, assignableRoles, type Role } from '@/lib/rbac';
import { PageHead, Card, Stat, Empty } from '@/components/ui';
import { Icon } from '@/components/icons';
import { InviteForm } from './InviteForm';
import { InviteRow } from './InviteRow';
import { MemberRow } from './MemberRow';
import { maskPhone } from './util';

export const dynamic = 'force-dynamic';

// 成员与权限：成员列表 / 邀请 / 待处理邀请 / 改角色 / 停用移除。
// 页面守卫：viewer / editor 打开只看到无权限提示，不加载任何成员数据。

const ROLE_BADGE: Record<Role, string> = {
  owner: 'badge-brand',
  admin: 'badge-green',
  editor: 'badge-gray',
  viewer: 'badge-gray',
};

export default async function MembersPage() {
  const s = await getSession();

  if (!can(s.role, 'member.view')) {

    return (
      <>
        <PageHead title="成员与权限" desc="团队协作与角色管理" />
        <Card>
          <Empty
            icon="🔒"
            text={`成员管理仅所有者与管理员可见。你当前的角色是「${ROLE_LABEL[s.role as Role] ?? s.role}」，如需权限请联系工作区管理员。`}
          />
        </Card>
      </>
    );
  }

  // 过期清扫：走 [status, expiresAt] 索引，顺手把过期的 pending 落成 expired
  await prisma.invite.updateMany({
    where: { tenantId: s.tenantId, status: 'pending', expiresAt: { lt: new Date() } },
    data: { status: 'expired' },
  });

  const [members, invites] = await Promise.all([
    prisma.member.findMany({ where: { tenantId: s.tenantId }, orderBy: { createdAt: 'asc' } }),
    prisma.invite.findMany({ where: { tenantId: s.tenantId, status: 'pending' }, orderBy: { createdAt: 'desc' } }),
  ]);

  // Invite.invitedBy 是裸 memberId（无 FK relation，见 schema 注释），邀请人姓名批量单查后自拼
  const inviterIds = [...new Set(invites.map((i) => i.invitedBy))];
  const inviters = inviterIds.length
    ? await prisma.member.findMany({ where: { id: { in: inviterIds } }, select: { id: true, name: true } })
    : [];
  const inviterName = new Map(inviters.map((m) => [m.id, m.name]));

  const activeCount = members.filter((m) => m.status === 'active').length;
  const canManage = can(s.role, 'member.role');

  // 可授予角色按形态算：企业版只留管理员/编辑两档（lib/rbac.ts 的 assignableRoles）
  const roles = assignableRoles();
  return (
    <>
      <PageHead
        title="成员与权限"
        desc="邀请协作者并按角色分权 · 所有者不可被移除或降级，权限变更即刻生效"
        action={<span className="badge badge-brand"><Icon.users size={13} /> 我的角色：{ROLE_LABEL[s.role as Role] ?? s.role}</span>}
      />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="成员总数" value={members.length} foot="含已停用" />
        <Stat label="活跃成员" value={activeCount} foot="可正常登录" />
        <Stat label="待处理邀请" value={invites.length} foot="7 天有效期" />
        <Stat label="计费席位" value={activeCount} foot="停用不占席位" />
      </div>

      <Card title="成员列表" sub="手机号已脱敏展示" style={{ marginBottom: 16 }}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>姓名</th>
                <th>手机号</th>
                <th>角色</th>
                <th>状态</th>
                <th>加入时间</th>
                <th style={{ width: 300 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const isSelf = m.id === s.memberId;
                const isOwner = m.role === 'owner';
                return (
                  <tr key={m.id}>
                    <td>
                      <b>{m.name}</b>
                      {isSelf && <span className="badge badge-gray" style={{ marginLeft: 6 }}>我</span>}
                    </td>
                    <td className="mono small">{maskPhone(m.phone)}</td>
                    <td>
                      <span className={`badge ${ROLE_BADGE[m.role as Role] ?? 'badge-gray'}`}>
                        {ROLE_LABEL[m.role as Role] ?? m.role}
                      </span>
                    </td>
                    <td>
                      <span className="row" style={{ gap: 5, alignItems: 'center' }}>
                        <span className={`dot ${m.status === 'active' ? 'dot-green' : 'dot-amber'}`} />
                        <span className="small muted">{m.status === 'active' ? '活跃' : '已停用'}</span>
                      </span>
                    </td>
                    <td className="small muted">{fmtDate(m.createdAt)}</td>
                    <td>
                      {canManage ? (
                        <MemberRow
                          roles={roles}
                          id={m.id}
                          name={m.name}
                          role={m.role}
                          status={m.status}
                          locked={isOwner || isSelf}
                          lockReason={isOwner ? '所有者不可变更' : isSelf ? '不能操作自己' : undefined}
                        />
                      ) : (
                        <span className="small muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <Card title="邀请成员" sub="生成链接 · 7 天有效">
          <InviteForm roles={roles} />
        </Card>

        <Card title="待处理邀请" sub="未接受的邀请可随时撤销">
          {invites.length === 0 ? (
            <Empty icon="✉️" text="没有待处理的邀请" />
          ) : (
            <div className="stack" style={{ gap: 10 }}>
              {invites.map((inv) => (
                <div key={inv.id} className="card" style={{ padding: 12, boxShadow: 'none', background: 'var(--surface-2)' }}>
                  <div className="row wrap" style={{ gap: 8, alignItems: 'center', marginBottom: 8 }}>
                    <b className="small mono">{inv.phone ? maskPhone(inv.phone) : '任何人凭链接'}</b>
                    <span className="badge badge-gray">{ROLE_LABEL[inv.role as Role] ?? inv.role}</span>
                    {!inv.phone && <span className="badge badge-amber">开放链接</span>}
                  </div>
                  <div className="wrap small muted" style={{ gap: 12, marginBottom: 8 }}>
                    <span>邀请人 {inviterName.get(inv.invitedBy) ?? '已离开的成员'}</span>
                    <span>到期 {fmtDate(inv.expiresAt)}</span>
                  </div>
                  <InviteRow id={inv.id} token={inv.token} />
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card title="角色权限说明" sub="动作粒度授权">
        <div className="stack" style={{ gap: 8 }}>
          {ROLES.map((r) => (
            <div key={r} className="row-between wrap" style={{ gap: 8, padding: '8px 0', borderTop: '1px solid var(--surface-2)' }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                  <b className="small">{ROLE_LABEL[r]}</b>
                  {r === 'owner' && <span className="badge badge-amber">不可邀请授予</span>}
                </div>
                <div className="small muted" style={{ marginTop: 3 }}>{ROLE_DESC[r]}</div>
              </div>
            </div>
          ))}
          <div className="alert-gradient-amber" style={{ padding: '12px 16px', marginTop: 12 }}>
            <div className="row" style={{ gap: 10, alignItems: 'center' }}>
              <span className="row" style={{ color: 'var(--amber)', flexShrink: 0 }}>
                <Icon.shield size={16} />
              </span>
              <span className="small" style={{ opacity: 0.9 }}>
                一个手机号只能属于一个工作区。已在别处的手机号无法被邀请，需对方先离开原工作区或换号。
              </span>
            </div>
          </div>
        </div>
      </Card>
    </>
  );
}
