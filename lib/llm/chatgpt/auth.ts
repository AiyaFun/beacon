import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ChatGPT 订阅登录（Codex OAuth，2026-09-15）。
//
// 【这条路是什么】OpenClaw / Hermes 用的就是它：不是去 spawn `codex` 二进制，而是把 Codex CLI 的登录协议
// 搬过来——device-code OAuth 拿到 access/refresh token，之后按 Responses API 的形状直接调
// chatgpt.com/backend-api/codex（见 ./provider.ts）。OpenAI 2026-05 起明确允许第三方工具走订阅 OAuth
//（openclaw onboard --auth-choice openai-codex 就是官方给的路）。
//
// 【只做 device-code，不做本机回调】Codex CLI 的浏览器登录要在本机 1455 端口起回调服务，注册的 redirect_uri
// 是固定的；整机版是个网页应用，端口/地址都对不上。device-code 只要用户在浏览器里输一个码，
// 天然适合网页：起码 → 显示码与链接 → 轮询 → 拿到 token。另有「从本机 Codex CLI 导入」一条：
// 用户机器上已经 `codex login` 过的话，直接读 ~/.codex/auth.json（Hermes 也这么做）。
//
// 🔒 边界：token 只进 ModelProvider.apiKeyEnc（信封加密），不进日志、不回显；密码永远不经过我们
//（登录页是 OpenAI 的）；SaaS 恒关（lib/edition.ts chatgptSubscription），订阅是用户个人的，平台不能替他用。
// 常量与 Codex CLI（codex-rs/login）/ pi-mono（OpenClaw 的模型层）对齐，改之前先看它们最新的源码。

export const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CHATGPT_AUTH_BASE = 'https://auth.openai.com';
/** 用户在浏览器里打开、输入设备码的页面 */
export const CHATGPT_DEVICE_VERIFY_URL = `${CHATGPT_AUTH_BASE}/codex/device`;
/** Codex 后端（Responses API 形状，只认订阅 token） */
export const CHATGPT_CODEX_BASE = 'https://chatgpt.com/backend-api/codex';

/** 端点集中一处，测试用本机 http server 顶替 */
export const chatgptEndpoints = {
  tokenUrl: `${CHATGPT_AUTH_BASE}/oauth/token`,
  deviceUserCodeUrl: `${CHATGPT_AUTH_BASE}/api/accounts/deviceauth/usercode`,
  deviceTokenUrl: `${CHATGPT_AUTH_BASE}/api/accounts/deviceauth/token`,
  /** device-code 换 token 时的 redirect_uri：不是我们的地址，是 OpenAI 自己那个回调页（照 Codex CLI） */
  deviceCallbackUrl: `${CHATGPT_AUTH_BASE}/api/accounts/deviceauth/callback`,
};

/** 测试用：整体顶替端点，返回还原函数。 */
export function overrideChatgptEndpointsForTest(next: Partial<typeof chatgptEndpoints>): () => void {
  const prev = { ...chatgptEndpoints };
  Object.assign(chatgptEndpoints, next);
  return () => Object.assign(chatgptEndpoints, prev);
}

const JWT_AUTH_CLAIM = 'https://api.openai.com/auth';
const JWT_PROFILE_CLAIM = 'https://api.openai.com/profile';

export type ChatgptTokens = {
  access: string;
  refresh: string;
  idToken?: string;
  /** chatgpt-account-id 请求头要用；从 id_token / access_token 的 JWT claims 里取 */
  accountId: string;
  email?: string;
  /** free / plus / pro / team … 只作展示 */
  plan?: string;
  /** access token 到期（ms）。0 = 不知道，按 lastRefresh 推 */
  expiresAt: number;
  lastRefresh: number;
};

export class ChatgptAuthError extends Error {
  /** true = 刷新 token 也救不回来（invalid_grant / 被吊销），要用户重新登录 */
  readonly terminal: boolean;
  constructor(message: string, terminal = false) {
    super(message);
    this.name = 'ChatgptAuthError';
    this.terminal = terminal;
  }
}

/** 解 JWT 的 payload 段（base64url，不验签——只是读自己 token 里的账号信息，不拿它做鉴权） */
export function decodeJwtClaims(jwt: string | undefined | null): Record<string, unknown> {
  if (!jwt) return {};
  const parts = jwt.split('.');
  if (parts.length < 2) return {};
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const v = JSON.parse(json);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 从 id_token（优先）或 access_token 的 claims 里读账号信息。accountId 取不到就是登录没成功。 */
export function identityFromTokens(idToken: string | undefined, accessToken: string): { accountId: string; email?: string; plan?: string; exp?: number } {
  const pick = (jwt: string | undefined) => {
    const c = decodeJwtClaims(jwt);
    const auth = (c[JWT_AUTH_CLAIM] ?? {}) as Record<string, unknown>;
    const profile = (c[JWT_PROFILE_CLAIM] ?? {}) as Record<string, unknown>;
    return {
      accountId: typeof auth.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : '',
      plan: typeof auth.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : undefined,
      email: typeof profile.email === 'string' ? profile.email : typeof c.email === 'string' ? c.email : undefined,
      exp: typeof c.exp === 'number' ? c.exp : undefined,
    };
  };
  const a = pick(idToken);
  const b = pick(accessToken);
  return {
    accountId: a.accountId || b.accountId,
    email: a.email ?? b.email,
    plan: a.plan ?? b.plan,
    exp: b.exp ?? a.exp,
  };
}

function tokensFrom(raw: { id_token?: string; access_token?: string; refresh_token?: string; expires_in?: number }, prev?: ChatgptTokens): ChatgptTokens {
  const access = raw.access_token ?? '';
  const refresh = raw.refresh_token ?? prev?.refresh ?? '';
  if (!access || !refresh) throw new ChatgptAuthError('OpenAI 没有返回完整的 token');
  const id = identityFromTokens(raw.id_token ?? prev?.idToken, access);
  const accountId = id.accountId || prev?.accountId || '';
  if (!accountId) throw new ChatgptAuthError('token 里没有 ChatGPT 账号 id（这个账号可能没有 Codex 权限）');
  const now = Date.now();
  const expiresAt = typeof raw.expires_in === 'number' ? now + raw.expires_in * 1000 : id.exp ? id.exp * 1000 : 0;
  return { access, refresh, idToken: raw.id_token ?? prev?.idToken, accountId, email: id.email ?? prev?.email, plan: id.plan ?? prev?.plan, expiresAt, lastRefresh: now };
}

export type DeviceLoginStart = { deviceAuthId: string; userCode: string; verifyUrl: string; intervalSec: number };

/** 第一步：要一个设备码。用户去 verifyUrl 输入 userCode。 */
export async function startChatgptDeviceLogin(fetchImpl: typeof fetch = fetch): Promise<DeviceLoginStart> {
  const res = await fetchImpl(chatgptEndpoints.deviceUserCodeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CHATGPT_CLIENT_ID }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new ChatgptAuthError(`OpenAI 不给设备码（HTTP ${res.status}）：${(await res.text().catch(() => '')).slice(0, 160)}`);
  const v = (await res.json()) as { device_auth_id?: string; user_code?: string; usercode?: string; interval?: number | string };
  const deviceAuthId = v.device_auth_id ?? '';
  const userCode = v.user_code ?? v.usercode ?? '';
  if (!deviceAuthId || !userCode) throw new ChatgptAuthError('OpenAI 返回的设备码不完整');
  const intervalSec = Math.min(30, Math.max(2, Number(v.interval) || 5));
  return { deviceAuthId, userCode, verifyUrl: CHATGPT_DEVICE_VERIFY_URL, intervalSec };
}

export type DevicePoll = { status: 'pending' } | { status: 'done'; tokens: ChatgptTokens } | { status: 'error'; error: string };

/**
 * 第二步：轮询一次。用户还没输码时 OpenAI 回 403/404（照 Codex CLI 的处理）；输完了回
 * authorization_code + code_verifier，再拿它们换 token。调用方按 intervalSec 反复调，最多 15 分钟。
 */
export async function pollChatgptDeviceLogin(deviceAuthId: string, userCode: string, fetchImpl: typeof fetch = fetch): Promise<DevicePoll> {
  const res = await fetchImpl(chatgptEndpoints.deviceTokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 403 || res.status === 404) return { status: 'pending' };
  if (!res.ok) return { status: 'error', error: `OpenAI 拒绝了这次登录（HTTP ${res.status}）：${(await res.text().catch(() => '')).slice(0, 160)}` };
  const v = (await res.json()) as { authorization_code?: string; code_verifier?: string };
  if (!v.authorization_code || !v.code_verifier) return { status: 'error', error: 'OpenAI 返回的授权码不完整' };
  try {
    return { status: 'done', tokens: await exchangeDeviceCode(v.authorization_code, v.code_verifier, fetchImpl) };
  } catch (e) {
    return { status: 'error', error: (e as Error).message };
  }
}

/** 授权码 → token（照 Codex CLI：form-urlencoded，redirect_uri 是 OpenAI 自己的设备码回调页） */
async function exchangeDeviceCode(code: string, codeVerifier: string, fetchImpl: typeof fetch): Promise<ChatgptTokens> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: chatgptEndpoints.deviceCallbackUrl,
    client_id: CHATGPT_CLIENT_ID,
    code_verifier: codeVerifier,
  });
  const res = await fetchImpl(chatgptEndpoints.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new ChatgptAuthError(`换 token 失败（HTTP ${res.status}）：${(await res.text().catch(() => '')).slice(0, 160)}`);
  return tokensFrom((await res.json()) as Parameters<typeof tokensFrom>[0]);
}

/** access token 快到期（5 分钟内）或太久没刷（8 天，照 Codex CLI）就刷。 */
export function chatgptTokensNeedRefresh(t: ChatgptTokens, now = Date.now()): boolean {
  if (t.expiresAt > 0) return t.expiresAt - now < 5 * 60_000;
  return now - t.lastRefresh > 8 * 24 * 3_600_000;
}

/**
 * 用 refresh token 换新 token。照 Codex CLI 发 JSON（client_id / grant_type / refresh_token / scope）。
 * invalid_grant 之类的 4xx = 登录被吊销或过期，抛 terminal 错，让用户重新登录；网络类错误不算 terminal。
 */
export async function refreshChatgptTokens(t: ChatgptTokens, fetchImpl: typeof fetch = fetch): Promise<ChatgptTokens> {
  const res = await fetchImpl(chatgptEndpoints.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CHATGPT_CLIENT_ID, grant_type: 'refresh_token', refresh_token: t.refresh, scope: 'openid profile email' }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 160);
    const terminal = res.status >= 400 && res.status < 500;
    throw new ChatgptAuthError(
      terminal ? `ChatGPT 登录已失效（${text || `HTTP ${res.status}`}），请到「接入与密钥」重新登录` : `刷新 ChatGPT 登录失败（HTTP ${res.status}）：${text}`,
      terminal,
    );
  }
  return tokensFrom((await res.json()) as Parameters<typeof tokensFrom>[0], t);
}

/** Codex CLI 的登录态文件（用户机器上 `codex login` 留下的），与它同目录的 config.toml 里有默认模型。 */
export function codexCliAuthPath(): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
}

export function codexCliAvailable(): boolean {
  try {
    return fs.existsSync(codexCliAuthPath());
  } catch {
    return false;
  }
}

/**
 * 从本机 Codex CLI 导入登录态（Hermes 同款）。只在整机版/私有化调用——那台机器就是用户自己的电脑。
 * auth.json 形状：{ auth_mode, OPENAI_API_KEY, tokens: { id_token, access_token, refresh_token, account_id }, last_refresh }。
 */
export function importChatgptTokensFromCodexCli(file = codexCliAuthPath()): { tokens: ChatgptTokens; model?: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new ChatgptAuthError(`这台机器上没有 Codex CLI 的登录态（${file}）。先在终端里跑一次 \`codex login\`，或改用上面的「用 ChatGPT 账号登录」。`);
  }
  let j: { tokens?: { id_token?: string; access_token?: string; refresh_token?: string; account_id?: string }; last_refresh?: string };
  try {
    j = JSON.parse(raw);
  } catch {
    throw new ChatgptAuthError('Codex CLI 的 auth.json 不是合法 JSON');
  }
  const tk = j.tokens ?? {};
  if (!tk.access_token || !tk.refresh_token) throw new ChatgptAuthError('Codex CLI 当前不是用 ChatGPT 账号登录的（auth.json 里没有订阅 token），先 `codex login` 用 ChatGPT 登录一次');
  const id = identityFromTokens(tk.id_token, tk.access_token);
  const accountId = tk.account_id || id.accountId;
  if (!accountId) throw new ChatgptAuthError('auth.json 里没有 ChatGPT 账号 id');
  const lastRefresh = j.last_refresh ? Date.parse(j.last_refresh) || Date.now() : Date.now();
  const tokens: ChatgptTokens = {
    access: tk.access_token,
    refresh: tk.refresh_token,
    idToken: tk.id_token,
    accountId,
    email: id.email,
    plan: id.plan,
    expiresAt: id.exp ? id.exp * 1000 : 0,
    lastRefresh,
  };
  // 同目录 config.toml 里的 `model = "..."`：用户在 Codex 里用惯的那个，比我们猜一个强
  let model: string | undefined;
  try {
    const toml = fs.readFileSync(path.join(path.dirname(file), 'config.toml'), 'utf8');
    const m = toml.match(/^\s*model\s*=\s*"([^"\n]+)"/m);
    if (m) model = m[1].trim();
  } catch { /* 没有 config.toml 就用默认模型 */ }
  return { tokens, model };
}
