'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { NAV } from '@/lib/nav';
import { Icon } from './icons';

// 导航列表本体：桌面侧栏与移动端抽屉（MobileNav）共用，保证两端条目完全一致
export function NavList() {
  const pathname = usePathname();
  return (
    <nav>
      {NAV.map((group) => (
        <div className="nav-group" key={group.title}>
          <div className="nav-group-title">{group.title}</div>
          {group.items.map((item) => {
            const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
            const IconCmp = Icon[item.icon];
            return (
              <Link href={item.href} key={item.href} className={`nav-item${active ? ' active' : ''}`}>
                <IconCmp className="ic" />
                <span>{item.label}</span>
                {item.badge && <span className="nav-badge">{item.badge}</span>}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="brand">
        <Image src="/logo.png" alt="烽火台" width={36} height={36} className="brand-logo-img" />
        <div>
          <div className="brand-name">烽火台</div>
          <div className="brand-sub">跨平台内容作战室</div>
        </div>
      </div>
      <NavList />
    </aside>
  );
}
