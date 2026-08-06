import { prisma } from '../db';
import { parseJson } from '../json';
import { decryptKey } from '../crypto';
import { assertNotDemo } from '../demo/guard';
import { assertLlmQuota, releaseLlmQuota, QuotaExceededError, type QuotaSource } from '../quota';
import { estimateImageCostUsd } from './cost';
import { createLogger } from '../logger';
import { LLM_VENDORS } from '../constants';

const log = createLogger({ module: 'image' });

// ─────────────────────── 图像生成（火山方舟 · 即梦 Seedream）───────────────────────
//
// 【为什么单开一个文件、不复用 OpenAICompatibleProvider】
// 图像生成打的是 `/images/generations` 端点，请求/响应形状与 `/chat/completions` 完全不同
// （没有 messages / choices，多了 image / size / watermark / data[].url）。硬塞进通用 provider
// 只会让那条文本主干长出一堆 if。这里就是「图像版的 gateway」：自己解析 provider、自己过配额闸。
//
// 【口径与 llmVideo 一致：绝不降级 Mock】
// 文本失败可以降级到 Mock（用户看到带「示例」标的占位内容，无害）。图片降级没有意义——
// 编不出一张图，只能如实报错，由调用方告诉用户怎么办。所以这里没有任何 mock 兜底。

/**
 * 默认图像模型：即梦 Seedream 4.0，支持**图生图/参考图**（用户上传人像/产品照，「主体保真」）。
 * 用户可在「模型渠道」把某个豆包渠道显式路由到 image、并把该渠道模型名填成别的即梦版本来覆盖。
 * ⚠️ 待真机校准：拿到 ARK Key 后实测一次，若该 model id 已迭代，按方舟控制台的现名改这一处。
 */
export const DEFAULT_IMAGE_MODEL = 'doubao-seedream-4-0-250828';

/** 小红书封面尺寸：竖版 3:4。即梦按“宽x高”像素接受，1296x1728 ≈ 3:4。 */
export const XHS_COVER_SIZE = '1296x1728';

/** 单次图像生成的超时预算。出图通常 10~30s，给到 90s 兜住偶发排队。 */
export const IMAGE_TIMEOUT_MS = 90_000;

/** 给用户看的模型建议（设置页 / 未配置错误提示共用，避免几处各写一句不一样的）。 */
export const IMAGE_MODEL_HINT =
  '封面生成用即梦 Seedream（推荐 doubao-seedream-4-0，支持上传参考图「主体保真」）。' +
  '你已有的「火山引擎 豆包」渠道会被直接复用，无需另配 Key；' +
  '若想指定别的即梦版本，到「设置 → 模型渠道」把某个豆包渠道路由到「图像」并填对应模型名即可。';

export type ImageGenRequest = {
  /** 已拼好的图像提示词（中文）。见 lib/cover/prompt.ts。 */
  prompt: string;
  /** 输出尺寸「宽x高」，默认 XHS_COVER_SIZE。 */
  size?: string;
  /** 参考图（data: URI 或公网直链），用于主体保真（图生图）。单张或多张。 */
  referenceImages?: string[];
  /**
   * AI 生成水印。默认 **true**：即梦自带的「AI生成」角标是《标识办法》第四条要求的
   * 显式标识，封面是要对外发布的图，默认不关。调用方一般不该传 false。
   */
  watermark?: boolean;
};

export type ImageGenResult =
  | { ok: true; images: { url: string }[]; model: string; source: QuotaSource }
  | { ok: false; reason: 'not_configured' | 'quota' | 'failed'; error: string };

type ImageProvider = { baseUrl: string; apiKey: string; model: string; source: QuotaSource };

/**
 * 解析这个租户的图像 provider。优先级（对齐 lib/llm/gateway.ts 的选择哲学）：
 *   ① routing 里显式指到 image 的豆包渠道 —— 用它的 model（用户特意配的即梦模型），最高优先；
 *   ② 任意豆包渠道（默认渠道优先）—— **复用它的 base+key，模型用默认即梦**。这是「最方便」：
 *      已经为视频/文本加过豆包 Key 的用户，封面零额外配置就能用（同一个方舟账号本就能调即梦）；
 *   ③ 平台兜底 —— 仅当显式配了 BEACON_IMAGE_LLM_MODEL 才开（平台默认文本 Key 未必是方舟 Key，
 *      不显式配就不假设它能生图）。
 */
async function resolveImageProvider(tenantId: string | null): Promise<ImageProvider | null> {
  if (tenantId) {
    const providers = await prisma.modelProvider.findMany({
      where: { tenantId, vendor: 'doubao', status: { not: 'failed' } },
    });
    // ① 显式路由到 image 的渠道：用它自己的 model
    for (const p of providers) {
      const routing = parseJson<Record<string, string>>(p.routing, {});
      if (routing.image === p.id) {
        return { baseUrl: p.baseUrl, apiKey: decryptKey(p.apiKeyEnc), model: p.model, source: 'byok' };
      }
    }
    // ② 任意豆包渠道：复用 base+key，模型强制默认即梦（该渠道的 model 多半是文本/视频模型，不能拿来生图）
    const any = providers.find((p) => p.isDefault) ?? providers[0];
    if (any) {
      return { baseUrl: any.baseUrl, apiKey: decryptKey(any.apiKeyEnc), model: DEFAULT_IMAGE_MODEL, source: 'byok' };
    }
  }
  // ③ 平台兜底：必须显式配 model 才开
  const model = process.env.BEACON_IMAGE_LLM_MODEL;
  const base = process.env.BEACON_IMAGE_LLM_BASE_URL || LLM_VENDORS.doubao.baseUrl;
  const key = process.env.BEACON_IMAGE_LLM_API_KEY || process.env.BEACON_DEFAULT_LLM_API_KEY;
  if (model && key) return { baseUrl: base, apiKey: key, model, source: 'platform' };
  return null;
}

/**
 * 这个租户能不能生图（有没有可用的图像 provider）。
 * 给封面管线在**花一次抽标题的文本调用之前**先失败用——没配渠道就别白烧那一次。
 */
export async function imageConfigured(tenantId: string | null): Promise<boolean> {
  return (await resolveImageProvider(tenantId)) !== null;
}

function generationsUrl(baseUrl: string): string {
  const b = baseUrl.replace(/\/$/, '');
  return b.endsWith('/images/generations') ? b : `${b}/images/generations`;
}

/**
 * 生成图像。配额与记账口径同 llmVideo/llmVision：真实调用照常占额度，失败归还名额、不记账。
 * 配额超限（QuotaExceededError）在这里转成结构化 `reason:'quota'` 返回——调用它的是 server action
 * 链路（runSkill），结构化错误比抛异常更好透传给前端（Next 生产会脱敏抛到 boundary 的 message）。
 */
export async function llmImage(
  tenantId: string | null,
  req: ImageGenRequest,
  opts?: { timeoutMs?: number },
): Promise<ImageGenResult> {
  assertNotDemo(tenantId); // 演示租户不烧钱（图像更贵，这道兜底更要紧）
  const provider = await resolveImageProvider(tenantId);
  if (!provider) {
    return {
      ok: false,
      reason: 'not_configured',
      error: `封面生成要用你自己的火山方舟（豆包）渠道。到「设置 → 模型渠道」加一个「火山引擎 豆包」渠道即可。${IMAGE_MODEL_HINT}`,
    };
  }

  try {
    await assertLlmQuota(tenantId, provider.source); // 真实付费调用，照常占额度
  } catch (e) {
    if (e instanceof QuotaExceededError) return { ok: false, reason: 'quota', error: e.message };
    throw e;
  }

  try {
    const body: Record<string, unknown> = {
      model: provider.model,
      prompt: req.prompt,
      size: req.size ?? XHS_COVER_SIZE,
      response_format: 'url',
      watermark: req.watermark ?? true,
    };
    // 参考图：单张传字符串，多张传数组（方舟两种都接受）。data:URI 内联，不外链——
    // 与截图/视频同一个理由：不为了让模型能取而先把用户的人像照挂到公网上。
    if (req.referenceImages?.length) {
      body.image = req.referenceImages.length === 1 ? req.referenceImages[0] : req.referenceImages;
    }

    const res = await fetch(generationsUrl(provider.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? IMAGE_TIMEOUT_MS),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      await releaseLlmQuota(tenantId); // 调用失败不占名额（同 llmVideo/llmVision 口径）
      return { ok: false, reason: 'failed', error: `封面生成失败 ${res.status}: ${detail.slice(0, 200)}` };
    }

    const data = (await res.json()) as { data?: { url?: string; b64_json?: string }[] };
    const images = (data.data ?? [])
      .map((d) => ({ url: d.url ?? '' }))
      .filter((x): x is { url: string } => !!x.url);
    if (!images.length) {
      await releaseLlmQuota(tenantId);
      return { ok: false, reason: 'failed', error: '模型没有返回图片，请稍后重试' };
    }

    await recordImageUsage(tenantId, provider);
    return { ok: true, images, model: provider.model, source: provider.source };
  } catch (err) {
    await releaseLlmQuota(tenantId);
    return { ok: false, reason: 'failed', error: (err as Error).message.slice(0, 200) };
  }
}

// 图像调用记账：token 口径不适用（按张计费），落一条 fn='image' 的日志并按张估成本，
// 让单位经济仪表盘不因图像调用被记成 $0 而低估毛利。cheap，内部 try/catch 不抛。
async function recordImageUsage(tenantId: string | null, provider: ImageProvider): Promise<void> {
  try {
    await prisma.llmCallLog.create({
      data: {
        tenantId: tenantId ?? undefined,
        fn: 'image',
        provider: provider.source === 'platform' ? 'platform-image' : 'byok-image',
        model: provider.model,
        mocked: false,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: estimateImageCostUsd(provider.model),
      },
    });
  } catch (e) {
    log.warn('recordImageUsage failed', { error: (e as Error).message });
  }
}
