import Link from 'next/link';
import Image from 'next/image';
import { NavList } from './Sidebar';
import type { NavGroup } from '@/lib/nav';
import { STATUS_LABEL, type RunEntry, type RunStatus } from '@/lib/runs';

// 任务台侧栏：Accio 式的极简一列 + 下方常驻「任务」列表。
//
// 【下方那段任务列表是这个模式的灵魂】工作台里「有什么在跑」要专门去一趟运行中心；
// 任务台把它钉在侧栏上——一句话派完活，眼睛不用离开就能看着它跑。
// 只列最近 6 条：再多就把上面的入口挤出屏幕，而它本来就不是完整清单
//（完整的在 /runs，底部那条链接指过去）。
//
// 【功能与工作台完全对等】上一版这里只列 9 个入口，热点/竞对/资讯库/选题/工坊/数据
// 全都没有，理由写的是「用户自选的精简模式」。用户否掉了：换个壳不该少一半功能。
// 现在 TASK_NAV 覆盖 NAV 的每一个板块（用例逐条核），极简感靠**默认折叠**——
// 天天用的两组展开，其余点标题即开、进到组里自动展开。
//
// 【底部那句话仍然留着】不是因为这儿缺东西，而是因为用户在两套排法之间可能一时
// 找不到某个板块的新名字（这边叫「看同行」，那边叫「竞对监控」）。它说明的是
// 「换一种排法」，不是「去那边才有」。
const STATUS_DOT: Record<RunStatus, string> = {
  waiting: 'dot-amber',
  running: 'dot-green',
  done: 'dot-green',
  failed: 'dot-red',
  cancelled: 'dot-gray',
};

export function TaskSidebar({
  nav,
  recent,
  footer,
}: {
  nav: NavGroup[];
  recent: RunEntry[];
  /** 侧栏最底部的账号区（服务端组装好传进来，见 components/SidebarUser.tsx） */
  footer?: React.ReactNode;
}) {
  // 设置钉到最底部：它在「最近」之下、账号区之上（2026-08-26 用户要求「把设置也往下放」）
  const main = nav.filter((g) => !g.pinBottom);

  // 【去重】真机截图里 6 条只有 2 件事：「去采一个竞对」重复 4 次、「抖音·这不科学」2 次。
  // 同一个模板连着跑 3 遍（多半是失败重试）就占满整个列表，把真正不同的那几件挤没了。
  // 按「类型+标题」收成一条，右边标次数——用户想看的是「有哪几件事在跑」，不是流水账。
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
      <div className="brand">
        <Image src="/logo.png" alt="烽火台" width={36} height={36} className="brand-logo-img" />
        <div>
          <div className="brand-name">烽火台</div>
          <div className="brand-sub">任务台</div>
        </div>
      </div>

      {/* 中间这一层负责滚动，账号区留在它外面 —— 见 globals.css 的 .sidebar-scroll。
          此前整根侧栏是一个 flex 列且只有「最近」带 overflow，于是设置一展开，
          被压扁的永远是「最近」（真机截图：压成两行高的小滚动条）。 */}
      <div className="sidebar-scroll">
      <NavList nav={main} />

      <div className="nav-group task-recent">
        <div className="nav-group-title">最近</div>
        {rows.length === 0 ? (
          <p className="small muted" style={{ padding: '2px 10px' }}>
            还没有任务。去「新任务」说一句话试试。
          </p>
        ) : (
          rows.map(({ row: r, times }) => (
            // 点自己那一条的落地页，不是统一丢回 /runs：侧栏这份列表的用途是
            // 「派完活看着它跑」，而「在等你确认」那条最需要的恰恰是**一步到那件事上**。
            // 各类的 href 由 lib/runs 统一给（AI 执行那条带 runId，浏览器任务带锚点），
            // 这里不自己拼——拼第二份迟早跟运行中心那份对不上。
            <Link
              key={`${r.kind}-${r.id}`}
              href={r.href}
              className="task-item"
              title={`${STATUS_LABEL[r.status]} · ${r.title}`}
            >
              <span className={`dot ${STATUS_DOT[r.status]}`} />
              <span className="task-item-text">{r.title}</span>
              {/* 重复的次数摆出来，而不是把同一行印 4 遍 */}
              {times > 1 && <span className="task-item-times">×{times}</span>}
            </Link>
          ))
        )}
        {rows.length > 0 && (
          <Link href="/runs" className="small muted task-more">查看全部 →</Link>
        )}
      </div>

        {/* 「设置」不在这儿渲染了：2026-08-26 起它收进底部账号菜单
            （components/SidebarUser.tsx），由 TenantShell 传过去 */}
      </div>
      {footer}
    </aside>
  );
}
