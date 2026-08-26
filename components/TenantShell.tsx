import { Sidebar } from '@/components/Sidebar';
import { StageTabs } from '@/components/StageTabs';
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
import { visibleNav } from '@/lib/nav';
import { currentShell, visibleTaskNav } from '@/lib/shell-server';
import { listRuns } from '@/lib/runs';
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
  const [account, member, platformAdmin] = await Promise.all([
    prisma.creatorAccount.findUnique({ where: { id: session.accountId }, select: { name: true } }),
    // 用户上次选的外壳。cookie 没有时用它——换台电脑、清了缓存，选过的那套还在
    prisma.member.findUnique({ where: { id: session.memberId }, select: { shellMode: true } }),
    // 运维台入口跟着账号区走（原来在顶栏）。普通用户连这个链接的存在都看不到
    resolvePlatformAdmin(session.memberId),
  ]);
  const accountName = account?.name ?? '我的账号';
  // 导航按形态过滤（企业版不显示计费）。必须在服务端算——客户端读不到 BEACON_EDITION。
  const nav = visibleNav();

  // 外壳：工作台（按阶段排）/ 任务台（按「我要什么」排）。**两者功能完全对等**，
  // 路由也完全相同，换的只是外面这一层怎么组织——理由写在 lib/shell.ts 顶部。
  const shell = await currentShell(member?.shellMode);
  // 侧栏那段任务列表只有任务台要，工作台下不查（这是每次导航都会跑的布局，白查五张表不值）。
  // takePerKind 压到 8：侧栏只显示 6 条，默认的 20 会查回 80 行再扔掉大半。
  // 代价是某一类里第 9 条往后的「等你处理」不会出现在侧栏——它本来就不是完整清单，
  // 完整的在 /runs（列表末尾那条「查看全部」指过去）。
  const recent = shell === 'taskdeck' ? (await listRuns(session.workspaceId, { takePerKind: 8 })).slice(0, 6) : [];

  // 侧栏底部的账号区：我是谁 / 用哪种排法 / 退出。两种外壳共用同一份
  //（2026-08-26 从顶栏搬下来，顶栏只留「这一页在干什么」相关的东西）
  // 「设置」那一组收进账号菜单（2026-08-26 用户要求）。从**当前外壳自己的那份导航**里挑，
  // 两种壳各有各的设置组（工作台叫「设置与支持」、任务台叫「设置」），不能写死一个。
  const shellNav = shell === 'taskdeck' ? visibleTaskNav() : nav;
  const settingsGroup = shellNav.find((g) => g.pinBottom) ?? null;
  const userFooter = (
    <SidebarUser
      memberName={session.memberName}
      planLabel={PLAN_LABEL[session.plan ?? 'free'] ?? '免费版'}
      shell={shell}
      isPlatformAdmin={platformAdmin !== null}
      settings={settingsGroup}
      logout={actLogout}
      version={pkg.version}
    />
  );

  return (
    <div className={`app-shell${shell === 'taskdeck' ? ' shell-taskdeck' : ''}`}>
      {shell === 'taskdeck'
        ? <TaskSidebar nav={shellNav} recent={recent} footer={userFooter} />
        : <Sidebar nav={nav} footer={userFooter} />}
      <div className="main">
        <Topbar />
        {demo && <DemoBanner />}
        {!demo && <ExpiryBanner tenantId={session.tenantId} role={session.role} />}
        {/* 政策更新告知（隐私政策第九节承诺的那条腿）。演示租户不打扰——那是只读展台。
            给**所有角色**看，不像催费那样只给 owner/admin：政策管的是每个人自己的
            个人信息，不是账单。 */}
        {!demo && <LegalUpdateBanner memberId={session.memberId} />}
        <div className="content">
          {/* 阶段页签：这一段有哪些板块 + 下一段去哪儿。侧栏只管「我在哪一段」。
              任务台不显示——那一排是「阶段」这个概念的产物，而任务台里没有阶段。 */}
          {shell === 'workbench' && <StageTabs nav={nav} />}
          {children}
          {/* 任务台没有阶段页签，「下一步去哪儿」得单独给一条——
              否则换个壳就把整条工作流链路丢了（见 components/NextSteps.tsx） */}
          {shell === 'taskdeck' && <NextSteps nav={nav} />}
        </div>
      </div>
      <GlobalAIAssistant accountName={accountName} />
    </div>
  );
}
