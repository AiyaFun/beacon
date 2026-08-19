'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { requirePlatformAdmin } from '@/lib/ops/guard';
import { logAdminAction } from '@/lib/ops/admin';
import { proposeSelectors, activateRule, rollbackRule } from '@/lib/ingest/parser-learn';

// 解析规则的审核与下发。**候选规则必须经人点头才上线**——
// 模型很可能把「关注数」当成「粉丝数」，自动上线等于把差三个数量级的数字写进所有人的库。

export async function actProposeSelectors(incidentId: string) {
  await requirePlatformAdmin();
  // 诊断走平台侧模型（tenantId 传 null）：这是平台的运维动作，不该记在某个租户的账上
  const r = await proposeSelectors(incidentId, null);
  revalidatePath('/ops/parser');
  return r;
}

export async function actActivateRule(ruleId: string) {
  const admin = await requirePlatformAdmin();
  const rule = await prisma.parserRule.findUnique({ where: { id: ruleId } });
  const r = await activateRule(ruleId, admin.memberId);
  if (r.ok && rule) {
    await logAdminAction({
      actor: admin,
      action: 'parser.publish',
      targetType: 'parser',
      targetId: ruleId,
      targetLabel: `${rule.platform} · ${rule.field} v${rule.version}`,
      detail: { selectors: rule.selectors, anchors: rule.anchors },
    });
  }
  revalidatePath('/ops/parser');
  return r;
}

export async function actRollbackRule(platform: string, field: string) {
  const admin = await requirePlatformAdmin();
  const r = await rollbackRule(platform, field, admin.memberId);
  if (r.ok) {
    await logAdminAction({
      actor: admin,
      action: 'parser.rollback',
      targetType: 'parser',
      targetId: `${platform}:${field}`,
      targetLabel: `${platform} · ${field}`,
    });
  }
  revalidatePath('/ops/parser');
  return r;
}

export async function actIgnoreIncident(incidentId: string) {
  await requirePlatformAdmin();
  await prisma.parserIncident.update({ where: { id: incidentId }, data: { status: 'ignored' } });
  revalidatePath('/ops/parser');
  return { ok: true };
}
