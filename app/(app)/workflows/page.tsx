import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { PageHead, Card, Stat } from '@/components/ui';
import { can } from '@/lib/rbac';
import { listTemplates } from '@/lib/workflow/market';
import { fmtDateTime } from '@/lib/format';
import { parseJson } from '@/lib/json';
import { WorkflowMarket } from './WorkflowMarket';
import type { StepLog } from '@/lib/workflow/run';

export const dynamic = 'force-dynamic';

// 工作流模板：把「选题→初稿→技能→封面→配图→发布计划」串成一条可复用的流水线。
// 与技能中心的分工写在页面上，别让用户猜：技能是一步，模板是一串。
export default async function WorkflowsPage() {
  const s = await getSession();
  const [templates, recentRuns] = await Promise.all([
    listTemplates(s.tenantId),
    prisma.workflowRun.findMany({
      where: { workspaceId: s.workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 8,
      include: { template: { select: { name: true, emoji: true } } },
    }),
  ]);

  const installed = templates.filter((t) => t.installed);

  return (
    <>
      <PageHead
        title="工作流模板"
        desc="一条模板 = 一串已有能力按顺序跑完 · 技能是一步，模板是一串"
      />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="可用模板" value={installed.length} foot={`市场里共 ${templates.length} 条`} />
        <Stat label="内置模板" value={templates.filter((t) => t.isBuiltin).length} foot="全租户可见" />
        <Stat label="我建的" value={templates.filter((t) => !t.isBuiltin).length} foot="可导出分享" />
        <Stat label="最近运行" value={recentRuns.length} foot="近 8 次" />
      </div>

      <WorkflowMarket templates={templates} readOnly={!can(s.role, 'content.create')} />

      <Card title="最近运行" sub="每一步的结果都留痕：失败时能看出停在哪一步、为什么" style={{ marginTop: 16 }}>
        {recentRuns.length === 0 ? (
          <p className="small muted">还没有跑过模板。</p>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {recentRuns.map((r) => {
              const logs = parseJson<StepLog[]>(r.log, []);
              return (
                <div key={r.id} className="small">
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span className="muted">{fmtDateTime(r.createdAt)}</span>
                    <strong>{r.template.emoji} {r.template.name}</strong>
                    <span className={`badge ${r.status === 'done' ? 'badge-green' : r.status === 'failed' ? 'badge-red' : 'badge-gray'}`}>
                      {r.status === 'done' ? '跑完了' : r.status === 'failed' ? '中途停下' : r.status}
                    </span>
                  </div>
                  <ol style={{ margin: '4px 0 0', paddingLeft: 20 }}>
                    {logs.map((l, i) => (
                      <li key={i} style={{ color: l.ok ? 'inherit' : 'var(--red)' }}>
                        {l.label} — {l.message}
                      </li>
                    ))}
                  </ol>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </>
  );
}
