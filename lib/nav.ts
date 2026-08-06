import type { IconName } from '@/components/icons';

// 导航注册表（信息架构，PRD §5）。模块页面按此路径提供。
export type NavItem = { href: string; label: string; icon: IconName; badge?: string };
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
      { href: '/genes', label: '爆款基因', icon: 'gauge' },
    ],
  },
  {
    title: '工具',
    items: [
      { href: '/extension', label: '下载采集助手', icon: 'download' },
      { href: '/notifications', label: '机器人与通知', icon: 'chat' },
      { href: '/skills', label: '技能中心', icon: 'sparkles' },
      { href: '/members', label: '成员与权限', icon: 'users' },
      // 用 sparkles（升级语义）：components/icons.tsx 没有 card/wallet 类图标，那个文件不归本次改动
      { href: '/billing', label: '套餐与计费', icon: 'sparkles' },
      { href: '/settings', label: '模型与设置', icon: 'settings' },
      { href: '/settings/account', label: '账号与安全', icon: 'shield' },
      { href: '/feedback', label: '问题反馈与社群支持', icon: 'chat' },
      { href: '/help', label: '使用帮助', icon: 'help' },
    ],
  },
];
