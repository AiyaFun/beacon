import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { readPersona, personaCompleteness } from '@/lib/persona';
import { PageHead } from '@/components/ui';
import { AssistantTabs } from './AssistantTabs';
import { availableTools } from '@/lib/agent/run';
import { disabledTools } from '@/lib/agent/tool-config';
import { AGENT_ROLES } from '@/lib/agent/roles';
import { RoleLadder } from '@/components/RoleLadder';
import { listSelectableModels } from '@/lib/llm/selectable';
import { HubHeader } from '@/components/HubHeader';

export const dynamic = 'force-dynamic';

// AI 助手 = 四类干活单位里**会思考的那一个**（见 lib/agent/roles.ts）。
// 能力/技能/智能体都由别人决定怎么做，只有它自己决定该用哪几样。
//
// 【这一页在两种外壳下编排不同，但路由是同一个】
//   · 工作台：标准页面（PageHead + 徽章 + 页签），跟别的板块一致。
//   · 任务台：输入框必须**上屏第一眼**。任务台承诺的是「说一句话让它干活」，
//     而把主角压到标题、三个徽章、一行 Mock 说明后面，等于承诺没兑现。
// 这不是新路由，也不是两份实现——同一批组件，换的是外面那层壳给不给标题区。
export default async function AssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string; goal?: string }>;
}) {
  const s = await getSession();
  const { run, goal } = await searchParams;
  const [account, memoryCount, ws, waiting, models] = await Promise.all([
    prisma.creatorAccount.findUnique({ where: { id: s.accountId } }),
    prisma.memoryEntry.count({ where: { workspaceId: s.workspaceId, active: true } }),
    // 被关掉的能力不该出现在助手的清单里——列了却调不动，比不列更让人困惑
    prisma.workspace.findUnique({ where: { id: s.workspaceId }, select: { agentToolConfig: true } }),
    // 停在「等你确认」的那次执行。**只查发起人自己的**：确认是用发起人的权限做事，
    // 别人替他点等于用他的权限做他没同意的事（decidePendingCall 里也拦了一道）。
    prisma.agentRun.findFirst({
      where: { workspaceId: s.workspaceId, memberId: s.memberId, status: 'awaiting_confirm' },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, goal: true },
    }),
    // 「这次用哪个模型」的候选：自动 / 自接入(BYOK) / 外接入(平台垫付)
    listSelectableModels(s.tenantId),
  ]);

  const persona = readPersona(account?.personaCard ?? '{}');
  const completeness = personaCompleteness(persona);
  const accountName = account?.name ?? '我的账号';
  // 已经打开的就是那一条时不再提示——一条指着当前页面的「去处理」是纯噪音
  const resume = waiting && waiting.id !== run ? waiting : null;

  return (
    <>

      {resume && (
        // 死胡同的出口：一次执行停在「等你确认」时，如果不给这条，用户只有在
        // 运行中心翻到那一行才回得来——而在此之前他会以为「那件事 AI 没做」
        <div className="alert-gradient-amber" style={{ padding: '10px 14px', marginBottom: 12 }}>
          <span className="small" style={{ opacity: 0.9, lineHeight: 1.7 }}>
            ⏸ 有一次执行停在「等你确认」：<b>{resume.goal.slice(0, 40)}</b>
            {resume.goal.length > 40 ? '…' : ''}{' '}
            <Link href={`/assistant?run=${resume.id}`} className="btn btn-sm" style={{ marginLeft: 8 }}>
              继续处理 →
            </Link>
          </span>
        </div>
      )}


      <AssistantTabs
        accountName={accountName}
        models={models}
        tools={availableTools(s.role, disabledTools(ws?.agentToolConfig))}
        initialRunId={run ?? null}
        initialGoal={goal ? goal.slice(0, 2000) : null}
      />

      {/* 分工梯放在最下面，不放页顶：这一页的主角是输入框，把四张解释卡摆在它前面
          就又变回「先读一屏说明才能开始干活」。放这儿的作用是——用户看完 AI 干的活之后，
          知道那三样各自在哪、什么时候该自己直接去点 */}
      <div style={{ marginTop: 18 }}>
        <p className="small muted" style={{ marginBottom: 8 }}>
          它会自己挑下面这三样来用；你也可以直接去用其中任何一样：
        </p>
        <RoleLadder here="assistant" />
      </div>
    </>
  );
}
