import Link from 'next/link';
import Image from 'next/image';
import { TenantShell } from '@/components/TenantShell';
import { getSessionOrNull } from '@/lib/session';

// 公开区外壳。登录用户 → 完整 app 外壳（走 TenantShell，与 (app) 是同一份实现）；
// 游客 → 轻量落地外壳（logo + 登录/注册 CTA），用于「先逛后注册」。
//
// 【为什么必须走 TenantShell 而不是自己拼】这里原本抄了一份侧栏 + 阶段页签，
// 于是 /hotlists 对登录用户**恒定是工作台外壳**：选了任务台的人点「找料 → 看热点」，
// 侧栏当场变回七阶段，点下一个又变回来。抄的那份还漏了演示/到期横幅和全局助手。
// 外壳只有一个实现，改法见 components/TenantShell.tsx 顶部。
//
// 🔒 本 layout **不做登录闸**：放行哪些路径由 middleware.ts 的 PUBLIC_PATHS 决定，
// (app)/layout 仍是受保护页的唯一 choke point（那里 redirect('/login') 保持不动）。
// 因此放进本组的页面必须自证：只读、不碰任何 llmComplete、不触发写操作（游客没有租户，
// 配额/限流按租户算会被击穿）。当前只有 /hotlists（纯读全局热榜表）。
export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionOrNull();

  if (session) return <TenantShell session={session}>{children}</TenantShell>;

  // 游客：轻量落地外壳
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header
        className="row-between"
        style={{ padding: '12px 20px', borderBottom: '1px solid var(--surface-2)', position: 'sticky', top: 0, background: 'var(--bg)', zIndex: 10 }}
      >
        <Link href="/hotlists" className="brand" style={{ textDecoration: 'none' }}>
          <Image src="/logo.png" alt="烽火台" width={36} height={36} className="brand-logo-img" />
          <div>
            <div className="brand-name">烽火台</div>
            <div className="brand-sub">跨平台内容作战室</div>
          </div>
        </Link>
        <Link href="/login" className="btn btn-primary btn-sm">登录 / 注册</Link>
      </header>
      <div className="content" style={{ flex: 1, maxWidth: 1680, width: '100%', margin: '0 auto' }}>{children}</div>
    </div>
  );
}
