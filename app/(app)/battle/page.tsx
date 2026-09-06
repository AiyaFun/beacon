import { getSession } from '@/lib/session';
import { prisma } from '@/lib/db';
import { readPersona, isPersonaBlank } from '@/lib/persona';

import { buildBattleReport } from '@/lib/battle/report';
import { BattleReport } from '@/components/BattleReport';
import { HubHeader } from '@/components/HubHeader';
import { ShareCard } from '@/components/ShareCard';
import { siteUrl } from '@/lib/brand';
import { getServerLang } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';
export const metadata = { title: '本周作战 — 烽火台' };

// 本周内容作战报告的独立页。渲染主体在 components/BattleReport（与任务台首页共用）。
export default async function BattlePage() {
  const [s, lang] = await Promise.all([getSession(), getServerLang()]);
  const isEn = lang === 'en';
  const account = await prisma.creatorAccount.findUnique({ where: { id: s.accountId }, select: { name: true, personaCard: true } });
  const personaBlank = isPersonaBlank(readPersona(account?.personaCard ?? '{}'));
  const report = await buildBattleReport(s.workspaceId, s.accountId);

  const rawAccountName = account?.name ?? '';
  const accountName = (isEn && (rawAccountName === '我的账号' || !rawAccountName))
    ? 'My Account'
    : (rawAccountName || '我的账号');

  return (
    <>
      <HubHeader
        title={isEn ? 'Weekly Battle' : '本周作战'}
        hint={isEn
          ? `${accountName} · Prioritize this week's tasks with execution entries next to each`
          : `${accountName} · 把这周该做什么排成优先级，每条后面就是执行入口`}
      />
      <BattleReport report={report} personaBlank={personaBlank} />
      {/* 分享图（2026-09-05 增长）：创作者天然会晒数据，这是用户替产品曝光的唯一通道 */}
      <ShareCard report={report} accountName={accountName} site={siteUrl()} lang={lang} />
    </>
  );
}
