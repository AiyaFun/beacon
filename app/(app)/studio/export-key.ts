import { prisma } from '@/lib/db';
import { decryptKey } from '@/lib/crypto';

// 导出的**默认路径是本地渲染**（lib/deliverable/registry.ts），不需要任何 Key。
// 这里解析的 Claude Key 只用于「有就走排版更丰富的 Anthropic Agent Skills」这条可选增强路径，
// 取不到就走本地，不再有「功能点不亮」这回事（原先的 EXPORT_KEY_HINT 指引文案已随之删除）。
// 三级解析：
// ① 平台级环境变量 BEACON_ANTHROPIC_API_KEY（自部署 / 企业版统一配置）；
// ② 该租户 BYOK（接入与密钥）里 vendor=claude 的渠道——连通性测试通过的优先，
//    没测过的也用（宁可调用时报错，也不把功能锁死在「永远点不亮」）；
//    但连通性测试**已失败**的（status=failed，多半 key 被吊销）绝不取——否则会拿死 key
//    点亮按钮、点了才在运行时鉴权报错。此不变量与 lib/llm/gateway.ts 一致。
// ③ 都没有 → null，调用方改走本地渲染（用户无感）。
export async function resolveExportClaudeKey(tenantId: string): Promise<string | null> {
  const envKey = process.env.BEACON_ANTHROPIC_API_KEY?.trim();
  if (envKey) return envKey;
  const providers = await prisma.modelProvider.findMany({
    where: { tenantId, vendor: 'claude', status: { not: 'failed' } },
    orderBy: { createdAt: 'asc' },
  });
  const pick = providers.find((p) => p.status === 'ok') ?? providers[0];
  if (!pick) return null;
  const key = decryptKey(pick.apiKeyEnc).trim();
  return key || null;
}

// 页面用的可用性判断：只把布尔传给客户端，key 本体绝不出服务端
export async function hasExportClaudeKey(tenantId: string): Promise<boolean> {
  return (await resolveExportClaudeKey(tenantId)) !== null;
}
