import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { TenantShell } from '@/components/TenantShell';
import { PublicShell } from '@/components/PublicShell';
import { getSessionOrNull } from '@/lib/session';
import { needsSetup } from '@/lib/setup/state';
import { edition } from '@/lib/edition';
import { GUEST_READABLE_APP_PATHS, PATHNAME_HEADER } from '@/lib/auth-constants';

// 已登录区外壳：无会话直接跳登录。
//
// 外壳本身长什么样在 components/TenantShell.tsx —— (public) 那组也要给登录用户渲染同一层，
// 各写一份必然漂移（任务台的人点 /hotlists 掉回工作台侧栏，就是漂移的结果）。
// 这里只留这一组独有的两道闸。
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // 企业版首启：库里一个成员都没有时，先去装机而不是去登录 ——
  // 登录页在这个形态下没有可用的登录方式（没有短信通道，OA 也还没配）。
  // SaaS 上 needsSetup() 恒为 false，这一行等于不存在。
  if (await needsSetup()) redirect('/setup');
  const session = await getSessionOrNull();
  if (!session) {
    // 【游客只读的三页】公开首页 `/`、桌面客户端 `/desktop`、插件 `/extension`（2026-09-05）。
    // 陌生人看一眼有没有 Windows 版、价格是多少，不该先填手机号。
    // 路径由中间件写进请求头（客户端伪造无效：非公开路径在中间件已被 307）。
    // 只对 SaaS 开放——整机/私有化没有对外营销面，未登录一律去登录。
    // 页面自己必须用 getSessionOrNull 渲染游客分支；用了 getSession() 的页在这里会抛「未登录」，
    // 那是页面的 bug，不是布局要兜的事。
    const p = (await headers()).get(PATHNAME_HEADER) ?? '';
    if (edition() === 'saas' && GUEST_READABLE_APP_PATHS.includes(p)) {
      return <PublicShell>{children}</PublicShell>;
    }
    redirect('/login');
  }

  return <TenantShell session={session}>{children}</TenantShell>;
}
