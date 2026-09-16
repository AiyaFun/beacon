import { prisma } from '../../db';
import { encryptKey, decryptKey } from '../../crypto';
import { parseJson, toJson } from '../../json';
import { createLogger } from '../../logger';
import { CHATGPT_CODEX_BASE, type ChatgptTokens } from './auth';
import { ChatgptSubscriptionProvider } from './provider';
import { DEFAULT_CHATGPT_MODEL, CHATGPT_REASONING_EFFORTS, type ReasoningEffort, type ChatgptChannelView } from './types';

export type { ChatgptChannelView } from './types';

const log = createLogger({ module: 'llm-chatgpt' });

// ChatGPT 订阅渠道在库里的样子（2026-09-15）：复用 ModelProvider 一行，vendor='chatgpt'，
// apiKeyEnc 里放的不是 Key，是信封加密后的 { v:1, tokens, effort }。
// 复用而不新建表的理由：选路、按功能路由、默认渠道、模型选择器、连通性测试这一整套都认 ModelProvider，
// 新建一张表等于把这套全抄一遍。region 记 overseas（它就是海外模型）；能不能用由 lib/edition 的 overseasLlm 决定。

export const CHATGPT_VENDOR = 'chatgpt';
export const CHATGPT_LABEL = 'ChatGPT 订阅';

type Secret = { v: 1; tokens: ChatgptTokens; effort?: ReasoningEffort };

export type ChatgptChannelRow = {
  id: string;
  tenantId: string;
  label: string;
  model: string;
  status: string;
  isDefault: boolean;
  /** 按功能路由 JSON（与其它渠道同一列）：image 指到自己 = 用户明确要它生图 */
  routing: string;
  apiKeyEnc: string;
};

function readSecret(apiKeyEnc: string): Secret | null {
  const s = parseJson<Partial<Secret>>(decryptKey(apiKeyEnc), {});
  if (!s || s.v !== 1 || !s.tokens || !s.tokens.access || !s.tokens.refresh || !s.tokens.accountId) return null;
  return { v: 1, tokens: s.tokens, effort: s.effort };
}

function writeSecret(s: Secret): string {
  return encryptKey(toJson(s));
}

export async function getChatgptChannel(tenantId: string): Promise<ChatgptChannelRow | null> {
  const row = await prisma.modelProvider.findFirst({ where: { tenantId, vendor: CHATGPT_VENDOR }, orderBy: { createdAt: 'asc' } });
  return row
    ? { id: row.id, tenantId: row.tenantId, label: row.label, model: row.model, status: row.status, isDefault: row.isDefault, routing: row.routing, apiKeyEnc: row.apiKeyEnc }
    : null;
}

/** 给界面看的状态：不含任何 token（类型在 ./types，客户端也引）。 */
export function chatgptChannelView(row: ChatgptChannelRow): ChatgptChannelView | null {
  const s = readSecret(row.apiKeyEnc);
  if (!s) return null;
  return {
    id: row.id,
    model: row.model,
    effort: s.effort ?? 'medium',
    status: row.status,
    isDefault: row.isDefault,
    email: s.tokens.email,
    plan: s.tokens.plan,
    // 只露账号 id 的尾巴，够用户认出是哪个号
    accountId: s.tokens.accountId.length > 8 ? `…${s.tokens.accountId.slice(-6)}` : s.tokens.accountId,
    lastRefresh: s.tokens.lastRefresh,
    expiresAt: s.tokens.expiresAt,
  };
}

/** 登录/导入成功后落库：已有这一行就换 token（保留模型与路由），没有就建；首条渠道自动设默认。 */
export async function saveChatgptChannel(tenantId: string, tokens: ChatgptTokens, opts: { model?: string } = {}): Promise<{ id: string }> {
  const existing = await getChatgptChannel(tenantId);
  if (existing) {
    const prev = readSecret(existing.apiKeyEnc);
    await prisma.modelProvider.update({
      where: { id: existing.id },
      data: { apiKeyEnc: writeSecret({ v: 1, tokens, effort: prev?.effort }), status: 'untested', ...(opts.model ? { model: opts.model } : {}) },
    });
    log.info('ChatGPT 订阅渠道已重新登录', { tenantId, providerId: existing.id });
    return { id: existing.id };
  }
  const count = await prisma.modelProvider.count({ where: { tenantId } });
  const row = await prisma.modelProvider.create({
    data: {
      tenantId,
      label: CHATGPT_LABEL,
      vendor: CHATGPT_VENDOR,
      baseUrl: CHATGPT_CODEX_BASE,
      apiKeyEnc: writeSecret({ v: 1, tokens }),
      model: opts.model || DEFAULT_CHATGPT_MODEL,
      region: 'overseas',
      status: 'untested',
      isDefault: count === 0,
    },
  });
  log.info('ChatGPT 订阅渠道已接入', { tenantId, providerId: row.id, isDefault: count === 0 });
  return { id: row.id };
}

/** 刷新出新 token 后回写（provider 的 onTokens）。行没了就算了——用户可能刚断开。 */
export async function updateChatgptTokens(providerId: string, tokens: ChatgptTokens): Promise<void> {
  const row = await prisma.modelProvider.findUnique({ where: { id: providerId }, select: { apiKeyEnc: true, vendor: true } });
  if (!row || row.vendor !== CHATGPT_VENDOR) return;
  const prev = readSecret(row.apiKeyEnc);
  await prisma.modelProvider.update({ where: { id: providerId }, data: { apiKeyEnc: writeSecret({ v: 1, tokens, effort: prev?.effort }) } });
}

export async function setChatgptModel(tenantId: string, model: string, effort: ReasoningEffort): Promise<{ ok: boolean; error?: string }> {
  const m = model.trim();
  if (!m || m.length > 64 || !/^[\w.:-]+$/.test(m)) return { ok: false, error: '模型名只能是字母、数字、点、横线' };
  if (!CHATGPT_REASONING_EFFORTS.includes(effort)) return { ok: false, error: '推理强度只能是 low / medium / high' };
  const row = await getChatgptChannel(tenantId);
  if (!row) return { ok: false, error: '还没接入 ChatGPT 订阅' };
  const s = readSecret(row.apiKeyEnc);
  if (!s) return { ok: false, error: '登录态损坏，请重新登录' };
  await prisma.modelProvider.update({ where: { id: row.id }, data: { model: m, status: 'untested', apiKeyEnc: writeSecret({ ...s, effort }) } });
  return { ok: true };
}

export async function removeChatgptChannel(tenantId: string): Promise<boolean> {
  const r = await prisma.modelProvider.deleteMany({ where: { tenantId, vendor: CHATGPT_VENDOR } });
  return r.count > 0;
}

/** 把库里那一行变成能调用的 provider；刷新出的新 token 自动回写。 */
export function chatgptProviderFromRow(row: { id: string; label: string; model: string; apiKeyEnc: string }): ChatgptSubscriptionProvider {
  const s = readSecret(row.apiKeyEnc);
  if (!s) throw new Error('ChatGPT 订阅渠道的登录态损坏，请到「接入与密钥」重新登录');
  return new ChatgptSubscriptionProvider({
    name: row.label || CHATGPT_LABEL,
    model: row.model,
    tokens: s.tokens,
    effort: s.effort,
    onTokens: (t) => updateChatgptTokens(row.id, t),
  });
}

/** 连通性测试：发一句 ping。与 pingProvider 同口径（失败取前 120 字）。 */
export async function pingChatgptChannel(tenantId: string): Promise<{ ok: boolean; status: 'ok' | 'failed'; detail: string }> {
  const row = await getChatgptChannel(tenantId);
  if (!row) return { ok: false, status: 'failed', detail: '还没接入 ChatGPT 订阅' };
  try {
    const p = chatgptProviderFromRow(row);
    const r = await p.complete([{ role: 'user', content: '回复 ok' }], { timeoutMs: 60_000 });
    await prisma.modelProvider.update({ where: { id: row.id }, data: { status: 'ok' } });
    return { ok: true, status: 'ok', detail: `连通正常（${r.model}）` };
  } catch (e) {
    const msg = (e as Error).message;
    // 额度用完不是坏渠道：token 到得了服务端。只有鉴权类才判 failed（判了会被选路排除）
    const quota = /额度用完/.test(msg);
    await prisma.modelProvider.update({ where: { id: row.id }, data: { status: quota ? 'ok' : 'failed' } });
    return { ok: quota, status: quota ? 'ok' : 'failed', detail: msg.slice(0, 120) };
  }
}
