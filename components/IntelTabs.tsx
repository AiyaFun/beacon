import Link from 'next/link';

// 「看情报」页顶标签：看热点 / 看同行 / 我存的资料 三处互切（2026-08-26 情报三合一）。
//
// 【为什么是标签不是合并路由】/hotlists 在 app/(public)——游客注册前就能逛热榜，
// 这是拉新入口，不能塞进登录闸；而竞对与资料库必须登录。三个路由都保留，
// 侧栏收成一条「看情报」，跨页由这条标签承担（与「技能 · 连接器」的 RoleTabs 同款）。
// 游客在热榜页点「看同行」会被 middleware 送去登录——和别的登录入口行为一致。
//
// 【为什么不叫「消息渠道」】用户最初提议的名字。但「消息渠道」已经是设置里
// 推送与机器人的名字（/notifications），一词两义正是这轮在清理的东西；
// 且这三样是**情报输入**（外面在发生什么），不是消息推送。沿用工作台组名「看情报」。
const TABS = [
  { key: 'hot', label: '看热点', href: '/hotlists' },
  { key: 'rivals', label: '看同行', href: '/competitors' },
  { key: 'library', label: '我存的资料', href: '/library' },
] as const;

export function IntelTabs({ active, inline }: { active: 'hot' | 'rivals' | 'library'; /** 嵌进 HubHeader 行内时用，去掉整行下边框 */ inline?: boolean }) {
  return (
    <div className={`tabs${inline ? " tabs-inline" : ""}`} style={{ marginBottom: inline ? 0 : 14 }}>
      {TABS.map((t) => (
        <Link key={t.key} href={t.href} className={`tab${t.key === active ? ' active' : ''}`}>
          {t.label}
        </Link>
      ))}
    </div>
  );
}
