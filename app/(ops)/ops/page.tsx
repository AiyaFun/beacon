import Link from 'next/link';
import { prisma } from '@/lib/db';
import { PageHead, Card, Stat, Empty } from '@/components/ui';
import { fmtNum, fmtDateTime } from '@/lib/format';
import { effectivePlan } from '@/lib/pay/plan';
import { ADMIN_ACTION_LABEL, ADMIN_ACTION_LABEL_EN, type AdminAction } from '@/lib/ops/admin';
import { beijingStartOfDay } from '@/lib/beijing';
import { getServerLang } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';

// 运维台总览：一屏答四个问题——多少人在用、今天烧了多少钱、有没有任务在挂、最近谁动了什么。
export default async function OpsHomePage() {
  const lang = await getServerLang();
  const isEn = lang === 'en';
  const dayStart = beijingStartOfDay(new Date());

  const [tenants, suspended, todayCalls, todayCost, failedJobs, recentAudit] = await Promise.all([
    prisma.tenant.findMany({ select: { plan: true, planExpiresAt: true, status: true } }),
    prisma.tenant.count({ where: { status: { not: 'active' } } }),
    prisma.llmCallLog.count({ where: { createdAt: { gte: dayStart } } }),
    prisma.llmCallLog.aggregate({ _sum: { costUsd: true }, where: { createdAt: { gte: dayStart } } }),
    prisma.jobRun.count({ where: { status: 'failed', startedAt: { gte: dayStart } } }),
    prisma.adminAuditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 8 }),
  ]);

  // 付费口径与全站一致：走 effectivePlan（到期即按 free 算），不直接数 plan != 'free'——
  // 后者会把一堆早就过期的租户算成付费，报表比没有还糟。
  const paid = tenants.filter((t) => {
    const p = effectivePlan(t.plan, t.planExpiresAt);
    return p !== 'free' && p !== 'trial';
  }).length;

  const actionLabels = isEn ? ADMIN_ACTION_LABEL_EN : ADMIN_ACTION_LABEL;

  return (
    <>
      <PageHead
        title={isEn ? 'Platform Overview' : '平台总览'}
        desc={isEn ? 'Cross-tenant perspective · Figures aggregated by Beijing time today' : '跨租户视角 · 数字按北京时间当日统计'}
      />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat
          label={isEn ? 'Total Tenants' : '租户总数'}
          value={fmtNum(tenants.length)}
          foot={suspended > 0 ? (isEn ? `${suspended} suspended` : `${suspended} 个已封禁`) : (isEn ? 'None suspended' : '无封禁')}
          href="/ops/tenants"
        />
        <Stat
          label={isEn ? 'Paid Tenants' : '付费租户'}
          value={fmtNum(paid)}
          foot={isEn ? 'Active paid tiers based on expiry' : '按到期日折算后的有效档位'}
        />
        <Stat
          label={isEn ? 'AI Calls Today' : '今日 AI 调用'}
          value={fmtNum(todayCalls)}
          foot={isEn ? 'Includes mock & live calls' : '含 Mock 与真实调用'}
          href="/ops/ai"
        />
        <Stat
          label={isEn ? 'Model Cost Today' : '今日模型花费'}
          value={`$${(todayCost._sum.costUsd ?? 0).toFixed(2)}`}
          foot={isEn ? 'Platform-covered quota only' : '仅平台垫付部分计费'}
        />
      </div>

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <Card title={isEn ? 'Task Health' : '任务健康'} sub={isEn ? 'Scheduled & background jobs failed today' : '今日失败的定时/后台任务'}>
          {failedJobs === 0 ? (
            <div className="small" style={{ color: 'var(--green)' }}>
              {isEn ? 'No failed tasks today.' : '今天没有失败任务。'}
            </div>
          ) : (
            <div className="row" style={{ gap: 10 }}>
              <span className="badge badge-red">{isEn ? `${failedJobs} failures` : `${failedJobs} 次失败`}</span>
              <Link className="btn btn-sm" href="/ops/health">
                {isEn ? 'View Ingestion Health' : '去看采集健康'}
              </Link>
            </div>
          )}
        </Card>

        <Card title={isEn ? 'Recent Platform Actions' : '最近的平台动作'} sub={isEn ? 'Audit log of who changed what' : '谁改了什么，全部留痕'}>
          {recentAudit.length === 0 ? (
            <Empty icon="🗂" text={isEn ? 'No platform actions yet.' : '还没有任何平台侧动作。'} />
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {recentAudit.map((a) => (
                <div key={a.id} className="small" style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <span className="muted" style={{ minWidth: 116 }}>{fmtDateTime(a.createdAt)}</span>
                  <span style={{ fontWeight: 600 }}>{a.actorName}</span>
                  <span>{actionLabels[a.action as AdminAction] ?? a.action}</span>
                  <span className="muted">{a.targetLabel}</span>
                </div>
              ))}
              <Link className="small" href="/ops/audit" style={{ marginTop: 4 }}>
                {isEn ? 'View all →' : '查看全部 →'}
              </Link>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
