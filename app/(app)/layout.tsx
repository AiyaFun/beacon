import { redirect } from 'next/navigation';
import { TenantShell } from '@/components/TenantShell';
import { getSessionOrNull } from '@/lib/session';
import { needsSetup } from '@/lib/setup/state';

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
  if (!session) redirect('/login');

  return <TenantShell session={session}>{children}</TenantShell>;
}
