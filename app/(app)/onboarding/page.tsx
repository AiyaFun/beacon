import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { readPersona } from '@/lib/persona';
import { HubHeader } from '@/components/HubHeader';
import { getServerLang } from '@/lib/i18n/server';
import { OnboardingWizard } from './OnboardingWizard';
import { isDemoTenant } from '@/lib/demo/guard';
import { Card } from '@/components/ui';
import Link from 'next/link';

export const dynamic = 'force-dynamic';
export const metadata = { title: '十分钟开场 — 烽火台' };

// 十分钟开场向导（2026-09-05）。首次注册直接落到这里；老用户也能重跑（补赛道、补同行）。
export default async function OnboardingPage() {
  const [s, lang] = await Promise.all([getSession(), getServerLang()]);
  const en = lang === 'en';
  if (isDemoTenant(s.tenantId)) {
    return (
      <Card title={en ? 'Demo mode' : '演示模式'} sub={en ? 'The wizard writes to your own workspace' : '向导要往你自己的工作区里写东西'}>
        <Link href="/login" className="btn btn-primary btn-sm">{en ? 'Sign up to run it' : '注册后再跑'}</Link>
      </Card>
    );
  }
  const account = await prisma.creatorAccount.findUnique({ where: { id: s.accountId }, select: { personaCard: true, platform: true, handle: true } });
  const persona = readPersona(account?.personaCard ?? '{}');
  return (
    <>
      <HubHeader
        title={en ? 'Ten-minute start' : '十分钟开场'}
        hint={en ? 'Niche → platforms → one profile link → a few peers → first brief. Eight sources light up as it goes.' : '赛道 → 主战平台 → 一个主页链接 → 几个同行 → 当场出第一份推荐，八个来源逐个点亮'}
        meta={
          <span className="badge badge-brand" style={{ fontSize: 11, padding: '3px 10px' }}>
            {en ? '3-Step Quickstart' : '3步快速建站'}
          </span>
        }
      />
      <div style={{ marginTop: 8 }}>
        <OnboardingWizard
          initial={{ niche: persona.niche ?? '', platforms: persona.platforms ?? [], identity: persona.identity ?? '', handle: account?.handle ?? '' }}
          lang={lang}
        />
      </div>
    </>
  );
}
