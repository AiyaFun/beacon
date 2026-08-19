import { prisma } from '@/lib/db';
import { PageHead, Card, Empty } from '@/components/ui';
import { fmtDate, fmtNum } from '@/lib/format';
import { beijingDayKey } from '@/lib/beijing';
import { effectivePlan, isPlanExpired } from '@/lib/pay/plan';
import { isDemoTenant } from '@/lib/demo/guard';
import { currentPlatformAdmin } from '@/lib/ops/guard';
import { TenantRow } from './TenantRow';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

// 租户列表：搜名字/ID → 改档位、封禁、授予平台管理员。
// 只列 50 条并给搜索框，不做花哨分页：运维台的真实用法是「找某一个租户」，不是翻页浏览。
export default async function OpsTenantsPage(props: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await props.searchParams;
  const keyword = (q ?? '').trim();
  const admin = await currentPlatformAdmin();

  const where = keyword
    ? { OR: [{ name: { contains: keyword } }, { id: { contains: keyword } }] }
    : {};

  const [tenants, total] = await Promise.all([
    prisma.tenant.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: PAGE_SIZE,
      include: {
        members: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, name: true, phone: true, email: true, role: true, status: true, platformAdmin: true },
        },
      },
    }),
    prisma.tenant.count({ where }),
  ]);

  return (
    <>
      <PageHead
        title="租户"
        desc={`共 ${fmtNum(total)} 个工作区${keyword ? ` · 命中「${keyword}」` : ''} · 最多展示 ${PAGE_SIZE} 条`}
      />

      <form method="get" className="row" style={{ gap: 8, marginBottom: 16 }}>
        <input className="input" name="q" defaultValue={keyword} placeholder="搜工作区名称或租户 ID" style={{ maxWidth: 320 }} />
        <button className="btn btn-sm" type="submit">搜索</button>
      </form>

      {tenants.length === 0 ? (
        <Card><Empty icon="🔍" text="没有匹配的租户。" /></Card>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {tenants.map((t) => {
            const eff = effectivePlan(t.plan, t.planExpiresAt);
            return (
              <TenantRow
                key={t.id}
                tenant={{
                  id: t.id,
                  name: t.name,
                  plan: t.plan,
                  effectivePlan: eff,
                  expired: isPlanExpired(t.plan, t.planExpiresAt),
                  // 按北京时间切日：容器跑 UTC，用 toISOString 切出来的日期在每天早 8 点前会差一天
                  planExpiresAt: t.planExpiresAt ? beijingDayKey(t.planExpiresAt) : '',
                  createdAt: fmtDate(t.createdAt),
                  status: t.status,
                  suspendReason: t.suspendReason ?? '',
                  isDemo: isDemoTenant(t.id),
                }}
                members={t.members.map((m) => ({
                  id: m.id,
                  name: m.name,
                  // 手机号只给后四位：运维台的用途是「定位是谁」，不是「拿到联系方式」
                  contact: m.phone ? `···${m.phone.slice(-4)}` : (m.email ?? ''),
                  role: m.role,
                  status: m.status,
                  platformAdmin: m.platformAdmin,
                }))}
                selfMemberId={admin?.memberId ?? ''}
              />
            );
          })}
        </div>
      )}
    </>
  );
}
