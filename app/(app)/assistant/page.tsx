import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { AgentPanel } from './AgentPanel';
import { availableTools } from '@/lib/agent/run';
import { disabledTools } from '@/lib/agent/tool-config';
import { RoleLadder } from '@/components/RoleLadder';
import { getServerLang } from '@/lib/i18n/server';
import { Icon } from '@/components/icons';

export const dynamic = 'force-dynamic';

// 执行过程页（2026-09-06 起只剩这一件事）。
//
// 【这一页没有输入框】派活与问答都在首页「今天」的那一框里（components/TaskDeckHome.tsx）：
// 「开始执行」派活、「先问问」对话，答案就在框下面。此前这里还有一个「问 AI」页签，
// 与首页那个框一字不差，用户第四次问「是不是重复了」。
// 这里只做：看某一次执行的过程、确认、追问、终止、接着跑。入口是 ?run=——
// 首页派完的「看执行过程 →」、任务记录、🔔 通知都带着 run 过来。

export default async function AssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string; goal?: string }>;
}) {
  const s = await getSession();
  const lang = await getServerLang();
  const isEn = lang === 'en';
  const { run, goal } = await searchParams;
  // 派活的框只在首页「今天」（2026-09-06）。老链接 /assistant?goal=… 送回首页预填，仍然只预填不开跑
  if (goal) redirect(`/?goal=${encodeURIComponent(goal.slice(0, 2000))}`);
  const [ws, waiting] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: s.workspaceId }, select: { agentToolConfig: true } }),
    prisma.agentRun.findFirst({
      where: { workspaceId: s.workspaceId, memberId: s.memberId, status: 'awaiting_confirm' },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, goal: true },
    }),
  ]);

  const resume = waiting && waiting.id !== run ? waiting : null;

  return (
    <div className="assistant-page-container">
      <div className="row-between wrap" style={{ gap: 10, marginBottom: 12 }}>
        <div>
          <h1 style={{ fontSize: 20, margin: 0 }}>{isEn ? 'Execution View' : '执行过程'}</h1>
          <p className="small muted" style={{ margin: '4px 0 0' }}>
            {isEn
              ? 'Follow one run: what it called, where it is waiting for you, what it finished. To start or ask something, use the box on Today.'
              : '看某一次执行：它调了什么、停在哪等你、最后做成了什么。要派活或问一句，回「今天」那个框。'}
          </p>
        </div>
        <span className="row" style={{ gap: 8 }}>
          <Link href="/" className="btn btn-sm btn-primary"><Icon.home size={13} /> {isEn ? 'Today' : '回「今天」'}</Link>
          <Link href="/runs" className="btn btn-sm">{isEn ? 'All runs' : '全部记录'}</Link>
        </span>
      </div>

      {resume && (
        <div className="alert-gradient-amber assistant-resume-banner">
          <span className="small" style={{ opacity: 0.95, lineHeight: 1.7, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span>⏸ {isEn ? 'A run is awaiting your confirmation: ' : '有一次执行停在「等你确认」：'}</span>
            <b style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{resume.goal}</b>
            <Link href={`/assistant?run=${resume.id}`} className="btn btn-sm btn-primary" style={{ marginLeft: 'auto' }}>
              {isEn ? 'Resume Processing →' : '继续处理 →'}
            </Link>
          </span>
        </div>
      )}

      <AgentPanel tools={availableTools(s.role, disabledTools(ws?.agentToolConfig))} initialRunId={run ?? null} />

      <section className="role-ladder-section">
        <div className="role-ladder-header">
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <span className="role-ladder-icon-badge">⚡️</span>
            <strong className="role-ladder-title">
              {isEn ? 'AI Autonomous Capability Hierarchy' : 'AI 协同分工底座体系'}
            </strong>
          </div>
          <span className="small muted">
            {isEn
              ? 'Automatically orchestrated by the assistant; each layer can also be accessed directly:'
              : '由协同助手自主组合调用；你也可以直接跳转至对应工位单独使用：'}
          </span>
        </div>
        <RoleLadder here="assistant" />
      </section>
    </div>
  );
}
