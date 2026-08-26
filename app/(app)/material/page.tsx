import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { parseJson } from '@/lib/json';
import { PageHead, Card, Stat } from '@/components/ui';
import { MaterialEditor } from './MaterialEditor';
import type { MaterialItem, MaterialType } from './types';
import { AssetTabs } from '@/components/AssetTabs';
import { HubHeader } from '@/components/HubHeader';

export const dynamic = 'force-dynamic';

export default async function MaterialPage() {
  const s = await getSession();

  const raw = await prisma.material.findMany({
    where: { accountId: s.accountId },
    orderBy: { createdAt: 'desc' },
  });

  const items: MaterialItem[] = raw.map((m) => ({
    id: m.id,
    type: m.type as MaterialType,
    content: m.content,
    tags: parseJson<string[]>(m.tags, []),
    createdAt: m.createdAt.toISOString(),
  }));

  const byType = (t: string) => items.filter((m) => m.type === t).length;

  return (
    <>
      <HubHeader
        title="记忆与素材"
        hint="录入个人经历、案例、观点、口头禅与文风样本——热点人人可抄，经历与语感不可复制"
        tabs={<AssetTabs active="material" inline />}
      />

      <div className="grid grid-5" style={{ marginBottom: 16 }}>
        <Stat label="经历" value={byType('experience')} foot="个人真实故事" />
        <Stat label="案例" value={byType('case')} foot="客户/项目经验" />
        <Stat label="观点" value={byType('opinion')} foot="独到见解立场" />
        <Stat label="口头禅" value={byType('catchphrase')} foot="标志性表达" />
        <Stat label="文风样本" value={byType('sample')} foot="AI 照着它写" />
      </div>

      <Card
        title="素材管理"
        sub="差异化生成原料：生成时可指定注入，推荐选题时自动匹配"
      >
        <MaterialEditor items={items} />
      </Card>
    </>
  );
}
