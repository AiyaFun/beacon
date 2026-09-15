'use client';

import Link from 'next/link';
import { AGENT_ROLES } from '@/lib/agent/roles';
import { useI18n } from '@/lib/i18n';

export function RoleTabs({ active, inline }: { active: 'skill' | 'agent' | 'ability'; inline?: boolean }) {
  const { lang } = useI18n();

  const tabs = [
    { key: 'skill', label: lang === 'en' ? 'Skills' : AGENT_ROLES.skill.name, href: '/skills' },
    { key: 'agent', label: lang === 'en' ? 'Agents & Tasks' : `${AGENT_ROLES.agent.name}与定时任务`, href: '/workflows' },
    { key: 'ability', label: lang === 'en' ? 'Abilities' : AGENT_ROLES.ability.name, href: AGENT_ROLES.ability.href },
  ] as const;

  return (
    <div className={`tabs${inline ? " tabs-inline" : ""}`} style={{ marginBottom: inline ? 0 : 14 }}>
      {tabs.filter((t) => t.key !== 'ability' || active === 'ability').map((t) => (
        <Link key={t.key} href={t.href} className={`tab${t.key === active ? ' active' : ''}`}>
          {t.label}
        </Link>
      ))}
    </div>
  );
}
