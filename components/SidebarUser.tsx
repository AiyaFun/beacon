'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { Icon } from './icons';
import type { NavGroup } from '@/lib/nav';
import { Icon as NavIcon } from './icons';
import { useI18n } from '@/lib/i18n';

// 侧栏底部的账号区（2026-08-26，用户要求「把账号信息、工作台切换、退出往下放」，
// 版式照他给的豆包工作左下角）。
export function SidebarUser({
  memberName,
  planLabel,
  isPlatformAdmin,
  settings,
  logout,
  version,
}: {
  memberName: string;
  planLabel: string;
  isPlatformAdmin: boolean;
  settings?: NavGroup | null;
  /** 退出的 server action，由服务端组件传进来（客户端组件不能自己 import 它） */
  logout: () => Promise<void>;
  /** 应用版本号（package.json，服务端读好传入），显示在退出登录上方 */
  version?: string;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const { lang, dict } = useI18n();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  function getPlanDisplay(rawPlan: string): string {
    if (lang === 'zh') return rawPlan;
    if (rawPlan.includes('免')) return dict.shell.freePlan;
    if (rawPlan.includes('试')) return dict.shell.trialPlan;
    if (rawPlan.includes('专')) return dict.shell.proPlan;
    if (rawPlan.includes('团')) return dict.shell.teamPlan;
    if (rawPlan.includes('企')) return dict.shell.enterprisePlan;
    return rawPlan;
  }

  return (
    <div className="sidebar-user" ref={boxRef}>
      {open && (
        <div className="sidebar-user-menu">
          {settings && settings.items.length > 0 && (
            <>
              <div className="sidebar-user-section">
                {lang === 'en' ? dict.nav.groups.settings : settings.title}
              </div>
              {settings.items.map((it) => {
                const IconCmp = NavIcon[it.icon];
                const navInfo = dict.nav.items[it.href as keyof typeof dict.nav.items];
                const displayLabel = navInfo ? navInfo.label : it.label;
                const displayHint = navInfo && navInfo.hint ? navInfo.hint : it.hint;
                return (
                  <Link key={it.href} href={it.href} className="sidebar-user-item" onClick={() => setOpen(false)} title={displayHint}>
                    <IconCmp size={13} /> {displayLabel}
                  </Link>
                );
              })}
            </>
          )}
          {isPlatformAdmin && (
            <Link href="/ops" className="sidebar-user-item" onClick={() => setOpen(false)}>
              <Icon.shield size={13} /> {dict.shell.opsConsole}
            </Link>
          )}
          {version && (
            <div className="sidebar-user-version">
              {lang === 'en' ? 'Beacon' : '烽火台'} v{version}
            </div>
          )}
          <form action={logout}>
            <button type="submit" className="sidebar-user-item sidebar-user-logout">
              <Icon.upload size={13} /> {lang === 'en' ? dict.shell.logout : '退出登录'}
            </button>
          </form>
        </div>
      )}
      <button
        type="button"
        className="sidebar-user-trigger"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="persona-avatar sidebar-user-avatar">{memberName.slice(0, 1)}</span>
        <span className="sidebar-user-meta">
          <span className="sidebar-user-name">{memberName}</span>
          <span className="sidebar-user-plan">{getPlanDisplay(planLabel)}</span>
        </span>
        <Icon.chevron size={13} />
      </button>
    </div>
  );
}
