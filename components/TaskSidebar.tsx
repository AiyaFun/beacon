import { NavList } from './Sidebar';
import { DesktopDownloadCard } from './DesktopDownloadCard';
import type { NavGroup } from '@/lib/nav';
import type { RunEntry } from '@/lib/runs/badge';
import { SidebarBrand } from './SidebarBrand';
import { TaskSidebarRecent } from './TaskSidebarRecent';

export function TaskSidebar({
  nav,
  recent,
  footer,
  desktop,
}: {
  nav: NavGroup[];
  recent: RunEntry[];
  /** 侧栏最底部的账号区（服务端组装好传进来，见 components/SidebarUser.tsx） */
  footer?: React.ReactNode;
  /** 桌面客户端下载卡的数据；没打过包（清单读不到）时不传，那块位置就空着 */
  desktop?: { version: string; platforms: string };
}) {
  // 设置钉到最底部：它在「最近」之下、账号区之上（2026-08-26 用户要求「把设置也往下放」）
  const main = nav.filter((g) => !g.pinBottom);

  const seen = new Map<string, { row: RunEntry; times: number }>();
  for (const r of recent) {
    const key = `${r.kind}|${r.title}`;
    const hit = seen.get(key);
    // 留**最新那一条**的 href 与状态（recent 已按时间倒序）
    if (hit) hit.times += 1;
    else seen.set(key, { row: r, times: 1 });
  }
  const rows = [...seen.values()];
  return (
    <aside className="sidebar sidebar-task">
      <SidebarBrand />

      <div className="sidebar-scroll">
        <NavList nav={main} />
        <TaskSidebarRecent rows={rows} />
      </div>
      {/* 下载卡钉在账号区之上、滚动区之外：它是常驻入口，不该跟着「最近」一起滚走 */}
      {desktop && <DesktopDownloadCard version={desktop.version} platforms={desktop.platforms} />}
      {footer}
    </aside>
  );
}
