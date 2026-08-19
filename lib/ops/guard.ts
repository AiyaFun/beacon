import { getSessionOrNull } from '../session';
import { resolvePlatformAdmin, NotPlatformAdminError, type PlatformAdmin } from './admin';

// 运维台的唯一入口守卫。页面用 currentPlatformAdmin() + notFound()，
// server action 用 requirePlatformAdmin() 直接抛——越权不是可展示的业务分支。
//
// ⚠️ 为什么不写进 middleware：middleware 跑在 edge、只看 cookie 存不存在，不查库。
// 「是不是超管」必须查库（还要看成员是否被停用、租户是不是演示租户），只能在这一层做。

export async function currentPlatformAdmin(): Promise<PlatformAdmin | null> {
  const s = await getSessionOrNull();
  if (!s) return null;
  return resolvePlatformAdmin(s.memberId);
}

export async function requirePlatformAdmin(): Promise<PlatformAdmin> {
  const admin = await currentPlatformAdmin();
  if (!admin) throw new NotPlatformAdminError();
  return admin;
}
