import Link from 'next/link';
import { prisma } from '@/lib/db';
import { expiryNoticeFor } from '@/lib/pay/expiry';
import { isDemoTenant } from '@/lib/demo/guard';

// 到期/续费提醒的**第三条腿**：产品内常驻横幅。
//
// 为什么需要它（2026-07-30 邮件通道下线后尤其重要）：
// 另外两条腿都是「推」——站内通知要用户点开小铃铛、机器人推送要用户配过机器人。
// 而 plan_expiry_notice 是定时任务，漏跑一次那一档就没了（notification 也不会有）。
// 这条腿是「拉」：每次打开任意页面时按 planExpiresAt **现算**，
// 不依赖任务是否跑过、不依赖用户配没配机器人、也不需要任何外部通道。
//
// 口径与 lib/pay/expiry.ts 完全一致（复用同一个纯函数），只是忽略 sentStages ——
// 横幅不是「发一次」的通知，是「这段时间一直在」的状态提示。
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

  const expired = notice.stage === 'expired';
  return (
    <div className={`expiry-banner${expired ? ' expiry-banner-expired' : ''}`} role="status">
      <span>
        {expired ? '⚠️' : '⏳'} <b>{notice.title}</b>
        <span className="expiry-banner-body"> · {notice.body}</span>
      </span>
      <Link href="/billing" className="expiry-banner-btn">
        {expired ? '恢复额度 →' : '去续费 →'}
      </Link>
    </div>
  );
}
