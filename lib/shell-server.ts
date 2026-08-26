import 'server-only';
import { NAV } from '@/lib/nav';
import { can } from '@/lib/edition';
import type { NavGroup } from '@/lib/nav';

// 单壳化（2026-08-26）后这里只剩一件事：按部署形态过滤导航（企业版不显示计费）。
// 必须服务端算——Sidebar 是客户端组件，读不到 BEACON_EDITION。
// currentShell / cookie 机制已随工作台一起退役。
export function visibleTaskNav(): NavGroup[] {
  return NAV.map((g) => ({ ...g, items: g.items.filter((it) => !it.requires || can(it.requires)) }))
    .filter((g) => g.items.length > 0);
}
