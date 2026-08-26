'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { Icon } from './icons';
import type { NavGroup } from '@/lib/nav';
import { Icon as NavIcon } from './icons';

// 侧栏底部的账号区（2026-08-26，用户要求「把账号信息、工作台切换、退出往下放」，
// 版式照他给的豆包工作左下角）。
//
// 【为什么从顶栏搬下来】顶栏原本挤着七样东西（套餐/账号/切换器/模型状态/运维台/通知/用户名/退出），
// 其中**账号级**的那几样（我是谁、用哪种排法、退出）跟「这一页在干什么」毫无关系，
// 占着最显眼的位置却一天点不了一次。沉到侧栏底部之后顶栏只剩当前工作上下文。
//
// 【⚠️ 退出在手机上必须另有出口】手机端 `.sidebar { display:none }`，这一块整个不在。
// globals.css 里那段注释记着旧伤：「顶栏右侧（通知铃 + 退出）必须始终在屏内」——
// 所以 Topbar 保留了一个 `show-mobile` 的退出按钮，两边不是重复，是各管一种屏。
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
  /**
   * 「设置」那一组（接入与密钥 / 运行设置 / …）。2026-08-26 用户要求收进这个菜单——
   * 它们是一天点不了一次的东西，占着侧栏一整块不值。
   * 数据仍来自 TASK_NAV/NAV（已按形态过滤），所以「每个板块都到得了」的对等守卫照旧成立：
   * 守卫看的是导航数据，不是渲染在哪一层。
   */
  settings?: NavGroup | null;
  /** 退出的 server action，由服务端组件传进来（客户端组件不能自己 import 它） */
  logout: () => Promise<void>;
  /** 应用版本号（package.json，服务端读好传入），显示在退出登录上方 */
  version?: string;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="sidebar-user" ref={boxRef}>
      {open && (
        <div className="sidebar-user-menu">
          {settings && settings.items.length > 0 && (
            <>
              <div className="sidebar-user-section">{settings.title}</div>
              {settings.items.map((it) => {
                const IconCmp = NavIcon[it.icon];
                return (
                  <Link key={it.href} href={it.href} className="sidebar-user-item" onClick={() => setOpen(false)} title={it.hint}>
                    <IconCmp size={13} /> {it.label}
                  </Link>
                );
              })}
            </>
          )}
          {/* ⚠️ 这里**不再**单列「账号与安全」——它就在上面那组设置里。
              单列一条等于同一个去处在同一个菜单里出现两次（用户 2026-08-26 反复指出的重复）。 */}
          {isPlatformAdmin && (
            <Link href="/ops" className="sidebar-user-item" onClick={() => setOpen(false)}>
              <Icon.shield size={13} /> 运维台（跨租户）
            </Link>
          )}
          {/* 版本号放退出上方（2026-08-26 用户指定位置）：报障时让用户念得出自己在哪个版本 */}
          {version && <div className="sidebar-user-version">烽火台 v{version}</div>}
          <form action={logout}>
            <button type="submit" className="sidebar-user-item sidebar-user-logout">
              <Icon.upload size={13} /> 退出登录
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
          <span className="sidebar-user-plan">{planLabel}</span>
        </span>
        <Icon.chevron size={13} />
      </button>
    </div>
  );
}
