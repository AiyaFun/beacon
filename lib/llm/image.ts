import { prisma } from '../db';
import { parseJson } from '../json';
import { decryptKey } from '../crypto';
import { assertNotDemo } from '../demo/guard';
import {
  assertLlmQuota,
  releaseLlmQuota,
  assertImageDailyCap,
  releaseImageDailyCap,
  QuotaExceededError,
  type QuotaSource,
} from '../quota';
import { estimateImageCostUsd } from './cost';
import { createLogger } from '../logger';
import { LLM_VENDORS } from '../constants';
import { sniffImageMime } from '../deliverable/image-meta';
import { checkArkSize } from '../cover/specs';
import { can } from '../edition';
import { pickPlatformProvider, routedPlatformProvider } from './platform-providers';
import { assertPlatformBudget } from '../ops/platform-config';

const log = createLogger({ module: 'image' });

// ─────────────────────── 图像生成（火山方舟 · 即梦 Seedream）───────────────────────
//
// 【为什么单开一个文件、不复用 OpenAICompatibleProvider】
// 图像生成打的是 `/images/generations` 端点，请求/响应形状与 `/chat/completions` 完全不同
// （没有 messages / choices，多了 image / size / watermark / data[].b64_json）。硬塞进通用 provider
// 只会让那条文本主干长出一堆 if。这里就是「图像版的 gateway」：自己解析 provider、自己过配额闸。
//
// 【口径与 llmVideo 一致：绝不降级 Mock】
// 文本失败可以降级到 Mock（用户看到带「示例」标的占位内容，无害）。图片降级没有意义——
// 编不出一张图，只能如实报错，由调用方告诉用户怎么办。所以这里没有任何 mock 兜底。
//
// 【拿字节不拿直链】response_format 用 b64_json：直链约 24h 过期、前端挂直链等于把「打标」这一步
// 交给用户点不点下载；字节进内存的第一站就能注隐式标识（lib/cover/run.ts），三条出口同一份字节。
// provider 只回 url 时（少数兼容代理）在服务端取回，取回也是字节。

/**
 * 默认图像模型：即梦 Seedream 4.0，支持**图生图/参考图**（用户上传人像/产品照，「主体保真」）。
 *
 * 【为什么默认停在 4.0 而不是更新的 4.5 / 5.0 lite】新模型要在方舟控制台单独开通。默认指一个
 * 用户没开通的模型，第一次点「生成封面」就是一句「模型不存在」——比画质差一点糟得多。
 * 4.0 上线最久、开通率最高，作默认最稳。想换新版的路是通的（这一轮刚把 routing 写通）：
 * 接入与密钥 → 把某个豆包渠道的模型名填成新版本 → 「封面生图」那一行选它。
 * 已知可选（2026-08 口径）：doubao-seedream-4-5-251128、doubao-seedream-5-0-260128（5.0 才支持 PNG 输出）。
 *
 * ⚠️ 仍待真机：哪个版本中文上字更稳。这个只能拿真 Key 各出几张比，没法从文档推。
 */
export const DEFAULT_IMAGE_MODEL = 'doubao-seedream-4-0-250828';

/** 单次图像生成的超时预算。出图通常 10~30s，给到 90s 兜住偶发排队。 */
export const IMAGE_TIMEOUT_MS = 90_000;

/** 给用户看的模型建议（设置页 / 未配置错误提示共用，避免几处各写一句不一样的）。 */
export const IMAGE_MODEL_HINT =
  '封面生成用即梦 Seedream（默认 doubao-seedream-4-0，支持上传参考图「主体保真」）。' +
  '你已有的「火山引擎 豆包」渠道会被直接复用，无需另配 Key；' +
  '你自己没配时，平台若在运维台配了生图渠道也会自动兜底（用的是平台的额度）；' +
  '想换更新的版本（4.5 / 5.0 lite，需在方舟控制台先开通），在「模型渠道」把某条豆包渠道的模型名改成它，' +
  '再把「封面生图」这一行指到该渠道即可。';

export type ImageGenRequest = {
  /** 已拼好的图像提示词（中文）。见 lib/cover/prompt.ts。 */
  prompt: string;
  /** 输出尺寸「宽x高」。调用方从 lib/cover/specs.ts 取，不在这里写死任何比例。 */
  size: string;
  /** 参考图（data: URI 或公网直链），用于主体保真（图生图）。单张或多张。 */
  referenceImages?: string[];
};

export type GeneratedImage = { bytes: Uint8Array; mime: string };

export type ImageGenResult =
  | { ok: true; images: GeneratedImage[]; model: string; source: QuotaSource }
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

  // ③ 平台渠道（超管在 /ops/ai 配的那条 Key）。
  //
  // 【补的是什么】此前这一层根本不存在：/ops/ai 的「封面生图」那一行能选渠道，读侧却只看
  // 租户自己的豆包渠道 —— 于是超管配了平台生图 Key，用户点生成还是「未配置」。
  // 典型的「写了没接」：界面上有开关、代码里没人读。
  //
  // 【为什么只认方舟】出图打的是 /images/generations，且**水印是服务端强制开的**
  //（即梦的 watermark 参数，《标识办法》第四条要求的显式标识）。别家的图像端点要么参数形状不同，
  // 要么根本没有水印开关——静默拿它出图 = 交付一张没有显式 AI 标识的封面，那是合规事故。
  // 所以指到别家时**不静默降级**，由 imageMisroutedVendor() 把原因讲给用户听。
  if (can('platformLlmChannel')) {
    const p = await pickPlatformProvider('image', { vendorFilter: (v) => v === 'doubao' });
    if (p) {
      const routing = parseJson<Record<string, string>>(p.routing, {});
      // 显式指到 image 的用它自己的 model（用户特意填的即梦版本）；顺带命中的默认渠道
      // 一律用默认即梦模型（那条渠道的 model 多半是文本模型）。与租户侧同口径。
      const model = routing.image === p.id ? p.model : DEFAULT_IMAGE_MODEL;
      return { baseUrl: p.baseUrl, apiKey: decryptKey(p.apiKeyEnc), model, source: 'platform' };
    }
  }

  // ④ env 兜底：必须显式配 model 才开（平台默认文本 Key 未必是方舟 Key，不显式配就不假设它能生图）。
  const model = process.env.BEACON_IMAGE_LLM_MODEL;
  const base = process.env.BEACON_IMAGE_LLM_BASE_URL || LLM_VENDORS.doubao.baseUrl;
  const key = process.env.BEACON_IMAGE_LLM_API_KEY || process.env.BEACON_DEFAULT_LLM_API_KEY;
  // 企业版里这把 Key 写在客户自己的 .env 里、烧的是客户自己的钱，标成 byok 才不会被送进
  // 平台预算闸（与 lib/llm/gateway.ts 的 env 分支同口径）。
  if (model && key) return { baseUrl: base, apiKey: key, model, source: can('platformLlmChannel') ? 'platform' : 'byok' };
  return null;
}

/**
 * 「封面生图」被指到了一条**不是方舟**的平台渠道时，返回那条渠道的名字。
 *
 * 存在的理由：用户在 /ops/ai 里把 image 指到 OpenAI 之后，出图仍然报「未配置」——
 * 那句话是对的但没用，他明明配了。有了这个，错误提示能直接说清楚「指到的那条用不了、为什么」。
 */
export async function imageMisroutedVendor(): Promise<string | null> {
  if (!can('platformLlmChannel')) return null;
  const routed = await routedPlatformProvider('image');
  return routed && routed.vendor !== 'doubao' ? routed.label : null;
}

/**
 * 这个租户能不能生图（有没有可用的图像 provider）。
 * 给封面管线在**花一次抽标题的文本调用之前**先失败用——没配渠道就别白烧那一次。
 */
export async function imageConfigured(tenantId: string | null): Promise<boolean> {
  return (await resolveImageProvider(tenantId)) !== null;
}

/** 这个租户的图像来源（platform / byok），给配额状态展示用；没配则 null。 */
export async function imageSource(tenantId: string | null): Promise<QuotaSource | null> {
  return (await resolveImageProvider(tenantId))?.source ?? null;
}

function generationsUrl(baseUrl: string): string {
  const b = baseUrl.replace(/\/$/, '');
  return b.endsWith('/images/generations') ? b : `${b}/images/generations`;
}

/**
 * provider 只回 url 时的取回闸：只跟 https、且主机名不是 IP 字面量 / localhost / 内网后缀。
 * baseUrl 是租户自己填的（BYOK），不能让一个租户借我们的服务端去拉内网地址。
 */
export function safeRemoteImageUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false; // IPv4 字面量
    if (h.includes(':') || h.startsWith('[')) return false; // IPv6 字面量
    return true;
  } catch {
    return false;
  }
}

function decodeBase64(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^,]*,/, '');
  return new Uint8Array(Buffer.from(clean, 'base64'));
}

/**
 * 生成图像。配额与记账口径同 llmVideo/llmVision：真实调用照常占额度，失败归还名额、不记账。
 * 配额超限（QuotaExceededError）在这里转成结构化 `reason:'quota'` 返回。
 * 水印**服务端强制开**：即梦「AI生成」角标是《标识办法》第四条的显式标识，封面是要对外发布的图，
 * 调用方没有关它的口子。
 */
export async function llmImage(
  tenantId: string | null,
  req: ImageGenRequest,
  opts?: { timeoutMs?: number },
): Promise<ImageGenResult> {
  assertNotDemo(tenantId); // 演示租户不烧钱（图像更贵，这道兜底更要紧）
  const provider = await resolveImageProvider(tenantId);
  if (!provider) {
    // 指错了家要单独说：用户明明在运维台配了 image 路由，只回一句「未配置」他会一直改不对。
    const misrouted = await imageMisroutedVendor();
    if (misrouted) {
      return {
        ok: false,
        reason: 'not_configured',
        error:
          `平台的「封面生图」被指到了「${misrouted}」，但生图只能走火山方舟（即梦）：` +
          '别家的图像端点参数形状不同，且没有可强制开启的 AI 水印开关，' +
          '拿它出图会交付一张没有显式 AI 标识的封面。请把「封面生图」改指到一条火山方舟渠道。',
      };
    }
    return {
      ok: false,
      reason: 'not_configured',
      error: `封面生成要用火山方舟（豆包）渠道：到「接入与密钥」加一个「火山引擎 豆包」渠道即可（平台若已在运维台配了生图渠道，也会自动用上）。${IMAGE_MODEL_HINT}`,
    };
  }

  // 三道闸串联：平台预算 → 图像日上限 → 普通日/月名额。任一没过都拒。
  // 平台预算排最前：它拦的是「平台垫付的钱烧完了」，与这个租户用了多少无关，
  // 放在后面会先扣掉租户的名额再告诉他不能用（名额还能归还，但用户已经看到两条互相矛盾的提示）。
  if (provider.source === 'platform') {
    try {
      await assertPlatformBudget();
    } catch (e) {
      if (e instanceof QuotaExceededError) return { ok: false, reason: 'quota', error: e.message };
      throw e;
    }
  }
  try {
    await assertImageDailyCap(tenantId, provider.source);
  } catch (e) {
    if (e instanceof QuotaExceededError) return { ok: false, reason: 'quota', error: e.message };
    throw e;
  }
  try {
    await assertLlmQuota(tenantId, provider.source);
  } catch (e) {
    await releaseImageDailyCap(tenantId, provider.source);
    if (e instanceof QuotaExceededError) return { ok: false, reason: 'quota', error: e.message };
    throw e;
  }

  const giveBack = async () => {
    // source 必须与上面 assertLlmQuota(tenantId, provider.source) 用的是同一个，
    // 否则占的是一个桶、还的是另一个桶
    await Promise.all([releaseLlmQuota(tenantId, provider.source), releaseImageDailyCap(tenantId, provider.source)]);
  };

  try {
    const body: Record<string, unknown> = {
      model: provider.model,
      prompt: req.prompt,
      size: req.size,
      response_format: 'b64_json',
      watermark: true,
    };
    // 参考图：单张传字符串，多张传数组（方舟两种都接受）。data:URI 内联，不外链——
    // 与截图/视频同一个理由：不为了让模型能取而先把用户的人像照挂到公网上。
    if (req.referenceImages?.length) {
      body.image = req.referenceImages.length === 1 ? req.referenceImages[0] : req.referenceImages;
    }

    const timeoutMs = opts?.timeoutMs ?? IMAGE_TIMEOUT_MS;
    const res = await fetch(generationsUrl(provider.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      await giveBack(); // 调用失败不占名额（同 llmVideo/llmVision 口径）
      return { ok: false, reason: 'failed', error: explainArkError(res.status, detail, provider.model, req.size) };
    }

    const data = (await res.json()) as { data?: { url?: string; b64_json?: string }[] };
    const images: GeneratedImage[] = [];
    for (const d of data.data ?? []) {
      let bytes: Uint8Array | null = null;
      if (d.b64_json) {
        bytes = decodeBase64(d.b64_json);
      } else if (d.url && safeRemoteImageUrl(d.url)) {
        // 兼容只回 url 的代理：服务端取回成字节（仍然不把直链交给前端）
        const r = await fetch(d.url, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
        if (r?.ok) bytes = new Uint8Array(await r.arrayBuffer());
      }
      if (!bytes || bytes.length === 0) continue;
      const mime = sniffImageMime(bytes) ?? 'image/jpeg';
      images.push({ bytes, mime });
    }
    if (!images.length) {
      await giveBack();
      return { ok: false, reason: 'failed', error: '模型没有返回图片，请稍后重试' };
    }

    await recordImageUsage(tenantId, provider);
    return { ok: true, images, model: provider.model, source: provider.source };
  } catch (err) {
    await giveBack();
    return { ok: false, reason: 'failed', error: (err as Error).message.slice(0, 200) };
  }
}

/**
 * 把方舟的报错翻译成用户能照着做的一句话。
 *
 * 【为什么值得一个函数】方舟的 400 长这样：`{"error":{"code":"InvalidParameter","message":"..."}}`——
 * 原样甩给用户，他既不知道是自己哪一步的问题，也不知道该改什么。而这三类是真会撞上的：
 * 模型没开通（默认模型不一定在他账号里）、尺寸不合法（改过 specs 表）、余额/限流。
 */
export function explainArkError(status: number, detail: string, model: string, size: string): string {
  const raw = detail.slice(0, 300);
  const lower = raw.toLowerCase();
  const sizeIssue = checkArkSize(size);

  if (/model.*(not|no).*(found|exist)|modelnotfound|invalidendpoint|endpoint.*not.*found/i.test(raw)) {
    return `模型「${model}」在你的方舟账号里不可用（多半是没开通）。到方舟控制台开通它，或在「接入与密钥」把封面生图指到一条模型名可用的豆包渠道。`;
  }
  if (sizeIssue || /size|width|height|resolution|分辨率|尺寸/i.test(raw)) {
    return `方舟不接受这个出图尺寸${sizeIssue ? `：${sizeIssue}` : `（${size}）`}。换一个比例试试；如果每个比例都这样，多半是模型版本对尺寸的支持不同。`;
  }
  if (status === 429 || /rate.?limit|too many|qps|限流/i.test(lower)) {
    return '方舟这会儿限流了（同一个 Key 的并发/QPS 上限）。等十几秒再点一次，或把一次出的张数改小。';
  }
  if (status === 401 || status === 403 || /unauthorized|invalid.*api.?key|鉴权/i.test(lower)) {
    return '方舟拒绝了这把 Key（无效或没有图像生成权限）。到「接入与密钥」检查这条豆包渠道的 Key。';
  }
  if (/balance|insufficient|欠费|余额/i.test(lower)) {
    return '方舟账号余额不足或未开通计费，出图被拒。到方舟控制台充值/开通后再试。';
  }
  return `封面生成失败 ${status}: ${raw.slice(0, 200)}`;
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
        source: provider.source === 'platform' ? 'platform' : 'byok',
      },
    });
  } catch (e) {
    log.warn('recordImageUsage failed', { error: (e as Error).message });
  }
}
