import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getSessionOrNull } from '@/lib/session';
import { resolvePlatformAdmin } from '@/lib/ops/admin';
import { platformName } from '@/lib/constants';
import { actLogout } from '@/app/(app)/actions';
import { unreadNotificationCount, listNotifications } from '@/lib/notify';
import { AccountSwitcher } from './AccountSwitcher';
import { MobileNav } from './MobileNav';
import { NotificationBell } from './NotificationBell';
import { visibleNav } from '@/lib/nav';
import { can } from '@/lib/edition';

const PLAN_LABEL: Record<string, string> = {
  free: '免费版',
  trial: '试用中',
  personal: '标准版',
  byok: '自带 Key 版',
  team: '团队版', // 已下线，存量租户显示用
  enterprise: '企业版',
};

export async function Topbar() {
  const session = await getSessionOrNull();
  // isDemo 是独立布尔，不从 llmMode 文案反推——渠道名称是自由文本，用户可能把真实渠道
  // 命名成「演示数据模式」，若靠字符串全等判断会误报琥珀点+「未接入」。翻布尔只在真正
  // 落到演示兜底时才为 true。
  let llmMode = '演示数据模式';
  let isDemo = true;
  let accounts: { id: string; name: string; platform: string }[] = [];
  let notifCount = 0;
  let notifItems: { id: string; kind: string; title: string; body: string; link: string | null; read: boolean; createdAt: string }[] = [];
  // 运维台入口只对平台超管出现。普通用户连这个链接的存在都看不到（/ops 本身也是 notFound）。
  let isPlatformAdmin = false;
  if (session) {
    isPlatformAdmin = (await resolvePlatformAdmin(session.memberId)) !== null;
    accounts = await prisma.creatorAccount.findMany({
      where: { workspaceId: session.workspaceId, status: 'active' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, platform: true },
    });
    const [cnt, items] = await Promise.all([
      unreadNotificationCount(session.workspaceId),
      listNotifications(session.workspaceId),
    ]);
    notifCount = cnt;
    notifItems = items.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, read: n.read, createdAt: n.createdAt.toISOString() }));
    // status:'ok' = 连通性测过。企业版装机向导刚写入的渠道是 'untested'（装机时不替客户烧一次调用去探活），
    // 只认 'ok' 会让刚装完的机器在右上角显示「演示模型」——用户以为 Key 没配上。
    const provider = await prisma.modelProvider.findFirst({
      where: { tenantId: session.tenantId, status: can('platformLlmChannel') ? 'ok' : { not: 'failed' } },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    if (provider) {
      llmMode = provider.label;
      isDemo = false;
    } else if (can('platformLlmChannel') && process.env.BEACON_DEFAULT_LLM_API_KEY) {
      // 企业版没有平台垫付渠道（lib/llm/gateway.ts 已整段跳过），
      // 这里也不能显示「平台默认模型」——那是在告诉用户一个不存在的东西正在为他工作。
      llmMode = '平台默认模型';
      isDemo = false;
    }
  }
  return (
    <div className="topbar">
      <MobileNav nav={visibleNav()} />
      <div className="row" style={{ gap: 10 }}>
        <span className="badge badge-brand">{PLAN_LABEL[session?.plan ?? 'free']}</span>
        {session && (
          <AccountSwitcher
            currentId={session.accountId}
            accounts={accounts.map((a) => ({ ...a, platformLabel: platformName(a.platform) }))}
          />
        )}
      </div>
      <div className="spacer" />
      {/* 模型状态在手机上让位：它是纯信息（设置页看得到），而它占的 ~100px 正好是把
          「通知」和「退出」挤出屏幕的那部分——真机 390px 下这两个按钮默认完全在屏外，
          顶栏虽然 overflow-x:auto 能横向划出来，但没有任何提示，没人会想到去划。 */}
      <span
        className="badge badge-gray hide-mobile"
        title={isDemo ? '尚未接入真实数据源/AI，看到的是示例数据' : '当前使用的生成模型'}
      >
        <span className={`dot ${isDemo ? 'dot-amber' : 'dot-green'}`} /> {llmMode}
      </span>
      {isPlatformAdmin && (
        <Link className="badge badge-red hide-mobile" href="/ops" title="平台运维台（跨租户）">
          运维台
        </Link>
      )}
      {session && <NotificationBell count={notifCount} items={notifItems} />}
      {session && <span className="small muted hide-mobile">{session.memberName}</span>}
      <form action={actLogout}>
        <button className="btn btn-sm btn-ghost" type="submit">退出</button>
      </form>
    </div>
  );
}
