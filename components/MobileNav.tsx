'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import Image from 'next/image';
import { Icon } from './icons';
import { NavList } from './Sidebar';
import type { NavGroup } from '@/lib/nav';

import { useI18n } from '@/lib/i18n';

// 720px 以下的抽屉式导航：汉堡按钮 + 遮罩 + 左滑入侧栏。
// 桌面端三个元素都被 CSS 默认隐藏（.nav-burger/.drawer/.drawer-overlay），不参与布局。
export function MobileNav({ nav }: { nav: NavGroup[] }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const { lang } = useI18n();

  // 点导航项跳转后自动收起，避免遮罩留在新页面上
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // 视口拉回桌面宽度时自动收起，避免遮罩和滚动锁遗留（断点与 globals.css 的 720px 一致）
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 721px)');
    const onChange = () => {
      if (mq.matches) setOpen(false);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // 打开时锁住背景滚动；Esc 也能关
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="nav-burger"
        aria-label={open ? (lang === 'en' ? 'Close menu' : '关闭导航菜单') : (lang === 'en' ? 'Open menu' : '打开导航菜单')}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <Icon.x />
        ) : (
          <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        )}
      </button>
      <div className="drawer-overlay" style={{ display: open ? 'block' : 'none' }} onClick={() => setOpen(false)} aria-hidden="true" />
      <aside
        className={`drawer${open ? ' open' : ''}`}
        aria-hidden={!open}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('a')) setOpen(false);
        }}
      >
        <div className="brand">
          <Image src="/logo.png" alt={lang === 'en' ? 'Beacon' : '烽火台'} width={36} height={36} className="brand-logo-img" />
          <div>
            <div className="brand-name">{lang === 'en' ? 'Beacon' : '烽火台'}</div>
            <div className="brand-sub">{lang === 'en' ? 'Content Ops Deck' : '跨平台内容作战室'}</div>
          </div>
        </div>
        <NavList nav={nav} />
      </aside>
    </>
  );
}
