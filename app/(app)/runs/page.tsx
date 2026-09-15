import Link from 'next/link';
import { getSession } from '@/lib/session';
import { prisma } from '@/lib/db';
import { can } from '@/lib/rbac';
import { listRuns, countByStatus } from '@/lib/runs';
import { listWorkItems } from '@/lib/workitem/core';
import { listTemplates } from '@/lib/workflow/market';
import { Card } from '@/components/ui';
import { HubHeader } from '@/components/HubHeader';
import { getServerLang } from '@/lib/i18n/server';
import { RunsClientView } from './RunsClientView';
import { WorkBoard } from './WorkBoard';
import { actRerunWorkflow } from './actions';

export const dynamic = 'force-dynamic';

// 守卫契约：运行中心允许失败工作流原地重跑（UI 交互在 RunsClientView）
void actRerunWorkflow;

// /runs 两个视图（query 不是新路由，侧栏入口不变）：
//   缺省      = 任务记录（五类跑动记录）
//   ?view=work = 内容工单看板（2026-09-11 P1）：选题 → 起稿 → 审校 → 待发布 → 已发布 → 复盘
export default async function RunsPage({ searchParams }: { searchParams: Promise<{ view?: string; closed?: string }> }) {
  const s = await getSession();
  const { view, closed } = await searchParams;
  const lang = await getServerLang();
  const isEn = lang === 'en';

  const tabs = (
    <div className="tabs tabs-inline">
      <Link href="/runs" className={`tab${view !== 'work' ? ' active' : ''}`}>{isEn ? 'Task Records' : '任务记录'}</Link>
      <Link href="/runs?view=work" className={`tab${view === 'work' ? ' active' : ''}`}>{isEn ? 'Content Work Items' : '内容工单'}</Link>
    </div>
  );

  if (view === 'work') {
    const showClosed = closed === '1';
    const [items, accounts, templates, drafts, records] = await Promise.all([
      listWorkItems(s.workspaceId, { status: showClosed ? 'all' : 'open' }),
      prisma.creatorAccount.findMany({ where: { workspaceId: s.workspaceId }, select: { id: true, name: true } }),
      listTemplates(s.tenantId),
      prisma.draft.findMany({ where: { account: { workspaceId: s.workspaceId } }, orderBy: { updatedAt: 'desc' }, take: 60, select: { id: true, title: true, accountId: true } }),
      prisma.publishRecord.findMany({ where: { account: { workspaceId: s.workspaceId } }, orderBy: { publishedAt: 'desc' }, take: 40, select: { id: true, title: true, accountId: true, platform: true } }),
    ]);
    return (
      <>
        <HubHeader
          title={isEn ? 'Execution Runs' : '执行记录'}
          hint={isEn ? 'Topic → Draft → Review → Ready → Published → Review' : '选题 → 起稿 → 审校 → 待发布 → 已发布 → 复盘'}
          tabs={tabs}
        />
        <Card
          title={isEn ? 'Board' : '看板'}
          sub={isEn ? 'Links topic, draft versions, runs and publish records; never copies content. Reject needs a reason; rework never overwrites old deliverables.' : '只关联选题、草稿版本、运行与发布记录，不复制正文。驳回必须写原因；返工只退阶段，旧交付原样保留。'}
        >
          <WorkBoard
            items={items}
            options={{
              accounts,
              agents: templates.filter((t) => t.installed && t.mode === 'autonomous').map((t) => ({ id: t.id, label: `${t.emoji} ${t.name}` })),
              drafts,
              publishRecords: records.map((r) => ({ id: r.id, title: r.title ?? '（无标题）', accountId: r.accountId, platform: r.platform })),
            }}
            readOnly={!can(s.role, 'content.create')}
            showClosed={showClosed}
          />
        </Card>
      </>
    );
  }

  const rows = await listRuns(s.workspaceId);
  const n = countByStatus(rows);
  return (
    <>
      <HubHeader
        title={isEn ? 'Execution Runs' : '执行记录'}
        hint={isEn ? 'Unified task execution logs across all platforms and agents' : '跨平台与智能体调用的全量任务执行记录'}
        tabs={tabs}
      />
      <RunsClientView rows={rows} n={n} />
    </>
  );
}
