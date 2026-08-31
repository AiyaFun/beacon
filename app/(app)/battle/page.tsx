import { getSession } from '@/lib/session';
import { prisma } from '@/lib/db';
import { readPersona, isPersonaBlank } from '@/lib/persona';

import { buildBattleReport } from '@/lib/battle/report';
import { BattleReport } from '@/components/BattleReport';
import { HubHeader } from '@/components/HubHeader';

export const dynamic = 'force-dynamic';
export const metadata = { title: '本周作战 — 烽火台' };

// 本周内容作战报告的独立页。渲染主体在 components/BattleReport（与任务台首页共用）。
export default async function BattlePage() {
  const s = await getSession();
  const account = await prisma.creatorAccount.findUnique({ where: { id: s.accountId }, select: { name: true, personaCard: true } });
  const personaBlank = isPersonaBlank(readPersona(account?.personaCard ?? '{}'));
  const report = await buildBattleReport(s.workspaceId, s.accountId);

  return (
    <>
      <HubHeader
        title="本周作战"
        hint={`${account?.name ?? '我的账号'} · 把这周该做什么排成优先级，每条后面就是执行入口`}
      />
      <BattleReport report={report} personaBlank={personaBlank} />
    </>
  );
}
