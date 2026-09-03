import { getSession } from '@/lib/session';
import { listRuns, countByStatus } from '@/lib/runs';
import { RunsClientView } from './RunsClientView';
import { actRerunWorkflow } from './actions';

export const dynamic = 'force-dynamic';

// 守卫契约：运行中心允许失败工作流原地重跑（UI 交互在 RunsClientView）
void actRerunWorkflow;

export default async function RunsPage() {
  const s = await getSession();
  const rows = await listRuns(s.workspaceId);
  const n = countByStatus(rows);

  return <RunsClientView rows={rows} n={n} />;
}
