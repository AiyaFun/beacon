'use server';

import { getSession } from '@/lib/session';
import { requireRole } from '@/lib/rbac';
import { assertNotDemo } from '@/lib/demo/guard';
import { capabilityRegistry } from '@/lib/capabilities/registry';

// 能力探针（2026-09-11 P1）：对一项能力做一次**廉价**的可用性检查。
// 渠道 = 真发一条测试消息（用户主动点的，副作用他知道）；模型 = 只看能不能选到渠道，不真调；
// 其余 = 重新算一遍依赖。不做会花钱的探测。

export async function actProbeCapability(id: string): Promise<{ ok: boolean; message: string }> {
  const s = await getSession();
  requireRole(s, 'content.view');
  if (id.startsWith('channel:')) {
    requireRole(s, 'content.create');
    assertNotDemo(s.tenantId);
    const { testPush } = await import('@/lib/bot');
    const r = await testPush(id.slice('channel:'.length), s.workspaceId);
    return r.ok ? { ok: true, message: '测试消息发出去了，去群里看一眼' } : { ok: false, message: `发不出去：${('error' in r && r.error) || '未知原因'}` };
  }
  if (id === 'model:route') {
    try {
      const { resolveProvider } = await import('@/lib/llm/gateway');
      const p = await resolveProvider(s.tenantId, 'chat');
      const mocked = (p as { mocked?: boolean }).mocked === true || /mock/i.test((p as { name?: string }).name ?? '');
      return mocked ? { ok: false, message: '选路落在 Mock：没有可用的真实渠道' } : { ok: true, message: `会走「${(p as { name?: string }).name ?? '默认'}」` };
    } catch (e) {
      return { ok: false, message: (e as Error).message.slice(0, 160) };
    }
  }
  const rows = await capabilityRegistry(s.tenantId, s.workspaceId, s.role);
  const row = rows.find((r) => r.id === id);
  if (!row) return { ok: false, message: '没有这项能力' };
  return row.usable ? { ok: true, message: '现在可用' } : { ok: false, message: row.depsMissing.join('；') || (row.authorized ? '没装' : '没有权限或已被关闭') };
}
