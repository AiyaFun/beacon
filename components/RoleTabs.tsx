import Link from 'next/link';
import { AGENT_ROLES } from '@/lib/agent/roles';

// 「班底」页顶标签：技能 / 智能体 / 能力 三处互切（2026-08-25 班底 3→1 合并）。
//
// 【为什么是标签不是合并路由】三页合一被证据否掉过（roles.test 钉死四类独立入口、
// Notification.link 持久化、PresetCards 直接 import workflows 目录）——详见记忆
// beacon-battle-report 豆包对照节。侧栏收成一个入口后，跨页导航由这条标签承担：
// 用户点「技能」进来，页顶一眼看到另外两类在哪，一次点击即达。
// 与 RoleLadder 不重复：分工梯回答「四类有什么区别」，这条回答「另外两类怎么去」。
const TABS = [
  { key: 'skill', label: AGENT_ROLES.skill.name, href: '/skills' },
  { key: 'agent', label: AGENT_ROLES.agent.name, href: '/workflows' },
  { key: 'ability', label: AGENT_ROLES.ability.name, href: AGENT_ROLES.ability.href },
] as const;

export function RoleTabs({ active, inline }: { active: 'skill' | 'agent' | 'ability'; /** 嵌进 HubHeader 行内时用，去掉整行下边框 */ inline?: boolean }) {
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
