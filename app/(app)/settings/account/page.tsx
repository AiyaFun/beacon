import { PageHead } from '@/components/ui';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { getWechatConfig } from '@/lib/wechat-auth';
import { can } from '@/lib/rbac';
import { isDemoTenant } from '@/lib/demo/guard';
import { AccountSecurityCard } from '../AccountSecurityCard';
import { AccountDataCard } from '../AccountDataCard';
import { PrivacyCard } from '../PrivacyCard';
import { OaBindCard } from '../OaBindCard';
import { PasswordCard } from '../PasswordCard';
import { ApiTokenCard } from '../ApiTokenCard';
import { listApiTokens, apiEnabled } from '@/lib/api/token';
import { siteUrl } from '@/lib/site-url';
import { fmtDate } from '@/lib/format';
import { can as canEdition } from '@/lib/edition';
import { botProviderName } from '@/lib/bot/types';
import { HubHeader } from '@/components/HubHeader';

export const dynamic = 'force-dynamic';

type SettingsQuery = { wx_bind?: string; wx_bind_error?: string };

export default async function AccountSecurityPage(props: { searchParams: Promise<SettingsQuery> }) {
  const s = await getSession();
  // 只有本机/私有化部署才有对外调用面；SaaS 上这张卡整个不渲染
  const apiTokens = apiEnabled()
    ? (await listApiTokens(s.memberId)).map((t) => ({
        id: t.id,
        label: t.label,
        prefix: t.prefix,
        createdAt: fmtDate(t.createdAt),
        lastUsedAt: t.lastUsedAt ? fmtDate(t.lastUsedAt) : null,
      }))
    : null;
  const searchParams = await props.searchParams;
  
  const me = await prisma.member.findUnique({
    where: { id: s.memberId },
    select: { phone: true, wechatOpenId: true, passwordHash: true }
  });
  const hasPassword = Boolean(me?.passwordHash);

  const maskedPhone = me?.phone ? me.phone.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2') : null;

  // 企业版专属：绑定企业应用账号（SaaS 上 can('oaLogin') 恒为 false，整块不渲染）

  const oaLogin = canEdition('oaLogin');

  const oaBot = oaLogin

    ? await prisma.botIntegration.findFirst({ where: { enabled: true }, orderBy: { createdAt: 'asc' }, select: { provider: true } })

    : null;

  const oaProviderName = oaBot ? botProviderName(oaBot.provider) : null;

  const oaBound = oaLogin

    ? Boolean((await prisma.member.findUnique({ where: { id: s.memberId }, select: { oaIdentity: true } }))?.oaIdentity)

    : false;


  return (
    <>
      <HubHeader
        title="账号与安全"
        hint="登录方式绑定与换绑 · 隐私与数据安全声明 · 数据导出与账号注销"
      />

      {/* 本机密码（个人创作者小站）：设了它，登录页就多一条不依赖企业应用的门 */}
      {canEdition('passwordLogin') ? <PasswordCard hasPassword={hasPassword} /> : null}

      {oaLogin ? <OaBindCard providerName={oaProviderName} bound={oaBound} /> : null}

      {/* 对外调用令牌：只有本机/私有化部署才有这条路（SaaS 的边界是公网，
          多开一条「拿到一串字符就能代人操作」的通道要单独评估） */}
      {apiTokens ? <ApiTokenCard rows={apiTokens} siteUrl={siteUrl()} /> : null}

      <AccountSecurityCard
        maskedPhone={maskedPhone}
        wechatBound={!!me?.wechatOpenId}
        wechatEnabled={getWechatConfig().enabled}
        isDemo={isDemoTenant(s.tenantId)}
        wxBindOk={searchParams.wx_bind === 'ok'}
        wxBindError={searchParams.wx_bind_error}
      />

      <PrivacyCard />

      {/* 数据清单要跑近三十次 count，故不在此预取——卡片内点开注销确认时才按需拉 */}
      <AccountDataCard
        isDemo={isDemoTenant(s.tenantId)}
        isOwner={s.role === 'owner'}
        canExport={can(s.role, 'data.export')}
      />
    </>
  );
}
