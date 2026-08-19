import { notFound, redirect } from 'next/navigation';
import { can, edition } from '@/lib/edition';
import { isInitialized, setupTokenConfigured } from '@/lib/setup/state';
import { LLM_VENDORS } from '@/lib/constants';
import { SetupWizard } from './SetupWizard';

// 装机向导。企业版（appliance / private）第一次启动时的唯一入口。
//
// 三道闸，顺序有讲究：
//   ① 形态不对 → 404。SaaS 上这一页在语义上就是不存在的，不该回 403 告诉别人「有但关了」。
//   ② 已经装过 → 跳登录。装完之后再来这一页只可能是收藏夹点错了。
//   ③ 没配装机口令 → 页面明说要重跑安装脚本（真正的拒绝在 server action 里，
//      这里只负责别让用户对着一个填不完的表单发呆）。
export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  if (!can('setupWizard')) notFound();
  if (await isInitialized()) redirect('/login');

  const vendors = Object.values(LLM_VENDORS)
    .filter((v) => v.region === 'cn') // 装机默认只列已备案的国内厂商，海外的到设置页再加
    .map((v) => ({ key: v.key, name: v.name, model: v.model }));

  return (
    <SetupWizard
      vendors={vendors}
      tokenConfigured={setupTokenConfigured()}
      edition={edition()}
    />
  );
}
