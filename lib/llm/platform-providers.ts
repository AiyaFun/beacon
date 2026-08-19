import { prisma } from '../db';
import { parseJson } from '../json';
import { createLogger } from '../logger';

const log = createLogger({ module: 'platform-providers' });

// 平台级模型渠道（超管在 /ops/ai 配的那些）的**唯一读侧**。
//
// 【为什么单独一个文件】文本走 lib/llm/gateway.ts、图像走 lib/llm/image.ts，两条链路都要读这张表。
// 各读各的意味着两份缓存、两套选路口径——「文本已经切到新渠道了、封面还在用旧的」这种漂移
// 不会报错，只会让人以为「改了没生效」。缓存与选路都收在这里，两条链路共用同一份事实。
//
// ⚠️ 是否允许使用平台渠道由 lib/edition.ts 的 can('platformLlmChannel') 决定（企业版没有"平台"这个主体）。
//    那个判断留在调用方：这里只回答「库里有什么」，不回答「这个版本能不能用」。

export type PlatformProviderRow = {
  id: string;
  label: string;
  vendor: string;
  baseUrl: string;
  apiKeyEnc: string;
  model: string;
  region: string;
  routing: string;
  isDefault: boolean;
};

const cache = { rows: null as PlatformProviderRow[] | null, at: 0 };
const TTL_MS = 60_000;

/** 写侧（app/(ops)/ops/ai/actions.ts）改完即调，不靠 TTL 熬——否则运维台改完像是没保存成功。 */
export function invalidatePlatformProviderCache(): void {
  cache.rows = null;
  cache.at = 0;
}

export async function platformProviderRows(): Promise<PlatformProviderRow[]> {
  if (cache.rows && Date.now() - cache.at < TTL_MS) return cache.rows;
  try {
    const rows = await prisma.platformProvider.findMany({
      where: { enabled: true, status: { not: 'failed' } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, label: true, vendor: true, baseUrl: true, apiKeyEnc: true,
        model: true, region: true, routing: true, isDefault: true,
      },
    });
    cache.rows = rows;
    cache.at = Date.now();
    return rows;
  } catch (err) {
    // 表还没建（生产手动建表前）不该让全站 AI 一起挂：当作没配，由调用方继续走 env 兜底。
    log.warn('读平台渠道失败，回落 env', { error: (err as Error).message });
    return [];
  }
}

/**
 * 按功能选一条平台渠道：routing 显式指到该功能的优先，其次 isDefault。
 *
 * vendorFilter 给图像/视频用——它们只有火山方舟这一条真走得通的路，
 * 指到别家的渠道**不该被静默采纳**（那会拿一个不支持 /images/generations 的端点去出图，
 * 报错信息还很难懂）。
 */
export async function pickPlatformProvider(
  fn: string,
  opts: { allowOverseas?: boolean; vendorFilter?: (vendor: string) => boolean } = {},
): Promise<PlatformProviderRow | null> {
  const rows = await platformProviderRows();
  if (rows.length === 0) return null;
  const usable = rows.filter(
    (p) => (p.region !== 'overseas' || opts.allowOverseas) && (!opts.vendorFilter || opts.vendorFilter(p.vendor)),
  );
  for (const p of usable) {
    const routing = parseJson<Record<string, string>>(p.routing, {});
    if (routing[fn] === p.id) return p;
  }
  return usable.find((p) => p.isDefault) ?? null;
}

/** 有没有一条**被显式指到这个功能**的渠道（不看 vendor）。用于把「指错了家」讲成人话。 */
export async function routedPlatformProvider(fn: string): Promise<PlatformProviderRow | null> {
  const rows = await platformProviderRows();
  for (const p of rows) {
    const routing = parseJson<Record<string, string>>(p.routing, {});
    if (routing[fn] === p.id) return p;
  }
  return null;
}
