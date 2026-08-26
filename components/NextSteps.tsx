'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { activeHref, nextSteps, type NavGroup } from '@/lib/nav';
import { Icon } from './icons';

// 「这一步做完，接着做什么」——独立成条，给**任务台**用。
//
// 【为什么必须单独有它】这段引导原本长在 StageTabs 里（阶段页签末尾那一跳），
// 而任务台不渲染阶段页签——于是切到任务台的用户把整条工作流链路全丢了：
// 写完稿不知道该去查合规、发完不知道要贴链接数据才会回流。
// 那条链路是这个产品最值钱的东西之一，不能因为换了个壳就消失。
//
// 【与阶段页签的区别】页签里那段会**过滤掉同阶段的**（同组的板块就在旁边，不用再指一遍）；
// 这里不过滤——任务台里根本没有「阶段」这个概念，旁边也没有那一排板块，
// 所以下一步该去哪儿要说全。
export function NextSteps({ nav }: { nav: NavGroup[] }) {
  const pathname = usePathname();
  const steps = nextSteps(activeHref(nav, pathname) ?? '');
  if (steps.length === 0) return null;

  return (
    <div className="next-bar">
      <span className="small muted next-bar-lead">接下来</span>
      {steps.map((s) => (
        <span className="stage-next-wrap" key={s.href}>
          {/* 理由直接写出来，不放 title：气泡要悬停才出现，等于没写 */}
          <span className="small muted stage-why">{s.why}</span>
          <Link href={s.href} className="stage-tab stage-next">
            {s.label} <Icon.arrow size={13} />
          </Link>
        </span>
      ))}
    </div>
  );
}
