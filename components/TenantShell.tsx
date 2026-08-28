import { Topbar } from '@/components/Topbar';
import { DemoBanner } from '@/components/DemoBanner';
import { ExpiryBanner } from '@/components/ExpiryBanner';
import { LegalUpdateBanner } from '@/components/LegalUpdateBanner';
import { GlobalAIAssistant } from '@/components/GlobalAIAssistant';
import { TaskSidebar } from '@/components/TaskSidebar';
import { SidebarUser } from '@/components/SidebarUser';
import { resolvePlatformAdmin } from '@/lib/ops/admin';
import { actLogout } from '@/app/(app)/actions';
import { PLAN_LABEL } from '@/lib/plan-label';
import pkg from '@/package.json';
import { NextSteps } from '@/components/NextSteps';
import { prisma } from '@/lib/db';
import { isDemoTenant } from '@/lib/demo/guard';
import { visibleTaskNav } from '@/lib/shell-server';
import { listRuns } from '@/lib/runs';
import { readDesktopManifest, DESKTOP_OS_LABEL } from '@/lib/downloads';
import type { SessionContext } from '@/lib/session';

// 登录用户的外壳，**唯一一份**。(app) 与 (public) 两个路由组都必须经由这里渲染。
//
// 【为什么收成一份】2026-08-20 真机抓到：cookie 是 taskdeck，点任务台「找料 → 看热点」
// 进 /hotlists，侧栏当场变回工作台的七阶段。原因是 /hotlists 属于 (public) 路由组
//（它要允许游客先逛后注册），而那个 layout 自己抄了一份登录态外壳、写死 Sidebar +
// StageTabs，从来没读过 currentShell()。两份外壳必然漂移——事实上它还漏了
// DemoBanner / ExpiryBanner / GlobalAIAssistant 三样。
//
// 于是规矩是：**外壳只有这一个实现**。哪个路由组要给登录用户看外壳，就 import 它，
// 不许自己再拼一份侧栏。守卫在 tests/shell-modes.test.ts —— 它逐条
// 核对侧栏里每个 href 落在哪个路由组、那个组的 layout 是不是走的 TenantShell。
//
// 🔒 这里**不做登录闸**。放行哪些路径由 middleware.ts 的 PUBLIC_PATHS 决定，
// (app)/layout 仍是受保护页的唯一 choke point。本组件只回答「已经有 session 的人，
// 外壳长什么样」。
export async function TenantShell({
  session,
  children,
}: {
  session: SessionContext;
  children: React.ReactNode;
}) {
  const demo = isDemoTenant(session.tenantId);
  // 侧栏下载卡：没打过桌面包（清单读不到）就不给卡，免得点进去是空页面
  const desktopCard = () => {
    const m = readDesktopManifest();
    if (!m) return undefined;
    const oses = [...new Set(m.builds.map((b) => DESKTOP_OS_LABEL[b.os]))];
    return { version: m.version, platforms: oses.join(' · ') };
  };
  const [account, member, platformAdmin] = await Promise.all([
    prisma.creatorAccount.findUnique({ where: { id: session.accountId }, select: { name: true } }),
    // 用户上次选的外壳。cookie 没有时用它——换台电脑、清了缓存，选过的那套还在
    prisma.member.findUnique({ where: { id: session.memberId }, select: { shellMode: true } }),
    // 运维台入口跟着账号区走（原来在顶栏）。普通用户连这个链接的存在都看不到
    resolvePlatformAdmin(session.memberId),
  ]);
  const accountName = account?.name ?? '我的账号';

  // 单壳化（2026-08-26 用户拍板删工作台）：唯一导航 + 常驻「最近」列表。
  // takePerKind 压到 8：侧栏只显示 6 条（完整清单在 /runs）。
  const recent = (await listRuns(session.workspaceId, { takePerKind: 8 })).slice(0, 6);
  const shellNav = visibleTaskNav();
  const settingsGroup = shellNav.find((g) => g.pinBottom) ?? null;
  const userFooter = (
    <SidebarUser
      memberName={session.memberName}
      planLabel={PLAN_LABEL[session.plan ?? 'free'] ?? '免费版'}
      isPlatformAdmin={platformAdmin !== null}
      settings={settingsGroup}
      logout={actLogout}
      version={pkg.version}
    />
  );

  return (
    <div className="app-shell shell-taskdeck">
      <TaskSidebar nav={shellNav} recent={recent} footer={userFooter} desktop={desktopCard()} />
      <div className="main">
        <Topbar />
        {demo && <DemoBanner />}
        {!demo && <ExpiryBanner tenantId={session.tenantId} role={session.role} />}
        {/* 政策更新告知（隐私政策第九节承诺的那条腿）。演示租户不打扰——那是只读展台。
            给**所有角色**看，不像催费那样只给 owner/admin：政策管的是每个人自己的
            个人信息，不是账单。 */}
        {!demo && <LegalUpdateBanner memberId={session.memberId} />}
        <div className="content">
          {children}
          {/* 「下一步去哪儿」：写完→查红线→发出去 这条链路的页脚路标（components/NextSteps.tsx） */}
          <NextSteps nav={shellNav} />
        </div>
      </div>
      <GlobalAIAssistant accountName={accountName} />
    </div>
  );
}
