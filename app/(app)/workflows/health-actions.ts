'use server';

import { getSession } from '@/lib/session';
import { requireRole } from '@/lib/rbac';
import { supportBundle } from '@/lib/health/agents';

/** 导出脱敏诊断包（JSON 文本）。只读，不改任何东西。 */
export async function actExportSupportBundle(): Promise<{ ok: true; json: string } | { ok: false; error: string }> {
  const s = await getSession();
  requireRole(s, 'content.view');
  try {
    return { ok: true, json: await supportBundle(s.tenantId, s.workspaceId) };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 200) };
  }
}
