import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { readPersona, personaCompleteness } from '@/lib/persona';
import { PageHead } from '@/components/ui';
import { Chat } from './Chat';

export const dynamic = 'force-dynamic';

export default async function AssistantPage() {
  const s = await getSession();
  const [account, memoryCount] = await Promise.all([
    prisma.creatorAccount.findUnique({ where: { id: s.accountId } }),
    prisma.memoryEntry.count({ where: { workspaceId: s.workspaceId, active: true } }),
  ]);

  const persona = readPersona(account?.personaCard ?? '{}');
  const completeness = personaCompleteness(persona);
  const accountName = account?.name ?? '我的账号';

  return (
    <>
      <PageHead
        title="AI 助手"
        desc="选题 / 文案 / 运营随便问，助手带你的账号人设与长期记忆上下文来答"
      />

      <div className="row wrap" style={{ gap: 8, marginBottom: 14 }}>
        <span className="badge badge-brand">当前账号：{accountName}</span>
        <span className="badge badge-gray">人设完善度 {completeness}%</span>
        <span className="badge badge-gray">生效记忆 {memoryCount} 条</span>
        <span className="small muted">
          未配置 API Key 时走 Mock（回答旁会标「Mock」徽章），配置后自动切真实模型。
        </span>
      </div>

      <Chat accountName={accountName} />
    </>
  );
}
