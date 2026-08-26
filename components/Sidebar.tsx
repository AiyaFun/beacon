'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { activeHref, groupHasActive, type NavGroup } from '@/lib/nav';
import { Icon } from './icons';

// 侧栏：**分组 + 逐个板块列出**（用户 2026-08-19 明确要求沿用这个效果）。
//
// 曾经改成过「一个阶段一行、板块只在页面顶部的阶段页签里」，好处是侧栏短；
// 代价是任何一个板块都要先点阶段、再点页签，两下才到——**天天用的人要的是一下到位**。
// 页面顶部的阶段页签（components/StageTabs.tsx）保留：那一排回答的是
// 「这一段还有哪些板块、下一段去哪儿」，与侧栏的「全站地图」不冲突。
//
// 两件事在这里，不在 CSS 里：
//   ① **只点亮一条**——最长前缀胜出（activeHref）。此前是 startsWith，于是打开
//      /settings/keys 时「接入与密钥」和「运行设置」一起高亮，用户看不出自己在哪。
//   ② 低频分组（设置与支持，9 项）默认收起，但**进到组里的页面会自动展开**，
//      手动展开的状态记在本地。收起 ≠ 藏起来：标题与箭头始终可见。

const OPEN_KEY = 'beacon:nav:open';

export function NavList({ nav, onNavigate }: { nav: NavGroup[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  const active = activeHref(nav, pathname);
  const [manual, setManual] = useState<Record<string, boolean>>({});

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(OPEN_KEY);
      if (raw) setManual(JSON.parse(raw) as Record<string, boolean>);
    } catch {
      // localStorage 被禁用（隐私模式/企业策略）时按默认展开规则走，不影响可用性
    }
  }, []);

  function toggle(title: string, next: boolean) {
    const merged = { ...manual, [title]: next };
    setManual(merged);
    try {
      window.localStorage.setItem(OPEN_KEY, JSON.stringify(merged));
    } catch {
      /* 同上：存不下就只在本次会话里生效 */
    }
  }

  return (
    <nav>
      {nav.map((group) => {
        const hasActive = groupHasActive(group, pathname);
        const open = manual[group.title] ?? (!group.collapsed || hasActive);
        return (
          <div className="nav-group" key={group.title}>
            {group.collapsed ? (
              <button
                type="button"
                className="nav-group-title nav-group-toggle"
                aria-expanded={open}
                onClick={() => toggle(group.title, !open)}
              >
                <span>{group.title}</span>
                <Icon.chevron size={13} className={`nav-chevron${open ? ' open' : ''}`} />
              </button>
            ) : (
              // 空标题 = 扁平一列，不渲染分组头（任务台主入口就是这样，见 lib/shell.ts）
              group.title ? <div className="nav-group-title">{group.title}</div> : null
            )}
            {open &&
              group.items.map((item) => {
                const IconCmp = Icon[item.icon];
                return (
                  <Link
                    href={item.href}
                    key={item.href}
                    className={`nav-item${item.href === active ? ' active' : ''}`}
                    title={item.hint}
                    onClick={onNavigate}
                  >
                    <IconCmp className="ic" />
                    <span>{item.label}</span>
                    {item.badge && <span className="nav-badge">{item.badge}</span>}
                  </Link>
                );
              })}
          </div>
        );
      })}
    </nav>
  );
}

export function Sidebar({ nav, footer }: { nav: NavGroup[]; footer?: React.ReactNode }) {
  // pinBottom 的组（设置与支持）钉到最底部，与账号区挨着——都是「装一次就不动」的东西，
  // 不跟每天要点的板块抢上半屏（2026-08-26 用户要求）
  const main = nav.filter((g) => !g.pinBottom);
  return (
    <aside className="sidebar">
      <div className="brand">
        <Image src="/logo.png" alt="烽火台" width={36} height={36} className="brand-logo-img" />
        <div>
          <div className="brand-name">烽火台</div>
          <div className="brand-sub">跨平台内容作战室</div>
        </div>
      </div>
      {/* 与任务台同构：中间滚动、账号区钉底（见 globals.css 的 .sidebar-scroll） */}
      <div className="sidebar-scroll">
        <NavList nav={main} />
        {/* 「设置」不在这儿渲染了：2026-08-26 起它收进底部账号菜单
            （components/SidebarUser.tsx），由 TenantShell 传过去 */}
      </div>
      {footer}
    </aside>
  );
}
