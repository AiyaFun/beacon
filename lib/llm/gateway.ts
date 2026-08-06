import { prisma } from '../db';
import { parseJson } from '../json';
import { decryptKey } from '../crypto';
import { assertNotDemo } from '../demo/guard';
import { assertLlmQuota, releaseLlmQuota, type QuotaSource } from '../quota';
import { createLogger } from '../logger';

const log = createLogger({ module: 'llm' });
import { estimateCostUsd } from './cost';
import type { LlmFunction } from '../constants';
import type { ChatMessage, LlmProvider, LlmResult } from './types';
import { MockProvider } from './mock';
import { OpenAICompatibleProvider } from './openai-compatible';
import { looksVideoCapable, VIDEO_MODEL_HINT } from './ark';

// LLM 网关：按「租户 BYOK 配置 → 平台默认 env → Mock」优先级选 provider，并支持按功能路由。
// 合规约束（PRD §10.5）：region=overseas 的 provider 仅用于出海内容场景，且生成出口仍过合规检测。

const mock = new MockProvider();

function fromEnv(): LlmProvider | null {
  const base = process.env.BEACON_DEFAULT_LLM_BASE_URL;
  const key = process.env.BEACON_DEFAULT_LLM_API_KEY;
  const model = process.env.BEACON_DEFAULT_LLM_MODEL || 'deepseek-chat';
  if (base && key) {
    return new OpenAICompatibleProvider({ name: 'platform-default', baseUrl: base, apiKey: key, model });
  }
  return null;
}

// 视觉模型单独配置，不复用默认文本模型：多数文本模型收到图片要么报错、要么一本正经地
// 编造内容。而这条链路的产物是要写进库的指标，编造 = 污染表现基线，比不可用糟得多。
// 只配 BEACON_VISION_LLM_MODEL 时，base/key 复用平台默认那套（同厂商换个模型的常见情形）。
function visionFromEnv(): LlmProvider | null {
  const model = process.env.BEACON_VISION_LLM_MODEL;
  if (!model) return null;
  const base = process.env.BEACON_VISION_LLM_BASE_URL || process.env.BEACON_DEFAULT_LLM_BASE_URL;
  const key = process.env.BEACON_VISION_LLM_API_KEY || process.env.BEACON_DEFAULT_LLM_API_KEY;
  if (!base || !key) return null;
  return new OpenAICompatibleProvider({ name: 'platform-vision', baseUrl: base, apiKey: key, model });
}

export type VisionResult =
  | { ok: true; text: string; model: string }
  | { ok: false; error: string; reason: 'not_configured' | 'failed' };

/**
 * 视觉调用：读图并返回文本/JSON。
 *
 * 与 llmComplete 的**关键差别：绝不降级到 Mock**。
 * llmComplete 降级是安全的（用户看到的是带「示例」标的内容）；这里的产物却会被写进
 * PublishRecord / PerformanceSnapshot，Mock 编出来的数字会永久污染表现基线和学习信号。
 * 所以没配视觉模型、或调用失败，一律如实返回失败，由调用方告诉用户。
 */
export async function llmVision(
  tenantId: string | null,
  messages: ChatMessage[],
  opts?: { temperature?: number; json?: boolean },
): Promise<VisionResult> {
  assertNotDemo(tenantId);
  const provider = visionFromEnv();
  if (!provider) {
    return { ok: false, reason: 'not_configured', error: '未配置视觉模型（需在服务端设置 BEACON_VISION_LLM_MODEL）' };
  }
  await assertLlmQuota(tenantId, 'platform'); // 真实付费调用，照常占额度
  try {
    const result = await provider.complete(messages, opts);
    await recordUsage(tenantId, 'scoring', result);
    return { ok: true, text: result.text, model: result.model };
  } catch (err) {
    await releaseLlmQuota(tenantId); // 调用失败不占名额，与 llmComplete 同口径
    return { ok: false, reason: 'failed', error: (err as Error).message.slice(0, 200) };
  }
}

// ─────────────────────────── 视频理解（火山方舟豆包）───────────────────────────
//
// 【为什么视频这条链路只走 BYOK，不设平台兜底】
// 一次视频调用的 token 量是一次文本调用的几十倍，而配额是**按次**计的（见 lib/quota.ts：
// free 档 30 次/天）。平台垫付一次视频 = 白送几十次文本的钱，却只扣 1 个名额——
// 这个洞在配额层补不了（改成按 token 计要动整个准入计数器）。所以视频的账必须记在
// 用户自己的 ARK Key 上：用户自己付，配额只当防跑飞护栏，两边都成立。
// 要开平台兜底的话是这里加一个 fromEnv()，但先想清楚上面这笔账。

export type VideoResult =
  | { ok: true; text: string; model: string }
  | { ok: false; error: string; reason: 'not_configured' | 'failed' };

/**
 * 找这个租户的方舟渠道。优先级：
 *   ① routing 里显式指到 video 的渠道 —— 用户自己指的，最高优先
 *   ② vendor=doubao 且模型名看着支持视频的 —— 「加了豆包渠道」本身就是意图
 *   ③ 任何 vendor=doubao 的渠道 —— 让方舟自己报「这个模型不支持视频」，
 *      那句报错比我们回一句「未配置」有用得多（用户明明配了）
 */
async function resolveVideoProvider(tenantId: string | null): Promise<LlmProvider | null> {
  if (!tenantId) return null;
  const providers = await prisma.modelProvider.findMany({
    where: { tenantId, status: { not: 'failed' } },
  });
  const ark = providers.filter((p) => p.vendor === 'doubao');
  if (!ark.length) return null;

  for (const p of ark) {
    const routing = parseJson<Record<string, string>>(p.routing, {});
    if (routing.video === p.id) return build(p);
  }
  return build(ark.find((p) => looksVideoCapable(p.model)) ?? ark[0]);
}

/**
 * 视频理解调用。产物是要写进库、要给用户当结论看的，所以口径与 llmVision 一致：
 * **绝不降级到 Mock**。没配渠道或调用失败，一律如实返回失败，由调用方告诉用户怎么办。
 */
export async function llmVideo(
  tenantId: string | null,
  messages: ChatMessage[],
  opts?: { temperature?: number; json?: boolean; timeoutMs?: number },
): Promise<VideoResult> {
  assertNotDemo(tenantId);
  const provider = await resolveVideoProvider(tenantId);
  if (!provider) {
    return {
      ok: false,
      reason: 'not_configured',
      error: `视频分析要用你自己的火山方舟 API Key。到「设置 → 模型渠道」加一个「火山引擎 豆包」渠道即可。${VIDEO_MODEL_HINT}`,
    };
  }
  await assertLlmQuota(tenantId, 'byok'); // 用户自付 token 费，配额只作防跑飞护栏
  try {
    // 视频推理是分钟级的，30s 默认预算必然超时——这里给 5 分钟。
    const result = await provider.complete(messages, { ...opts, timeoutMs: opts?.timeoutMs ?? VIDEO_TIMEOUT_MS });
    await recordUsage(tenantId, 'video', result);
    return { ok: true, text: result.text, model: result.model };
  } catch (err) {
    await releaseLlmQuota(tenantId); // 调用失败不占名额，与 llmComplete/llmVision 同口径
    return { ok: false, reason: 'failed', error: (err as Error).message.slice(0, 300) };
  }
}

/** 视频推理的单次超时预算。抽帧 + 长视频理解是分钟级，与文本的 30s 完全不是一个量级。 */
export const VIDEO_TIMEOUT_MS = 300_000;

// provider 来源：byok=租户自带 key（自付 token 费）；platform=平台垫付；mock=不花钱
type ProviderSource = QuotaSource | 'mock';

// 选择 provider（含按功能路由），并标明来源 —— 配额分档要靠它区分谁在花钱
async function resolveWithSource(
  tenantId: string | null,
  fn: LlmFunction,
  opts?: { allowOverseas?: boolean },
): Promise<{ provider: LlmProvider; source: ProviderSource }> {
  if (tenantId) {
    const providers = await prisma.modelProvider.findMany({
      where: { tenantId, status: { not: 'failed' } },
    });
    // 优先：routing 指定了该功能的 provider
    for (const p of providers) {
      const routing = parseJson<Record<string, string>>(p.routing, {});
      if (routing[fn] === p.id) {
        if (p.region === 'overseas' && !opts?.allowOverseas) continue;
        return { provider: build(p), source: 'byok' };
      }
    }
    // 次选：默认 provider
    const def = providers.find((p) => p.isDefault);
    if (def && (def.region !== 'overseas' || opts?.allowOverseas)) {
      return { provider: build(def), source: 'byok' };
    }
  }
  const env = fromEnv();
  return env ? { provider: env, source: 'platform' } : { provider: mock, source: 'mock' };
}

// 选择 provider（含按功能路由）
export async function resolveProvider(
  tenantId: string | null,
  fn: LlmFunction,
  opts?: { allowOverseas?: boolean },
): Promise<LlmProvider> {
  return (await resolveWithSource(tenantId, fn, opts)).provider;
}

function build(p: {
  label: string;
  baseUrl: string;
  apiKeyEnc: string;
  model: string;
}): LlmProvider {
  return new OpenAICompatibleProvider({
    name: p.label,
    baseUrl: p.baseUrl,
    apiKey: decryptKey(p.apiKeyEnc),
    model: p.model,
  });
}

// llmComplete 的返回：LlmResult 外加 degraded 标记。
// degraded=true 表示「真实 provider 失败，被 Mock 兜底」（此时 mocked 必为 true）——
// 调用方可据此提示用户「AI 服务暂时不稳定，本次为示例内容」。
export type LlmCompleteResult = LlmResult & { degraded?: boolean };

// 便捷调用：失败自动降级到 Mock，保证全站永不因 LLM 报错而崩；每次调用记账。
// 例外：配额超限会抛 QuotaExceededError —— 那是「按设计拒绝」，不能降级到 Mock 假装成功。
export async function llmComplete(
  tenantId: string | null,
  fn: LlmFunction,
  messages: ChatMessage[],
  opts?: { temperature?: number; json?: boolean; allowOverseas?: boolean; timeoutMs?: number },
): Promise<LlmCompleteResult> {
  assertNotDemo(tenantId); // 演示租户不烧 token（viewer 已挡住绝大多数入口，这里再兜一道）
  const { provider, source } = await resolveWithSource(tenantId, fn, { allowOverseas: opts?.allowOverseas });
  // 真实调用才校验配额；Mock 不花钱不占额度。故意放在下面 try 之外，让超限错误直达调用方。
  if (source !== 'mock') await assertLlmQuota(tenantId, source);
  let result: LlmCompleteResult;
  try {
    result = await provider.complete(messages, opts);
    // json 模式：真实响应必须能解析成 JSON。解析不出时调用方只会 parseJson→兜底默认值，却把这份
    // 模板/启发式结果标成真 AI（mocked=false，无「演示」标）——正是 review 指出的静默降级。
    // 处理：先重试一次（多为瞬时格式问题，重试即好）；仍解析不出则如实降级到 Mock（degraded=true，
    // 复用全站已有的「演示/Mock」徽标基建），并按「调用失败不占名额」口径归还配额。
    if (opts?.json && !result.mocked && !isParseableJson(result.text)) {
      log.warn('provider 返回非合法 JSON，重试一次', { provider: provider.name });
      result = await provider.complete(messages, opts);
      if (!isParseableJson(result.text)) {
        log.warn('provider 重试仍非合法 JSON，降级 Mock', { provider: provider.name });
        if (source !== 'mock') await releaseLlmQuota(tenantId);
        result = { ...(await mock.complete(messages, opts)), degraded: true };
      }
    }
  } catch (err) {
    // 真实 provider 失败 → 归还名额 → 降级 Mock，不阻断用户。
    // 归还是口径「调用失败不占名额」：降级结果记的是 mocked=true，账本（只统计
    // mocked=false）不涨；名额不还的话，provider 持续故障时用户会被一个
    // 仪表盘上显示为 0 的用量拦死。platform 与 BYOK 占额路径相同，一并归还。
    log.warn('provider 调用失败，降级 Mock', { provider: provider.name, error: (err as Error).message });
    if (source !== 'mock') await releaseLlmQuota(tenantId);
    result = { ...(await mock.complete(messages, opts)), degraded: true };
  }
  await recordUsage(tenantId, fn, result); // 记账（cheap，内部已 try/catch 不抛）
  return result;
}

/** json 模式的响应是否能被严格解析（与 lib/json.ts parseJson 同口径：JSON.parse 通过即可用）。 */
function isParseableJson(text: string): boolean {
  if (!text || !text.trim()) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export async function llmCompleteStream(
  tenantId: string | null,
  fn: LlmFunction,
  messages: ChatMessage[],
  opts?: { temperature?: number; allowOverseas?: boolean },
): Promise<ReadableStream<string>> {
  assertNotDemo(tenantId); // 演示租户不烧 token
  const { provider, source } = await resolveWithSource(tenantId, fn, { allowOverseas: opts?.allowOverseas });
  if (source !== 'mock') await assertLlmQuota(tenantId, source);
  let fullText = '';
  let logged = false;
  const iter = provider.stream(messages, opts)[Symbol.asyncIterator]();

  // 记账必须**恰好一次**，且三条出口都要覆盖：正常读完、客户端中途断开、出错。
  // 为什么这条不能漏：assertLlmQuota 是用 llmCallLog.count 重建当日/当月计数器的
  // （见 lib/quota.ts），少一条记录就等于配额被低估——流式接口会悄悄变成不计费通道。
  const logOnce = async () => {
    if (logged) return;
    logged = true;
    await recordUsage(tenantId, fn, {
      text: fullText,
      provider: provider.name,
      model: provider.model,
      mocked: provider.mocked,
      usage: { promptTokens: 0, completionTokens: Math.round(fullText.length / 3) },
    });
  };

  return new ReadableStream<string>({
    async pull(controller) {
      try {
        const { done, value } = await iter.next();
        if (done) {
          // 必须 await 再 close：不 await 的话这条 insert 会与请求结束赛跑，可能被丢掉
          await logOnce();
          controller.close();
          return;
        }
        fullText += value;
        controller.enqueue(value);
      } catch (err) {
        if (source !== 'mock') await releaseLlmQuota(tenantId);
        controller.error(err);
      }
    },
    // 客户端断开（关页面/切走）：pull 不会再被调用，done 分支永远到不了。
    // 已经产出的部分是真实消耗，照常记账。
    async cancel() {
      await logOnce();
      await iter.return?.();
    },
  });
}

// 写入成本账本（单租户单位经济仪表盘数据源）
async function recordUsage(tenantId: string | null, fn: LlmFunction, r: LlmResult) {
  try {
    const pt = r.usage?.promptTokens ?? 0;
    const ct = r.usage?.completionTokens ?? 0;
    await prisma.llmCallLog.create({
      data: {
        tenantId: tenantId ?? undefined,
        fn,
        provider: r.provider,
        model: r.model,
        mocked: r.mocked,
        promptTokens: pt,
        completionTokens: ct,
        costUsd: estimateCostUsd(r.model, pt, ct, r.mocked),
      },
    });
  } catch (e) {
    log.warn('recordUsage failed', { error: (e as Error).message });
  }
}

export { mock };
