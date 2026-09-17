import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/geo/page-seo';
import { headers } from 'next/headers';
import { can } from '@/lib/edition';
import { getSessionOrNull } from '@/lib/session';
import { can as canRole } from '@/lib/rbac';
import {
  readDesktopManifest, pickDesktopBuild, readApplianceManifest,
} from '@/lib/downloads';
import { DesktopView } from './DesktopView';
import pkg from '@/package.json';

export const dynamic = 'force-dynamic';

// 这一页在 sitemap.xml 里递交给了搜索引擎，却一直没有自己的标题与描述——
// 静默沿用全站默认那一份，于是搜索结果里它和首页长得一模一样。
// 文案收在 lib/geo/page-seo.ts，见那里顶部「这一层解决的是什么」。
export const metadata: Metadata = pageMetadata('/desktop');

export default async function DesktopPage() {
  // 未登录也能看（2026-09-05）：陌生人看一眼有没有 Windows 版不该先填手机号。
  // 游客拿到的是纯下载页——整机更新卡与角色相关的按钮一律不渲染。
  const s = await getSessionOrNull();
  const m = readDesktopManifest();
  const ua = (await headers()).get('user-agent');
  const recommended = pickDesktopBuild(m, ua);

  // 本机服务的一键更新只对整机版/私有化有意义：SaaS 的服务在我们机房，
  // 用户既没有那台机器也不该有那个按钮
  const localService = !!s && can('passwordLogin'); // appliance / private（与本机形态同一批）
  const appliance = localService ? readApplianceManifest() : null;
  const canUpdate = !!s && canRole(s.role, 'byok.manage'); // owner/admin：与密钥同级

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
