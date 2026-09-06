import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { fmtDate } from '@/lib/format';
import { can, ROLE_LABEL, ROLE_DESC, ROLES, assignableRoles, type Role } from '@/lib/rbac';
import { Card, Stat, Empty } from '@/components/ui';
import { Icon } from '@/components/icons';
import { InviteForm } from './InviteForm';
import { InviteRow } from './InviteRow';
import { MemberRow } from './MemberRow';
import { maskPhone } from './util';
import { edition } from '@/lib/edition';
import { HubHeader } from '@/components/HubHeader';
import { getServerLang } from '@/lib/i18n/server';
import { getDictionary } from '@/lib/i18n/dict';

export const dynamic = 'force-dynamic';

const ROLE_BADGE: Record<Role, string> = {
  owner: 'badge-brand',
  admin: 'badge-green',
  editor: 'badge-gray',
  viewer: 'badge-gray',
};

const ROLE_LABEL_EN: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  editor: 'Editor',
  viewer: 'Viewer',
};

const ROLE_DESC_EN: Record<Role, string> = {
  owner: 'Full permissions including workspace deletion, ownership transfer, billing management',
  admin: 'Manage members & model configurations + all content actions; cannot modify owner',
  editor: 'Full content pipeline (topics/drafts/compliance/publishing); no member/model access',
  viewer: 'Read-only; can view all content without edit permissions',
};

export default async function MembersPage() {
  const s = await getSession();
  const lang = await getServerLang();
  const isEn = lang === 'en';
  const dict = getDictionary(lang);

  if (!can(s.role, 'member.view')) {
    return (
      <>
        <HubHeader
          title={isEn ? 'Members & Permissions' : '成员与权限'}
          hint={isEn ? 'Team collaboration and role management' : '团队协作与角色管理'}
        />
        <Card>
          <Empty
            icon="🔒"
            text={
              isEn
                ? `Member management is only accessible to Owners and Admins. Your current role is "${ROLE_LABEL_EN[s.role as Role] ?? s.role}". Please contact a workspace admin for access.`
                : `成员管理仅所有者与管理员可见。你当前的角色是「${ROLE_LABEL[s.role as Role] ?? s.role}」，如需权限请联系工作区管理员。`
            }
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
  // 本机一次性登录链接：企业版才有。SaaS 有短信/微信登录，
  // 多一条「拿到链接就能进」的通道只是多一个可被钓鱼的入口（落地路由也各判一次）
  const canIssueLoginLink = edition() !== 'saas';
  return (
    <>
      <HubHeader
        title={dict.settings.membersTitle}
        hint={isEn ? 'Invite team members and manage role-based access · Owner cannot be removed or demoted' : '邀请协作者并按角色分权 · 所有者不可被移除或降级，权限变更即刻生效'}
        action={
          <span className="badge badge-brand">
            <Icon.users size={13} /> {isEn ? 'My Role: ' : '我的角色：'}
            {isEn ? (ROLE_LABEL_EN[s.role as Role] ?? s.role) : (ROLE_LABEL[s.role as Role] ?? s.role)}
          </span>
        }
      />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label={isEn ? 'Total Members' : '成员总数'} value={members.length} foot={isEn ? 'Includes deactivated' : '含已停用'} />
        <Stat label={isEn ? 'Active Members' : '活跃成员'} value={activeCount} foot={isEn ? 'Able to log in' : '可正常登录'} />
        <Stat label={isEn ? 'Pending Invites' : '待处理邀请'} value={invites.length} foot={isEn ? 'Valid for 7 days' : '7 天有效期'} />
        <Stat label={isEn ? 'Billed Seats' : '计费席位'} value={activeCount} foot={isEn ? 'Deactivated excluded' : '停用不占席位'} />
      </div>

      <Card title={isEn ? 'Member List' : '成员列表'} sub={isEn ? 'Phone numbers are masked for privacy' : '手机号已脱敏展示'} style={{ marginBottom: 16 }}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{isEn ? 'Name' : '姓名'}</th>
                <th>{isEn ? 'Phone' : '手机号'}</th>
                <th>{isEn ? 'Role' : '角色'}</th>
                <th>{isEn ? 'Status' : '状态'}</th>
                <th>{isEn ? 'Joined At' : '加入时间'}</th>
                <th style={{ width: 300 }}>{isEn ? 'Actions' : '操作'}</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const isSelf = m.id === s.memberId;
                const isOwner = m.role === 'owner';
                const roleText = isEn ? (ROLE_LABEL_EN[m.role as Role] ?? m.role) : (ROLE_LABEL[m.role as Role] ?? m.role);
                return (
                  <tr key={m.id}>
                    <td>
                      <b>{m.name}</b>
                      {isSelf && <span className="badge badge-gray" style={{ marginLeft: 6 }}>{isEn ? 'Me' : '我'}</span>}
                    </td>
                    <td className="mono small">{maskPhone(m.phone)}</td>
                    <td>
                      <span className={`badge ${ROLE_BADGE[m.role as Role] ?? 'badge-gray'}`}>
                        {roleText}
                      </span>
                    </td>
                    <td>
                      <span className="row" style={{ gap: 5, alignItems: 'center' }}>
                        <span className={`dot ${m.status === 'active' ? 'dot-green' : 'dot-amber'}`} />
                        <span className="small muted">{m.status === 'active' ? (isEn ? 'Active' : '活跃') : (isEn ? 'Deactivated' : '已停用')}</span>
                      </span>
                    </td>
                    <td className="small muted">{fmtDate(m.createdAt)}</td>
                    <td>
                      {canManage ? (
                        <MemberRow
                          canIssueLoginLink={canIssueLoginLink}
                          roles={roles}
                          id={m.id}
                          name={m.name}
                          role={m.role}
                          status={m.status}
                          locked={isOwner || isSelf}
                          lockReason={isOwner ? (isEn ? 'Owner cannot be modified' : '所有者不可变更') : isSelf ? (isEn ? 'Cannot modify self' : '不能操作自己') : undefined}
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
        <Card title={isEn ? 'Invite Member' : '邀请成员'} sub={isEn ? 'Generate link · Valid for 7 days' : '生成链接 · 7 天有效'}>
          <InviteForm roles={roles} />
        </Card>

        <Card title={isEn ? 'Pending Invites' : '待处理邀请'} sub={isEn ? 'Unaccepted invites can be revoked anytime' : '未接受的邀请可随时撤销'}>
          {invites.length === 0 ? (
            <Empty icon="✉️" text={isEn ? 'No pending invites' : '没有待处理的邀请'} />
          ) : (
            <div className="stack" style={{ gap: 10 }}>
              {invites.map((inv) => (
                <div key={inv.id} className="card" style={{ padding: 12, boxShadow: 'none', background: 'var(--surface-2)' }}>
                  <div className="row wrap" style={{ gap: 8, alignItems: 'center', marginBottom: 8 }}>
                    <b className="small mono">{inv.phone ? maskPhone(inv.phone) : (isEn ? 'Anyone with link' : '任何人凭链接')}</b>
                    <span className="badge badge-gray">{isEn ? (ROLE_LABEL_EN[inv.role as Role] ?? inv.role) : (ROLE_LABEL[inv.role as Role] ?? inv.role)}</span>
                    {!inv.phone && <span className="badge badge-amber">{isEn ? 'Open Link' : '开放链接'}</span>}
                  </div>
                  <div className="wrap small muted" style={{ gap: 12, marginBottom: 8 }}>
                    <span>{isEn ? `Invited by ${inviterName.get(inv.invitedBy) ?? 'Departed member'}` : `邀请人 ${inviterName.get(inv.invitedBy) ?? '已离开的成员'}`}</span>
                    <span>{isEn ? `Expires ${fmtDate(inv.expiresAt)}` : `到期 ${fmtDate(inv.expiresAt)}`}</span>
                  </div>
                  <InviteRow id={inv.id} token={inv.token} />
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card title={isEn ? 'Role & Permission Guide' : '角色权限说明'} sub={isEn ? 'Action-level authorization' : '动作粒度授权'}>
        <div className="stack" style={{ gap: 8 }}>
          {ROLES.map((r) => (
            <div key={r} className="row-between wrap" style={{ gap: 8, padding: '8px 0', borderTop: '1px solid var(--surface-2)' }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                  <b className="small">{isEn ? ROLE_LABEL_EN[r] : ROLE_LABEL[r]}</b>
                  {r === 'owner' && <span className="badge badge-amber">{isEn ? 'Cannot be granted via invite' : '不可邀请授予'}</span>}
                </div>
                <div className="small muted" style={{ marginTop: 3 }}>{isEn ? ROLE_DESC_EN[r] : ROLE_DESC[r]}</div>
              </div>
            </div>
          ))}
          <div className="alert-gradient-amber" style={{ padding: '12px 16px', marginTop: 12 }}>
            <div className="row" style={{ gap: 10, alignItems: 'center' }}>
              <span className="row" style={{ color: 'var(--amber)', flexShrink: 0 }}>
                <Icon.shield size={16} />
              </span>
              <span className="small" style={{ opacity: 0.9 }}>
                {isEn
                  ? 'A phone number can only belong to one workspace. If already registered elsewhere, the user must leave their current workspace or use a different phone number.'
                  : '一个手机号只能属于一个工作区。已在别处的手机号无法被邀请，需对方先离开原工作区或换号。'}
              </span>
            </div>
          </div>
        </div>
      </Card>
    </>
  );
}
