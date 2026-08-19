import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { sourceHealthBoard } from '@/lib/adapters/registry';
import { embedderInfo } from '@/lib/vector/embed';
import { PageHead, Card, Stat } from '@/components/ui';
import { Icon } from '@/components/icons';
import { AutomationCard, type LastRun } from './AutomationCard';
import { readAutomationConfig, AUTOMATION_ITEMS } from '@/lib/jobs/automation';

export const dynamic = 'force-dynamic';

// 运行设置：**这一页不放任何 Key**。
//
// 密钥类（模型渠道 / 生图 / 公众号发布 / 采集令牌 / 机器人）全部收在 /settings/keys，
// 那一页回答「填在哪、通不通」；这一页回答「后台在跑什么、数据从哪来」。
// 分开的理由很实际：此前两类东西混在一页，用户找一把 Key 要在三个页面之间来回翻，
// 而这一页又长到没人愿意往下滚。

export default async function SettingsPage() {
  const s = await getSession();
  const [providers, board, workspace, jobRuns] = await Promise.all([
    prisma.modelProvider.count({ where: { tenantId: s.tenantId } }),
    sourceHealthBoard(),
    prisma.workspace.findUnique({ where: { id: s.workspaceId }, select: { automationConfig: true } }),
    prisma.jobRun.findMany({
      where: { name: { in: AUTOMATION_ITEMS.map((i) => i.job).filter((j): j is NonNullable<typeof j> => j !== null) } },
      orderBy: { id: 'desc' },
      take: 40,
      select: { name: true, status: true, detail: true, finishedAt: true, startedAt: true },
    }),
  ]);

  const embed = embedderInfo(); // 语义向量实况（真模型 / 哈希近似），用于「降级说破」

  // 每个任务的最近一次运行（按 id 降序取首个命中）
  const lastRuns: Record<string, LastRun> = {};
  for (const r of jobRuns) {
    if (lastRuns[r.name]) continue;
    lastRuns[r.name] = { status: r.status, detail: r.detail, at: (r.finishedAt ?? r.startedAt).toISOString() };
  }
  const automationConfig = readAutomationConfig(workspace?.automationConfig);

  const enabledJobs = AUTOMATION_ITEMS.filter((i) => automationConfig[i.key] !== false).length;
  const failedRecently = Object.values(lastRuns).filter((r) => r?.status === 'failed').length;

  return (
    <>
      <PageHead
        title="运行设置"
        desc="后台任务、数据源与语义向量的实况 · 所有要填 Key 的地方都在「接入与密钥」"
        action={
          <Link href="/settings/keys" className="btn btn-sm btn-primary">
            <Icon.cpu size={13} /> 接入与密钥
          </Link>
        }
      />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="模型渠道" value={providers} foot="去「接入与密钥」管理" href="/settings/keys" />
        <Stat label="启用中的任务" value={enabledJobs} foot={`共 ${AUTOMATION_ITEMS.length} 项`} />
        <Stat label="最近失败任务" value={failedRecently} foot="看下方任务卡的详情" />
        <Stat label="热榜数据源" value={board.hot.length} foot="含降级链路" />
      </div>

      <Card
        title="🤖 自动化任务"
        sub="每日推荐 / 数据同步 / 自动复盘等定时任务的开关 · 可关可调可见"
        style={{ marginBottom: 16 }}
      >
        <AutomationCard config={automationConfig} lastRuns={lastRuns} />
      </Card>

      <Card title="数据源" sub="开源自建为主，商业 API 兜底，双源冗余">
        <div className="stack" style={{ gap: 8 }}>
          {board.hot.map((h) => (
            <div key={h.name} className="row-between wrap" style={{ gap: 8, padding: '6px 0' }}>
              <span className="row" style={{ gap: 8, alignItems: 'center' }}>
                <span className={`dot ${h.ok ? 'dot-green' : 'dot-amber'}`} />
                <span className="small">{h.name}</span>
                <span className="badge badge-gray">{h.kind}</span>
              </span>
              <span className="small muted">{h.detail ?? (h.ok ? '正常' : '降级中')}</span>
            </div>
          ))}
        </div>

        <div className="divider" style={{ margin: '14px 0' }} />
        <div className="row-between wrap" style={{ gap: 8 }}>
          <span className="row" style={{ gap: 8, alignItems: 'center' }}>
            <span className={`dot ${embed.mocked ? 'dot-amber' : 'dot-green'}`} />
            <span className="small">语义向量（记忆召回 / 话题聚类 / 选题粗排）</span>
            <span className="badge badge-gray">{embed.mocked ? '哈希近似' : embed.model}</span>
          </span>
          <span className="small muted">
            {embed.mocked ? '未配嵌入模型，按字面相似度近似' : '真实嵌入模型'}
          </span>
        </div>

        <div className="divider" style={{ margin: '14px 0' }} />
        <p className="small muted" style={{ lineHeight: 1.7 }}>
          <b>数据来源透明披露：</b>竞对监控仅采集各平台已公开发布的账号与作品信息，不获取任何非公开数据、不托管平台凭证。
          若你是被监控账号主体，可
          <a href="/legal/data-request" target="_blank" style={{ color: 'var(--brand)', fontWeight: 600 }}>申请移除监控 →</a>
        </p>
      </Card>
    </>
  );
}
