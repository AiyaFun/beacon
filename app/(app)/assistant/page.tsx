import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { readPersona, personaCompleteness } from '@/lib/persona';
import { PageHead } from '@/components/ui';
import { AssistantTabs } from './AssistantTabs';
import { availableTools } from '@/lib/agent/run';
import { disabledTools } from '@/lib/agent/tool-config';

import { RoleLadder } from '@/components/RoleLadder';
import { listSelectableModels } from '@/lib/llm/selectable';
import { getServerLang } from '@/lib/i18n/server';
import { getDictionary } from '@/lib/i18n/dict';

export const dynamic = 'force-dynamic';

export default async function AssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string; goal?: string }>;
}) {
  const s = await getSession();
  const lang = await getServerLang();
  const dict = getDictionary(lang);
  const { run, goal } = await searchParams;
  // 派活的框只在首页「今天」（2026-09-06）。老链接 /assistant?goal=… 送回首页预填，仍然只预填不开跑
  if (goal) redirect(`/?goal=${encodeURIComponent(goal.slice(0, 2000))}`);
  const [account, memoryCount, ws, waiting, models] = await Promise.all([
    prisma.creatorAccount.findUnique({ where: { id: s.accountId } }),
    prisma.memoryEntry.count({ where: { workspaceId: s.workspaceId, active: true } }),
    prisma.workspace.findUnique({ where: { id: s.workspaceId }, select: { agentToolConfig: true } }),
    prisma.agentRun.findFirst({
      where: { workspaceId: s.workspaceId, memberId: s.memberId, status: 'awaiting_confirm' },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, goal: true },
    }),
    listSelectableModels(s.tenantId, lang),
  ]);

  const persona = readPersona(account?.personaCard ?? '{}');
  const completeness = personaCompleteness(persona);
  const rawAccountName = account?.name ?? '';
  const accountName = (lang === 'en' && (rawAccountName === '我的账号' || !rawAccountName))
    ? 'My Account'
    : (rawAccountName || '我的账号');
  const resume = waiting && waiting.id !== run ? waiting : null;

  return (
    <>
      {resume && (
        <div className="alert-gradient-amber" style={{ padding: '10px 14px', marginBottom: 12 }}>
          <span className="small" style={{ opacity: 0.9, lineHeight: 1.7 }}>
            {lang === 'en' ? '⏸ A run is awaiting your confirmation: ' : '⏸ 有一次执行停在「等你确认」：'}
            <b>{resume.goal.slice(0, 40)}</b>
            {resume.goal.length > 40 ? '…' : ''}{' '}
            <Link href={`/assistant?run=${resume.id}`} className="btn btn-sm" style={{ marginLeft: 8 }}>
              {lang === 'en' ? 'Resume Processing →' : '继续处理 →'}
            </Link>
          </span>
        </div>
      )}

      <AssistantTabs
        accountName={accountName}
        models={models}
        tools={availableTools(s.role, disabledTools(ws?.agentToolConfig))}
        initialRunId={run ?? null}
      />

      <div style={{ marginTop: 18 }}>
        <p className="small muted" style={{ marginBottom: 8 }}>
          {lang === 'en'
            ? 'It automatically orchestrates tools below; you can also access any directly:'
            : '它会自己挑下面这三样来用；你也可以直接去用其中任何一样：'}
        </p>
        <RoleLadder here="assistant" />
      </div>
    </>
  );
}
