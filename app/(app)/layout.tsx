import { redirect } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { Topbar } from '@/components/Topbar';
import { DemoBanner } from '@/components/DemoBanner';
import { ExpiryBanner } from '@/components/ExpiryBanner';
import { GlobalAIAssistant } from '@/components/GlobalAIAssistant';
import { getSessionOrNull } from '@/lib/session';
import { isDemoTenant } from '@/lib/demo/guard';
import { prisma } from '@/lib/db';
import { needsSetup } from '@/lib/setup/state';
import { visibleNav } from '@/lib/nav';

// 已登录区外壳：无会话直接跳登录。
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // 企业版首启：库里一个成员都没有时，先去装机而不是去登录 ——
  // 登录页在这个形态下没有可用的登录方式（没有短信通道，OA 也还没配）。
  // SaaS 上 needsSetup() 恒为 false，这一行等于不存在。
  if (await needsSetup()) redirect('/setup');
  const session = await getSessionOrNull();
  if (!session) redirect('/login');
  const demo = isDemoTenant(session.tenantId);
  const account = await prisma.creatorAccount.findUnique({
    where: { id: session.accountId },
    select: { name: true },
  });
  const accountName = account?.name ?? '我的账号';
  // 导航按形态过滤（企业版不显示计费）。必须在服务端算——客户端读不到 BEACON_EDITION。
  const nav = visibleNav();

  return (
    <div className="app-shell">
      <Sidebar nav={nav} />
      <div className="main">
        <Topbar />
        {demo && <DemoBanner />}
        {!demo && <ExpiryBanner tenantId={session.tenantId} role={session.role} />}
        <div className="content">{children}</div>
      </div>
      <GlobalAIAssistant accountName={accountName} />
    </div>
  );
}
