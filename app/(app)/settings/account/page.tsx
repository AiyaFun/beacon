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
import { can as canEdition } from '@/lib/edition';
import { botProviderName } from '@/lib/bot/types';

export const dynamic = 'force-dynamic';

type SettingsQuery = { wx_bind?: string; wx_bind_error?: string };

export default async function AccountSecurityPage(props: { searchParams: Promise<SettingsQuery> }) {
  const s = await getSession();
  const searchParams = await props.searchParams;
  
  const me = await prisma.member.findUnique({
    where: { id: s.memberId },
    select: { phone: true, wechatOpenId: true }
  });

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
      <PageHead
        title="账号与安全"
        desc="登录方式绑定与换绑 · 隐私与数据安全声明 · 数据导出与账号注销"
      />

      {oaLogin ? <OaBindCard providerName={oaProviderName} bound={oaBound} /> : null}

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
