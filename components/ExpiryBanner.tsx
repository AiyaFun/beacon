import { prisma } from '@/lib/db';
import { expiryNoticeFor } from '@/lib/pay/expiry';
import { isDemoTenant } from '@/lib/demo/guard';
import { ExpiryBannerView } from './ExpiryBannerView';

// 到期/续费提醒的**第三条腿**：产品内常驻横幅。
export async function ExpiryBanner({ tenantId, role }: { tenantId: string; role: string }) {
  if (isDemoTenant(tenantId)) return null; // 演示租户是只读展台，不催费
  // 只给能对账单负责的人看。给编辑/查看者挂一条他们既处理不了、也不该看到的催费横幅，
  // 是纯打扰——与邮件那条腿当年的收件人口径一致（owner/admin）。
  if (role !== 'owner' && role !== 'admin') return null;

  const t = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { plan: true, planExpiresAt: true },
  });
  if (!t) return null;

  const notice = expiryNoticeFor({ plan: t.plan, planExpiresAt: t.planExpiresAt, now: new Date() });
  if (!notice) return null;

  return <ExpiryBannerView notice={notice} />;
}
