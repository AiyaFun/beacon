import { redirect } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { Topbar } from '@/components/Topbar';
import { DemoBanner } from '@/components/DemoBanner';
import { ExpiryBanner } from '@/components/ExpiryBanner';
import { GlobalAIAssistant } from '@/components/GlobalAIAssistant';
import { getSessionOrNull } from '@/lib/session';
import { isDemoTenant } from '@/lib/demo/guard';
import { prisma } from '@/lib/db';

// 已登录区外壳：无会话直接跳登录。
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionOrNull();
  if (!session) redirect('/login');
  const demo = isDemoTenant(session.tenantId);
  const account = await prisma.creatorAccount.findUnique({
    where: { id: session.accountId },
    select: { name: true },
  });
  const accountName = account?.name ?? '我的账号';

  return (
    <div className="app-shell">
      <Sidebar />
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
