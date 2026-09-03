import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getSessionOrNull } from '@/lib/session';
import { platformName } from '@/lib/constants';
import { actLogout } from '@/app/(app)/actions';
import { unreadNotificationCount, listNotifications } from '@/lib/notify';
import { AccountSwitcher } from './AccountSwitcher';
import { MobileNav } from './MobileNav';
import { NotificationBell } from './NotificationBell';
import { LanguageSwitcher } from './LanguageSwitcher';
import { ModelStatusBadge } from './ModelStatusBadge';
import { visibleNav } from '@/lib/nav';
import { can } from '@/lib/edition';

export async function Topbar() {
  const session = await getSessionOrNull();
  let llmMode = '演示数据模式';
  let isDemo = true;
  let accounts: { id: string; name: string; platform: string }[] = [];
  let notifCount = 0;
  let notifItems: { id: string; kind: string; title: string; body: string; link: string | null; read: boolean; createdAt: string }[] = [];
  if (session) {
    accounts = await prisma.creatorAccount.findMany({
      where: { workspaceId: session.workspaceId, status: 'active' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, platform: true },
    });
    const [cnt, items] = await Promise.all([
      unreadNotificationCount(session.workspaceId, session.memberId),
      listNotifications(session.workspaceId, 12, session.memberId),
    ]);
    notifCount = cnt;
    notifItems = items.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, read: n.read, createdAt: n.createdAt.toISOString() }));
    const provider = await prisma.modelProvider.findFirst({
      where: { tenantId: session.tenantId, status: can('platformLlmChannel') ? 'ok' : { not: 'failed' } },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    if (provider) {
      llmMode = provider.label;
      isDemo = false;
    } else if (can('platformLlmChannel') && process.env.BEACON_DEFAULT_LLM_API_KEY) {
      llmMode = '平台默认模型';
      isDemo = false;
    }
  }
  return (
    <div className="topbar">
      <MobileNav nav={visibleNav()} />
      <div className="row" style={{ gap: 10 }}>
        {session && (
          <AccountSwitcher
            currentId={session.accountId}
            accounts={accounts.map((a) => ({ ...a, platformLabel: platformName(a.platform) }))}
          />
        )}
      </div>
      <div className="spacer" />
      <ModelStatusBadge isDemo={isDemo} rawLabel={llmMode} />
      <LanguageSwitcher compact />
      {session && <NotificationBell count={notifCount} items={notifItems} />}
      <form action={actLogout} className="show-mobile">
        <button className="btn btn-sm btn-ghost" type="submit">退出</button>
      </form>
    </div>
  );
}
