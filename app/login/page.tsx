import { redirect } from 'next/navigation';
import Image from 'next/image';
import { getSessionOrNull } from '@/lib/session';
import { peekInvite } from '@/lib/auth';
import { ROLE_LABEL, type Role } from '@/lib/rbac';
import { getWechatConfig } from '@/lib/wechat-auth';
import { LoginForm } from './LoginForm';
import { GuestButton } from './GuestButton';
import { PromoCarousel } from './PromoCarousel';
import { ExtUnlink } from './ExtUnlink';

export const dynamic = 'force-dynamic';

// bye=tenant|member：刚刚完成账号注销后的回跳（app/(app)/settings/account-actions.ts）
type InviteQuery = { invite?: string; wx_error?: string; bye?: string };
type LoginPageParams = Promise<InviteQuery>;
type LoginPageProps = {
  searchParams: LoginPageParams;
};

export default async function LoginPage(props: LoginPageProps) {
  const session = await getSessionOrNull();
  if (session) redirect('/');

  const searchParams = await props.searchParams;
  const token = searchParams.invite;
  const wxError = searchParams.wx_error;
  const bye = searchParams.bye === 'tenant' || searchParams.bye === 'member' ? searchParams.bye : null;
  const preview = token ? await peekInvite(token) : null;
  const inviteInvalid = Boolean(token && !preview);
  const wechatEnabled = getWechatConfig().enabled;

  let invite = null;
  if (preview && token) {
    const roleKey: Role = preview.role as Role;
    const roleLabel = ROLE_LABEL[roleKey] ?? preview.role;
    invite = {
      token,
      tenantName: preview.tenantName,
      roleLabel,
      targeted: Boolean(preview.phone),
    };
  }

  return (
    <div className="login-page-root">
      <div className="login-split-container">
        <PromoCarousel />

        <div className="login-right-panel">
          <div className="login-form-box">
            <div style={{ marginBottom: 28 }}>
              <Image src="/logo.png" alt="烽火台" width={48} height={48} style={{ borderRadius: 10, marginBottom: 12 }} />
              <h2 style={{ fontSize: 26, fontWeight: 800, color: '#0f172a', marginBottom: 8 }}>
                账号登录 / 注册
              </h2>
              <p style={{ fontSize: 14, color: '#475569' }}>
                {invite ? '手机验证码登录即加入受邀工作区' : '验证码登录，未注册手机号将自动创建账号'}
              </p>
            </div>

            {/* 注销的落地页 = 通知插件解绑的唯一稳妥时机，见 ExtUnlink.tsx 文件头 */}
            {bye ? <ExtUnlink scope={bye} /> : null}

            {bye ? (
              <div
                className="small"
                style={{
                  background: '#f1f5f9',
                  color: '#334155',
                  padding: '10px 14px',
                  borderRadius: 8,
                  marginBottom: 20,
                  fontSize: 13,
                  border: '1px solid rgba(100, 116, 139, 0.2)',
                  lineHeight: 1.7,
                }}
              >
                {bye === 'tenant'
                  ? '账号已注销，工作区数据已全部删除。浏览器插件（若已安装）会同步停止采集并清空本机缓存。感谢你曾经使用烽火台 —— 随时可以用手机号重新注册。'
                  : '账号已注销，你已退出该工作区。团队的内容数据仍归工作区所有，未随你的账号删除；本机插件的采集令牌与缓存已清除。'}
              </div>
            ) : null}

            {invite ? (
              <div
                className="small"
                style={{
                  background: '#fff7ed',
                  color: '#ea580c',
                  padding: '10px 14px',
                  borderRadius: 8,
                  marginBottom: 20,
                  fontSize: 13,
                  border: '1px solid rgba(234, 88, 12, 0.2)',
                }}
              >
                你被邀请加入 <b>{invite.tenantName}</b>，角色为 <b>{invite.roleLabel}</b>。
                {invite.targeted ? ' 该邀请仅限指定手机号接受。' : ''}
              </div>
            ) : null}

            {inviteInvalid ? (
              <div
                className="small"
                style={{
                  background: '#fef3c7',
                  color: '#b45309',
                  padding: '10px 14px',
                  borderRadius: 8,
                  marginBottom: 20,
                  fontSize: 13,
                  border: '1px solid rgba(245, 158, 11, 0.2)',
                }}
              >
                邀请链接无效、已被使用或已过期。你仍可用手机号直接登录，或向邀请人索取新链接。
              </div>
            ) : null}

            {!invite && !inviteInvalid ? (
              <div
                style={{
                  background: '#fff7ed',
                  border: '1px solid rgba(234, 88, 12, 0.2)',
                  borderRadius: 8,
                  padding: '10px 14px',
                  fontSize: 12,
                  color: '#c2410c',
                  marginBottom: 24,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontWeight: 500,
                }}
              >
                <span>🎁</span>
                <span>新用户注册即送 30 天标准版 (每天 200 次 AI 额度)</span>
              </div>
            ) : null}

            <LoginForm invite={invite} wechatEnabled={wechatEnabled} wxError={wxError} />
            {!invite && <GuestButton />}
          </div>
        </div>
      </div>

      <footer className="login-footer">
        <div className="login-footer-line">
          <span>Copyright © 2013 - 2026 Yunci All Rights Reserved. 云磁数字 版权所有</span>
        </div>
        <div className="login-footer-line">
          <span>ICP备案/许可证号：闽ICP备2020021857号-1</span>
          <span style={{ color: '#cbd5e1' }}>|</span>
          <span>闽公网安备：35010402351451号</span>
          <span style={{ color: '#cbd5e1' }}>|</span>
          <span>增值电信业务经营许可证: 闽B2-20230811</span>
          <span style={{ color: '#cbd5e1' }}>|</span>
          <span>广播电视节目制作经营许可证:（闽）字第00654号</span>
        </div>
      </footer>
    </div>
  );
}
