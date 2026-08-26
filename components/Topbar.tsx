import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getSessionOrNull } from '@/lib/session';
import { platformName } from '@/lib/constants';
import { actLogout } from '@/app/(app)/actions';
import { unreadNotificationCount, listNotifications } from '@/lib/notify';
import { AccountSwitcher } from './AccountSwitcher';
import { MobileNav } from './MobileNav';
import { NotificationBell } from './NotificationBell';
import { visibleNav } from '@/lib/nav';
import { can } from '@/lib/edition';
import { PLAN_LABEL } from '@/lib/plan-label';

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
  if (session) {
    accounts = await prisma.creatorAccount.findMany({
      where: { workspaceId: session.workspaceId, status: 'active' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, platform: true },
    });
    const [cnt, items] = await Promise.all([
      // 带上 memberId：点名给别人的通知（比如「等 XX 确认」）不该让我看到红点——
      // 那是一件我推不动的事
      unreadNotificationCount(session.workspaceId, session.memberId),
      listNotifications(session.workspaceId, 12, session.memberId),
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
      {/* 手机端**恒给全量导航**，任务台下也是——不许改成 TASK_NAV「保持一致」。
          理由：外壳切换器是 hide-mobile（顶栏 390px 下位置本来就不够，见下面模型状态那段）。
          手机上若也只给任务台那 8 个入口，用户就被困在精简模式里出不来：
          既看不到别的板块，也没有任何地方能切回工作台。
          「一致」在这里是错的目标，「任何屏幕上都走得出去」才是。 */}
      <MobileNav nav={visibleNav()} />
      <div className="row" style={{ gap: 10 }}>
        {/* 套餐 / 我是谁 / 界面排法 / 退出 都搬到了**侧栏底部的账号区**
            （components/SidebarUser.tsx，2026-08-26 用户要求「往下放」）。
            顶栏只留跟「这一页在干什么」有关的：当前账号、模型状态、通知。
            ⚠️ 唯一的例外是最下面那个 `show-mobile` 的退出——手机端侧栏整个
            display:none，不留这一个的话手机上退不出去（globals.css 里那段
            「顶栏右侧必须始终在屏内」记的就是这个伤疤）。 */}
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
      {/* 2026-08-26 从纯文本状态改成**配置入口**（用户：「把所有模型的配置入口」——
          这个点此前只能看不能点，想配模型还得自己想起设置在哪）。所有模型相关配置
          （BYOK 渠道/按功能路由/生图/机器人凭据）都在「接入与密钥」一页。 */}
      <Link
        href="/settings/keys"
        className="badge badge-gray hide-mobile"
        title={isDemo ? '尚未接入真实模型，点击去配置' : '当前使用的生成模型 · 点击进入接入与密钥'}
      >
        <span className={`dot ${isDemo ? 'dot-amber' : 'dot-green'}`} /> {llmMode}
      </Link>
      {session && <NotificationBell count={notifCount} items={notifItems} />}
      {/* 手机专用的退出。桌面上它在侧栏账号区里，这里 show-mobile 藏起来不重复出现 */}
      <form action={actLogout} className="show-mobile">
        <button className="btn btn-sm btn-ghost" type="submit">退出</button>
      </form>
    </div>
  );
}
