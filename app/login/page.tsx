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
import { needsSetup } from '@/lib/setup/state';
import { OaLoginPanel } from './OaLoginPanel';
import { can, edition } from '@/lib/edition';
import { safeNextPath } from '@/lib/auth/safe-next';
import { normalizeReferralCode, REFERRAL_DAYS } from '@/lib/growth/referral';
import { SLOGAN, SLOGAN_EN } from '@/lib/brand';
import { getServerLang } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';

// bye=tenant|member：刚刚完成账号注销后的回跳（app/(app)/settings/account-actions.ts）
// next/from/ref（2026-09-05）：游客接力回到刚才那一页 / 从演示来的提示 / 邀请码
type InviteQuery = { invite?: string; wx_error?: string; bye?: string; err?: string; next?: string; from?: string; ref?: string };
type LoginPageParams = Promise<InviteQuery>;
type LoginPageProps = {
  searchParams: LoginPageParams;
};

export default async function LoginPage(props: LoginPageProps) {
  const session = await getSessionOrNull();
  if (session) redirect('/');
  // 企业版还没装机时，登录页是死路（没有短信通道、OA 也还没配）——直接送去向导。
  // SaaS 上 needsSetup() 恒为 false。
  if (await needsSetup()) redirect('/setup');

  const searchParams = await props.searchParams;
  const token = searchParams.invite;
  const wxError = searchParams.wx_error;
  const bye = searchParams.bye === 'tenant' || searchParams.bye === 'member' ? searchParams.bye : null;
  const preview = token ? await peekInvite(token) : null;
  const inviteInvalid = Boolean(token && !preview);
  const wechatEnabled = getWechatConfig().enabled;
  // 企业版（appliance/private）：没有短信也没有微信登录，唯一入口是企业应用机器人。
  // SaaS 上 can('oaLogin') 恒为 false，下面整块等于不存在。
  const oaOnly = can('oaLogin');
  const err = typeof searchParams.err === 'string' ? searchParams.err : undefined;
  const next = safeNextPath(searchParams.next);
  const fromDemo = searchParams.from === 'demo';
  const ref = normalizeReferralCode(searchParams.ref);

  const lang = await getServerLang();
  const isEn = lang === 'en';

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
              <Image src="/logo.png" alt={isEn ? 'Beacon' : '烽火台'} width={48} height={48} style={{ borderRadius: 10, marginBottom: 12 }} />
              <h2 style={{ fontSize: 26, fontWeight: 800, color: '#0f172a', marginBottom: 8 }}>
                {isEn ? 'Log in / Sign up' : '账号登录 / 注册'}
              </h2>
              <p style={{ fontSize: 14, color: '#475569' }}>
                {oaOnly
                  ? (isEn ? 'Sign in via enterprise app' : '本版本通过企业应用登录')
                  : invite
                    ? (isEn ? 'Sign in with SMS code to join invited workspace' : '手机验证码登录即加入受邀工作区')
                    : (isEn ? 'SMS verification login; new phones auto-create account' : '验证码登录，未注册手机号将自动创建账号')}
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
                  ? (isEn
                      ? 'Account deleted, workspace data completely removed. Browser extension (if installed) will stop collecting and clear local cache. Thank you for using Beacon — register again anytime.'
                      : '账号已注销，工作区数据已全部删除。浏览器插件（若已安装）会同步停止采集并清空本机缓存。感谢你曾经使用烽火台 —— 随时可以用手机号重新注册。')
                  : (isEn
                      ? 'Account deleted, you have exited this workspace. Team content belongs to the workspace; extension tokens and cache have been cleared.'
                      : '账号已注销，你已退出该工作区。团队的内容数据仍归工作区所有，未随你的账号删除；本机插件的采集令牌与缓存已清除。')}
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
                {isEn ? 'You are invited to join ' : '你被邀请加入 '}<b>{invite.tenantName}</b>{isEn ? ', as ' : '，角色为 '}<b>{invite.roleLabel}</b>。
                {invite.targeted ? (isEn ? ' This invitation is restricted to the specified phone number.' : ' 该邀请仅限指定手机号接受。') : ''}
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
                {isEn
                  ? 'Invite link is invalid, already used, or expired. You can still log in directly with your phone number, or request a new link.'
                  : '邀请链接无效、已被使用或已过期。你仍可用手机号直接登录，或向邀请人索取新链接。'}
              </div>
            ) : null}

            {fromDemo && !oaOnly ? (
              <div className="small" style={{ background: '#f1f5f9', color: '#334155', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13, lineHeight: 1.7, border: '1px solid rgba(100, 116, 139, 0.2)' }}>
                {isEn
                  ? <>The {next ? 'page' : 'content'} you just saw in the demo will open with <b>your own data</b> after login. {SLOGAN_EN}.</>
                  : <>刚才在演示里看到的{next ? '那一页' : '内容'}，登录后会用<b>你自己的数据</b>接着打开。{SLOGAN}。</>}
              </div>
            ) : null}

            {ref && !oaOnly ? (
              <div className="small" style={{ background: '#ecfdf5', color: '#047857', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13, lineHeight: 1.7, border: '1px solid rgba(5, 150, 105, 0.2)' }}>
                {isEn
                  ? <>🎁 You were invited: upon successful registration, you and the inviter <b>each get {REFERRAL_DAYS} days of Standard tier</b> (stacked on top of the 30-day trial).</>
                  : <>🎁 你是被邀请来的：注册成功后你和邀请人<b>各得 {REFERRAL_DAYS} 天标准版</b>（叠在 30 天试用之上）。</>}
              </div>
            ) : null}

            {!invite && !inviteInvalid && !oaOnly ? (
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
                <span>{isEn ? 'New users get 30 days Standard tier upon signup (200 AI credits/day)' : '新用户注册即送 30 天标准版 (每天 200 次 AI 额度)'}</span>
              </div>
            ) : null}

            {oaOnly ? (
              <OaLoginPanel err={err} webAuth={edition() === 'private'} />
            ) : (
              <LoginForm invite={invite} wechatEnabled={wechatEnabled} wxError={wxError} next={next} referral={ref} />
            )}
            {/* 游客访问 = 演示租户，是 SaaS 的获客入口。客户自己的机器上放一个「免注册体验」
                既没有意义，又等于给局域网里任何人开了一扇不需要身份的门。 */}
            {!invite && !oaOnly && <GuestButton />}
          </div>
        </div>
      </div>

      {/* 资质栏只在 SaaS 上出现。
          这些 ICP / 公网安备 / 增值电信 / 广播电视许可证是**我们这家公司**的，
          印在客户自己那台机器（或客户自己云上的私有化实例）的登录页上，
          等于用我们的资质给客户自建的服务背书 —— 那是冒名，不是版权声明。
          企业版只留一行不含任何主体资质的产品署名。 */}
      {oaOnly ? (
        <footer className="login-footer">
          <div className="login-footer-line">
            <span>{isEn ? 'Beacon · Enterprise Edition' : '烽火台 · 企业版'}</span>
          </div>
        </footer>
      ) : (
        <footer className="login-footer">
          <div className="login-footer-line">
            <span>Copyright © 2013 - 2026 Yunci All Rights Reserved. {isEn ? 'Yunci Digital.' : '云磁数字 版权所有'}</span>
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
      )}
    </div>
  );
}
