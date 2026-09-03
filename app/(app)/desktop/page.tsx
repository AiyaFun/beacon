import { headers } from 'next/headers';
import { can } from '@/lib/edition';
import { getSession } from '@/lib/session';
import { can as canRole } from '@/lib/rbac';
import {
  readDesktopManifest, pickDesktopBuild, readApplianceManifest,
} from '@/lib/downloads';
import { DesktopView } from './DesktopView';
import pkg from '@/package.json';

export const dynamic = 'force-dynamic';

export default async function DesktopPage() {
  const s = await getSession();
  const m = readDesktopManifest();
  const ua = (await headers()).get('user-agent');
  const recommended = pickDesktopBuild(m, ua);

  // 本机服务的一键更新只对整机版/私有化有意义：SaaS 的服务在我们机房，
  // 用户既没有那台机器也不该有那个按钮
  const localService = can('passwordLogin'); // appliance / private（与本机形态同一批）
  const appliance = localService ? readApplianceManifest() : null;
  const canUpdate = canRole(s.role, 'byok.manage'); // owner/admin：与密钥同级

  return (
    <DesktopView
      manifest={m}
      recommended={recommended}
      localService={localService}
      appliance={appliance}
      canUpdate={canUpdate}
      serverVersion={pkg.version}
    />
  );
}
