'use server';

import { getSession } from '@/lib/session';
import { requireRole } from '@/lib/rbac';
import { CapabilityDisabledError } from '@/lib/edition';
import { checkApplianceUpdate, startApplianceUpdate, type UpdateCheck } from '@/lib/appliance/update';

// 整机版一键更新的两个动作。**闸在 lib/appliance/update.ts 里**（形态/来源/校验/降级/单例），
// 这里只补一道角色闸——更新会重启整台机器上的服务，与改密钥同级（owner/admin）。
//
// 为什么角色闸放在这里而不是 lib：lib 那层被 CLI 与脚本复用，它们没有「会话」这个概念；
// 把 RBAC 塞进去会逼出一个「system 角色」后门，那比在每个入口点各写一行更危险。

function designed(e: unknown): string {
  if (e instanceof CapabilityDisabledError) return '本版本没有「本机服务」这回事（SaaS 由平台维护）';
  return (e as Error).message.slice(0, 200);
}

export async function actCheckUpdate(): Promise<UpdateCheck> {
  const s = await getSession();
  requireRole(s, 'byok.manage');
  try {
    return await checkApplianceUpdate();
  } catch (e) {
    return { ok: false, error: designed(e) };
  }
}

export async function actStartUpdate(): Promise<{ ok: boolean; version?: string; error?: string }> {
  const s = await getSession();
  requireRole(s, 'byok.manage');
  try {
    const r = await startApplianceUpdate();
    return r.ok ? { ok: true, version: r.version } : { ok: false, error: r.error };
  } catch (e) {
    return { ok: false, error: designed(e) };
  }
}
