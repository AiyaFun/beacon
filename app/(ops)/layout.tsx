import { notFound } from 'next/navigation';
import Link from 'next/link';
import { currentPlatformAdmin } from '@/lib/ops/guard';
import { OpsNav } from './OpsNav';

// 平台运维台外壳（/ops）。与租户侧的 (app) 外壳完全分开：
// 这里没有账号切换、没有侧边栏导航、没有全局 AI 助手——那些都是「站在某个租户里」才成立的东西，
// 而运维台的视角恰恰是跨租户的。混用外壳会让人分不清自己此刻在谁的数据里。
//
// 非超管一律 notFound()：不是 403 而是 404，不对外暴露「这里有个后台」。
export default async function OpsLayout({ children }: { children: React.ReactNode }) {
  const admin = await currentPlatformAdmin();
  if (!admin) notFound();

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <header
        style={{
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface)',
          padding: '12px 24px',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <strong style={{ fontSize: 15, letterSpacing: '-0.3px' }}>烽火台 · 平台运维台</strong>
        <span className="badge badge-red">跨租户 · 每个动作留痕</span>
        <OpsNav />
        <span className="row" style={{ gap: 10, marginLeft: 'auto' }}>
          <span className="small muted">{admin.memberName}</span>
          <Link className="btn btn-sm btn-ghost" href="/">
            回到我的工作台
          </Link>
        </span>
      </header>
      <div style={{ padding: 24, maxWidth: 1280, margin: '0 auto' }}>{children}</div>
    </div>
  );
}
