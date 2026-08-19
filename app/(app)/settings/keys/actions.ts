'use server';

import { getSession } from '@/lib/session';
import { requireRole } from '@/lib/rbac';
import { checkTenantConnections, type CheckReport } from '@/lib/settings/connectivity';

// 一键检测：把这个工作区的所有「接入」挨个探一遍。
//
// 权限用 byok.manage（与改 Key 同一道闸）：检测会真的拿凭据去换 token、去 ping 模型端点，
// 只读角色不该能触发一串对外请求。
export async function actCheckAllConnections(): Promise<{ ok: boolean; report?: CheckReport; error?: string }> {
  try {
    const s = await getSession();
    requireRole(s, 'byok.manage');
    const report = await checkTenantConnections({
      tenantId: s.tenantId,
      workspaceId: s.workspaceId,
      accountId: s.accountId,
    });
    return { ok: true, report };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 200) };
  }
}
