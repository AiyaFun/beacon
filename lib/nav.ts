import type { IconName } from '@/components/icons';
import { can, type Capability } from '@/lib/edition';

// 导航注册表（信息架构，PRD §5）。模块页面按此路径提供。
export type NavItem = {
  href: string;
  label: string;
  icon: IconName;
  badge?: string;
  /** 需要某项能力才显示。缺省=所有形态都显示。 */
  requires?: Capability;
};
export type NavGroup = { title: string; items: NavItem[] };

export const NAV: NavGroup[] = [
  {
    title: '概览',
    items: [{ href: '/', label: '今日概览', icon: 'home' }],
  },
  {
    title: '情报',
    items: [
      { href: '/hotlists', label: '热点聚合中心', icon: 'fire' },
      { href: '/competitors', label: '竞对监控', icon: 'radar' },
      { href: '/algorithm', label: '平台算法教练', icon: 'gauge' },
    ],
  },
  {
    title: '选题',
    items: [
      { href: '/topics', label: '选题引擎', icon: 'bulb' },
      { href: '/inspiration', label: '灵感收集箱', icon: 'plus' },
      { href: '/library', label: '内容资讯库', icon: 'chart' },
      { href: '/advisor', label: '选题智囊团', icon: 'users' },
    ],
  },
  {
    title: '创作',
    items: [
      { href: '/studio', label: '创作工坊', icon: 'pen' },
      { href: '/compliance', label: '合规检测', icon: 'shield' },
    ],
  },
  {
    title: '资产',
    items: [
      { href: '/persona', label: '人设与记忆', icon: 'user' },
      { href: '/material', label: '素材库', icon: 'edit' },
      { href: '/data', label: '数据看板', icon: 'chart' },
      // ⚠️ 这里曾有一个独立的 /growth「增长追踪」。用户 2026-08-10 明确要求把它
      // 融合进竞对监控、不要单开一页，已整体搬到 /competitors 里的「增长追踪」区块。
      // 别再加回来：同一份数据两个入口，用户只会两边都不知道该看哪个。
      { href: '/genes', label: '爆款基因', icon: 'gauge' },
    ],
  },
  {
    title: '工具',
    items: [
      { href: '/extension', label: '下载采集助手', icon: 'download' },
      { href: '/notifications', label: '机器人与通知', icon: 'chat' },
      { href: '/skills', label: '技能中心', icon: 'sparkles' },
      // 技能是一步，模板是一串——两个入口挨着放，用户才分得清该进哪个
      { href: '/workflows', label: '工作流模板', icon: 'sparkles' },
      { href: '/members', label: '成员与权限', icon: 'users' },
      // 用 sparkles（升级语义）：components/icons.tsx 没有 card/wallet 类图标，那个文件不归本次改动
            // 企业版没有计费面：链接留着的话点进去只会撞上 assertCan('payment') 抛出的错误页。
      { href: '/billing', label: '套餐与计费', icon: 'sparkles', requires: 'payment' },
      // 密钥类全部收在 /settings/keys（模型 Key / 生图 / 公众号发布 / 采集令牌 / 机器人凭据）；
      // /settings 只剩运行类设置。分两条是刻意的：用户找 Key 时不该还要先猜它在哪一页。
      { href: '/settings/keys', label: '接入与密钥', icon: 'cpu' },
      { href: '/settings', label: '运行设置', icon: 'settings' },
      { href: '/settings/account', label: '账号与安全', icon: 'shield' },
      { href: '/feedback', label: '问题反馈与社群支持', icon: 'chat' },
      { href: '/help', label: '使用帮助', icon: 'help' },
    ],
  },
];

/**
 * 按当前部署形态过滤出可见导航。
 *
 * 必须由**服务端**算好再传给侧栏 —— Sidebar 是客户端组件，读不到 process.env.BEACON_EDITION。
 * 想走 NEXT_PUBLIC_ 的话就出现了第二个形态真相源，而两个源迟早会不一致
 * （典型后果：客户机器上侧栏藏了入口，端点却还活着）。
 */
export function visibleNav(): NavGroup[] {
  return NAV.map((g) => ({ ...g, items: g.items.filter((it) => !it.requires || can(it.requires)) }))
    .filter((g) => g.items.length > 0);
}
