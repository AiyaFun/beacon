'use client';

import Link from 'next/link';
import { AGENT_ROLE_LIST, type AgentRoleKey } from '@/lib/agent/roles';
import { useI18n } from '@/lib/i18n';

const ROLE_I18N: Record<AgentRoleKey, { name: string; oneLine: string; decidedBy: string }> = {
  ability: {
    name: 'Abilities',
    oneLine: 'Atomic primitives (search, scrape, publish)',
    decidedBy: 'Program Code',
  },
  skill: {
    name: 'Skills',
    oneLine: 'Prompt templates + output schemas',
    decidedBy: 'Human Prompt',
  },
  agent: {
    name: 'Agents',
    oneLine: 'Fixed pipelines with branch logic',
    decidedBy: 'Preset Pipeline',
  },
  assistant: {
    name: 'AI Assistant',
    oneLine: 'Autonomous co-pilot choosing and running tools',
    decidedBy: 'LLM Reasoning',
  },
};

export function RoleLadder({ here }: { here: AgentRoleKey }) {
  const { lang } = useI18n();

  return (
    <div className="role-ladder">
      {AGENT_ROLE_LIST.map((r) => {
        const active = r.key === here;
        const i18nItem = ROLE_I18N[r.key];
        const name = lang === 'en' ? i18nItem.name : r.name;
        const oneLine = lang === 'en' ? i18nItem.oneLine : r.oneLine;
        const decidedBy = lang === 'en' ? i18nItem.decidedBy : r.decidedBy;
        const prefix = lang === 'en' ? 'Decided by: ' : '怎么做由：';

        const body = (
          <>
            <b className="role-name">{name}</b>
            <span className="small muted role-one">{oneLine}</span>
            <span className="small muted role-by">{prefix}{decidedBy}</span>
          </>
        );
        return active ? (
          <div key={r.key} className="role-cell active" aria-current="true">
            {body}
          </div>
        ) : (
          <Link key={r.key} href={r.href} className="role-cell">
            {body}
          </Link>
        );
      })}
    </div>
  );
}
