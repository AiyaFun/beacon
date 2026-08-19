'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { requirePlatformAdmin } from '@/lib/ops/guard';
import { logAdminAction } from '@/lib/ops/admin';
import {
  readPlatformAiConfig,
  writePlatformAiConfig,
  normalizeAiConfig,
  invalidatePlatformConfigCache,
  type PlatformAiConfig,
} from '@/lib/ops/platform-config';
import { invalidatePlatformProviderCache } from '@/lib/llm/gateway';
import { encryptKey, decryptKey } from '@/lib/crypto';
import { parseJson, toJson } from '@/lib/json';
import { checkVendorEndpoint, LLM_FUNCTIONS, looksNonChatModel } from '@/lib/constants';
import { pingProvider } from '@/lib/llm/connectivity';

// 全域 AI 配置的写侧。三件必须一起做的事（漏一件就是「配了不生效」）：
//   ① 写库；② 失效缓存（gateway 与 platform-config 各有一份 60s 缓存）；③ 写审计。

export async function actCreatePlatformProvider(data: {
  label: string;
  vendor: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  region: string;
}): Promise<{ ok: boolean; error?: string }> {
  const admin = await requirePlatformAdmin();
  const label = data.label.trim();
  const model = data.model.trim();
  const apiKey = data.apiKey.trim();
  if (!label || !model || !apiKey) return { ok: false, error: '渠道名称、模型名、API Key 都要填' };

  // 端点白名单与租户 BYOK 同一套（lib/constants.ts:LLM_VENDORS）：
  // 平台侧也不开放自定义端点——那是把 Key 发到任意地址去的口子。
  const check = checkVendorEndpoint(data.vendor, data.baseUrl.trim());
  if (!check.ok) return { ok: false, error: check.error };

  await prisma.platformProvider.create({
    data: {
      label,
      vendor: data.vendor,
      baseUrl: check.vendor.baseUrl,
      apiKeyEnc: encryptKey(apiKey), // 信封加密入库，界面永不回显明文
      model,
      region: data.region === 'overseas' ? 'overseas' : 'cn',
    },
  });
  invalidatePlatformProviderCache();
  await logAdminAction({
    actor: admin,
    action: 'provider.create',
    targetType: 'provider',
    targetId: label,
    targetLabel: label,
    detail: { vendor: data.vendor, model, region: data.region },
  });
  revalidatePath('/ops/ai');
  return { ok: true };
}

export async function actDeletePlatformProvider(id: string): Promise<{ ok: boolean; error?: string }> {
  const admin = await requirePlatformAdmin();
  const p = await prisma.platformProvider.findUnique({ where: { id } });
  if (!p) return { ok: false, error: '渠道不存在' };
  await prisma.platformProvider.delete({ where: { id } });
  invalidatePlatformProviderCache();
  await logAdminAction({
    actor: admin, action: 'provider.delete', targetType: 'provider', targetId: id, targetLabel: p.label,
  });
  revalidatePath('/ops/ai');
  return { ok: true };
}

export async function actTogglePlatformProvider(id: string, patch: { enabled?: boolean; isDefault?: boolean }) {
  const admin = await requirePlatformAdmin();
  const p = await prisma.platformProvider.findUnique({ where: { id } });
  if (!p) return { ok: false, error: '渠道不存在' };

  if (patch.isDefault) {
    // 默认渠道只能有一条：不清掉旧的，读侧 find() 会按创建顺序撞到哪条算哪条，
    // 界面上却会显示两条都是默认——一个看不出来的随机行为。
    await prisma.platformProvider.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
  }
  await prisma.platformProvider.update({ where: { id }, data: patch });
  invalidatePlatformProviderCache();
  await logAdminAction({
    actor: admin, action: 'provider.update', targetType: 'provider', targetId: id, targetLabel: p.label, detail: patch,
  });
  revalidatePath('/ops/ai');
  return { ok: true };
}

/** 把某个功能指到某条平台渠道。空 providerId = 取消指定（回落默认渠道 → env）。 */
export async function actSetPlatformRouting(fn: string, providerId: string) {
  const admin = await requirePlatformAdmin();
  if (!(LLM_FUNCTIONS as readonly string[]).includes(fn)) return { ok: false, error: '未知的功能' };

  const providers = await prisma.platformProvider.findMany();
  const target = providerId ? providers.find((p) => p.id === providerId) : null;
  if (providerId && !target) return { ok: false, error: '渠道不存在' };
  // 图像/视频只有火山方舟这一条真走得通的路（读侧 lib/llm/image.ts / gateway.ts 也只在 doubao 里挑）。
  // 指到别家等于指了个不会被采纳的值——与其静默无效，不如当场说清楚（租户侧 actSetRouting 同口径）。
  if (target && (fn === 'image' || fn === 'video') && target.vendor !== 'doubao') {
    return {
      ok: false,
      error: `${fn === 'image' ? '封面生图' : '视频理解'}只能用「火山引擎 豆包」渠道：别家的端点参数形状不同，生图还没有可强制开启的 AI 水印开关。`,
    };
  }

  // 存储口径与租户侧一致（渠道自己的 routing 里存 {fn: 自己的 id}）：
  // 指定 fn→P 要先把 fn 从别的渠道摘掉，再写进 P。
  await Promise.all(
    providers.map((p) => {
      const routing = parseJson<Record<string, string>>(p.routing, {});
      const shouldHave = target?.id === p.id;
      if (shouldHave) routing[fn] = p.id;
      else delete routing[fn];
      return prisma.platformProvider.update({ where: { id: p.id }, data: { routing: toJson(routing) } });
    }),
  );
  invalidatePlatformProviderCache();
  await logAdminAction({
    actor: admin, action: 'setting.update', targetType: 'setting', targetId: `routing.${fn}`,
    targetLabel: `功能路由 ${fn}`, detail: { providerId },
  });
  revalidatePath('/ops/ai');
  return { ok: true };
}

/** 连通性测试：与租户侧**同一份实现**（lib/llm/connectivity.ts），不再各写一份特判。 */
export async function actTestPlatformProvider(id: string) {
  await requirePlatformAdmin();
  const p = await prisma.platformProvider.findUnique({ where: { id } });
  if (!p) return { ok: false, error: '渠道不存在' };
  const routing = parseJson<Record<string, string>>(p.routing, {});
  const nonChat = routing.image === p.id || routing.video === p.id || looksNonChatModel(p.model);
  const r = await pingProvider({
    label: p.label,
    baseUrl: p.baseUrl,
    apiKey: decryptKey(p.apiKeyEnc),
    model: p.model,
    nonChat,
  });
  await prisma.platformProvider.update({ where: { id }, data: { status: r.status } });
  invalidatePlatformProviderCache();
  revalidatePath('/ops/ai');
  return { ok: r.ok, status: r.status, detail: r.detail };
}

export async function actSavePlatformAiConfig(cfg: PlatformAiConfig): Promise<{ ok: boolean; error?: string }> {
  const admin = await requirePlatformAdmin();
  const before = await readPlatformAiConfig();
  const after = await writePlatformAiConfig(normalizeAiConfig(cfg), admin.memberId);
  invalidatePlatformConfigCache();
  await logAdminAction({
    actor: admin, action: 'setting.update', targetType: 'setting', targetId: 'ai.config',
    targetLabel: '全域 AI 参数与预算', detail: { before, after },
  });
  revalidatePath('/ops/ai');
  return { ok: true };
}
