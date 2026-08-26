'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { activeHref, groupOf, nextSteps, type NavGroup } from '@/lib/nav';
import { Icon } from './icons';

// 阶段页签：**同一个阶段的功能板块摆在一起**，页面顶部一排。
//
// 【解决的问题】板块以前各是各的一页，从「数据看板」看不到旁边还有「爆款基因」「算法教练」，
// 于是同一件事（复盘）被拆成三次寻找。现在进到这个阶段就把它的板块全列出来，
// 顺序就是这一段的做事顺序，最后接一条「下一阶段」——一条链路走到底。
//
// 【为什么是路由跳转而不是同页面板】这些板块每一个都要各自查库（有的还很重）。
// 塞进一个页面等于每次进来都跑完全部查询，慢且没必要；而且深链、后退、书签、
// 机器人推送里的地址全都还指着原来的路径——页签是路由，这些一个都不会坏。
export function StageTabs({ nav }: { nav: NavGroup[] }) {
  const pathname = usePathname();
  const group = groupOf(nav, pathname);
  if (!group) return null; // 装机向导之类不属于任何阶段的页面
  const active = activeHref(nav, pathname);
  const forward = nextSteps(active ?? '').filter((s) => !group.items.some((i) => i.href === s.href));

  return (
    <div className="stage-bar">
      <div className="stage-head">
        <span className="stage-name">{group.title}</span>
        <span className="small muted">{group.purpose}</span>
      </div>
      <div className="stage-tabs" role="tablist">
        {group.items.map((it) => {
          const IconCmp = Icon[it.icon];
          const on = it.href === active;
          return (
            <Link
              key={it.href}
              href={it.href}
              role="tab"
              aria-selected={on}
              className={`stage-tab${on ? ' active' : ''}`}
            >
              <IconCmp size={14} />
              {it.label}
            </Link>
          );
        })}
        {/* 跨阶段的那一跳：链路不在阶段内部结束 */}
        {forward.map((s) => (
          <span className="stage-next-wrap" key={s.href}>
            {/* 理由写出来，不放 title：气泡要悬停才出现，等于没写 */}
            <span className="small muted stage-why">{s.why}</span>
            <Link href={s.href} className="stage-tab stage-next">
              {s.label} <Icon.arrow size={13} />
            </Link>
          </span>
        ))}
      </div>
    </div>
  );
}
