import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '@/lib/db';
import {
  decodeJwtClaims, identityFromTokens, chatgptTokensNeedRefresh, importChatgptTokensFromCodexCli,
  overrideChatgptEndpointsForTest, startChatgptDeviceLogin, pollChatgptDeviceLogin, CHATGPT_CLIENT_ID, type ChatgptTokens,
} from '@/lib/llm/chatgpt/auth';
import { ChatgptSubscriptionProvider, toResponsesInput, toResponsesTools, feedResponsesEvent } from '@/lib/llm/chatgpt/provider';
import { saveChatgptChannel, getChatgptChannel, chatgptChannelView, CHATGPT_VENDOR, CHATGPT_LABEL } from '@/lib/llm/chatgpt/channel';
import { resolveProvider } from '@/lib/llm/gateway';
import { openaiImageSize } from '@/lib/llm/image';
import { can } from '@/lib/edition';

// ChatGPT 订阅渠道（2026-09-15）：OpenClaw / Hermes 那条路——device-code OAuth + Responses API 直调 Codex 后端。
// 这里不碰真网：登录端点与 Codex 后端都用本机 http server 顶替，验的是协议形状（头/体/SSE/刷新/限额）与接线。

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const b64url = (s: string) => Buffer.from(s).toString('base64url');
const jwt = (payload: Record<string, unknown>) => `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify(payload))}.sig`;
const CLAIMS = {
  'https://api.openai.com/auth': { chatgpt_account_id: 'acct_abcdef123456', chatgpt_plan_type: 'plus' },
  'https://api.openai.com/profile': { email: 'me@example.com' },
  exp: Math.floor(Date.now() / 1000) + 3600,
};
const freshTokens = (): ChatgptTokens => ({
  access: jwt(CLAIMS), refresh: 'r1', idToken: jwt(CLAIMS), accountId: 'acct_abcdef123456', email: 'me@example.com', plan: 'plus',
  expiresAt: Date.now() + 3600_000, lastRefresh: Date.now(),
});

type Req = { url: string; headers: http.IncomingHttpHeaders; body: unknown; raw: string };
type Reply = { status?: number; events?: Record<string, unknown>[]; json?: unknown };
const servers: http.Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));
afterEach(() => vi.unstubAllEnvs());

async function serve(handler: (req: Req, n: number) => Reply): Promise<{ base: string; reqs: Req[] }> {
  const reqs: Req[] = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: unknown = raw;
      try { body = JSON.parse(raw); } catch { /* form 或空体 */ }
      const r: Req = { url: req.url ?? '', headers: req.headers, body, raw };
      reqs.push(r);
      const reply = handler(r, reqs.length);
      if (reply.events) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const ev of reply.events) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
        res.end();
        return;
      }
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.json ?? {}));
    });
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, reqs };
}

const TOOL_TURN = [
  { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC', summary: [{ type: 'summary_text', text: '想了想' }] } },
  { type: 'response.output_text.delta', delta: '好的，' },
  { type: 'response.output_text.delta', delta: '我来建草稿' },
  { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'create_draft', arguments: '{"title":"x"}' } },
  { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } },
];

describe('登录态：JWT 与刷新判据', () => {
  it('从 id_token / access_token 的 claims 读账号 id、套餐、邮箱', () => {
    expect(decodeJwtClaims('not-a-jwt')).toEqual({});
    const id = identityFromTokens(jwt(CLAIMS), jwt({ exp: 1 }));
    expect(id).toMatchObject({ accountId: 'acct_abcdef123456', plan: 'plus', email: 'me@example.com' });
    // 只有 access_token 也行（Codex CLI 的 auth.json 有时 id_token 是旧的）
    expect(identityFromTokens(undefined, jwt(CLAIMS)).accountId).toBe('acct_abcdef123456');
  });

  it('快到期 / 太久没刷才刷；不知道到期时间按 8 天算（照 Codex CLI）', () => {
    const t = freshTokens();
    expect(chatgptTokensNeedRefresh(t)).toBe(false);
    expect(chatgptTokensNeedRefresh({ ...t, expiresAt: Date.now() + 60_000 })).toBe(true);
    expect(chatgptTokensNeedRefresh({ ...t, expiresAt: 0, lastRefresh: Date.now() - 9 * 86_400_000 })).toBe(true);
    expect(chatgptTokensNeedRefresh({ ...t, expiresAt: 0, lastRefresh: Date.now() - 86_400_000 })).toBe(false);
  });

  it('从本机 Codex CLI 导入：读 auth.json 的 tokens 与 config.toml 的默认模型', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-'));
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt', OPENAI_API_KEY: null,
      tokens: { id_token: jwt(CLAIMS), access_token: jwt(CLAIMS), refresh_token: 'rt', account_id: 'acct_abcdef123456' },
      last_refresh: new Date(Date.now() - 3600_000).toISOString(),
    }));
    fs.writeFileSync(path.join(dir, 'config.toml'), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\n');
    const r = importChatgptTokensFromCodexCli(path.join(dir, 'auth.json'));
    expect(r.model).toBe('gpt-6-astra');
    expect(r.tokens).toMatchObject({ refresh: 'rt', accountId: 'acct_abcdef123456', email: 'me@example.com' });
    expect(r.tokens.lastRefresh).toBeLessThan(Date.now() - 3000_000);
    // 没有订阅 token（用 API Key 登录的 Codex）要说清
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x', tokens: null }));
    expect(() => importChatgptTokensFromCodexCli(path.join(dir, 'auth.json'))).toThrow(/ChatGPT 账号登录/);
    expect(() => importChatgptTokensFromCodexCli(path.join(dir, 'nope.json'))).toThrow(/codex login/);
  });

  it('device-code 登录：要码 → 用户没输时 403 算等待 → 输了拿授权码换 token（form-urlencoded，带 code_verifier）', async () => {
    let polls = 0;
    const { base, reqs } = await serve((req) => {
      if (req.url === '/usercode') return { json: { device_auth_id: 'd1', user_code: 'ABCD-1234', interval: 1 } };
      if (req.url === '/devtoken') return ++polls === 1 ? { status: 403, json: {} } : { json: { authorization_code: 'code1', code_verifier: 'ver1' } };
      if (req.url === '/token') return { json: { id_token: jwt(CLAIMS), access_token: jwt(CLAIMS), refresh_token: 'r-new', expires_in: 3600 } };
      return { status: 404, json: {} };
    });
    const restore = overrideChatgptEndpointsForTest({ deviceUserCodeUrl: `${base}/usercode`, deviceTokenUrl: `${base}/devtoken`, tokenUrl: `${base}/token` });
    try {
      const s = await startChatgptDeviceLogin();
      expect(s).toMatchObject({ deviceAuthId: 'd1', userCode: 'ABCD-1234', intervalSec: 2 });
      expect(s.verifyUrl).toContain('auth.openai.com/codex/device');
      expect((reqs[0].body as { client_id: string }).client_id).toBe(CHATGPT_CLIENT_ID);
      expect(await pollChatgptDeviceLogin('d1', 'ABCD-1234')).toEqual({ status: 'pending' });
      const done = await pollChatgptDeviceLogin('d1', 'ABCD-1234');
      expect(done.status).toBe('done');
      if (done.status !== 'done') return;
      expect(done.tokens).toMatchObject({ refresh: 'r-new', accountId: 'acct_abcdef123456', plan: 'plus' });
      const form = new URLSearchParams(reqs[reqs.length - 1].raw);
      expect(form.get('grant_type')).toBe('authorization_code');
      expect(form.get('code')).toBe('code1');
      expect(form.get('code_verifier')).toBe('ver1');
      expect(form.get('client_id')).toBe(CHATGPT_CLIENT_ID);
      expect(form.get('redirect_uri')).toContain('deviceauth/callback');
    } finally {
      restore();
    }
  });
});

describe('协议翻译：ChatMessage ↔ Responses API', () => {
  it('system 合并进 instructions；user/assistant/tool 各归各位；推理项排在它的 function_call 前面', () => {
    const { instructions, input } = toResponsesInput([
      { role: 'system', content: '你是编辑' },
      { role: 'system', content: '只说中文' },
      { role: 'user', content: '写个标题' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'create_draft', arguments: '{"a":1}', reasoning: JSON.stringify({ type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC', summary: [] }) }] },
      { role: 'tool', content: '{"ok":true}', toolCallId: 'call_1' },
    ], { json: true });
    expect(instructions).toContain('你是编辑');
    expect(instructions).toContain('只说中文');
    expect(instructions).toContain('只输出合法的 JSON');
    expect(input.map((i) => i.type)).toEqual(['message', 'reasoning', 'function_call', 'function_call_output']);
    expect(input[1]).toMatchObject({ id: 'rs_1', encrypted_content: 'ENC' });
    expect(input[2]).toMatchObject({ call_id: 'call_1', name: 'create_draft', arguments: '{"a":1}' });
    expect(input[3]).toMatchObject({ call_id: 'call_1', output: '{"ok":true}' });
    // 没有 system 时 instructions 也不能为空（Codex 后端硬要求）
    expect(toResponsesInput([{ role: 'user', content: 'hi' }]).instructions.length).toBeGreaterThan(0);
    // 图片当 input_image
    const img = toResponsesInput([{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] }]).input[0];
    expect((img.content as { type: string }[]).map((c) => c.type)).toEqual(['input_text', 'input_image']);
  });

  it('工具定义翻成 Responses 的 function 形状', () => {
    expect(toResponsesTools([{ name: 'f', description: 'd', parameters: { type: 'object' } }])).toEqual([{ type: 'function', name: 'f', description: 'd', parameters: { type: 'object' }, strict: false }]);
    expect(toResponsesTools([])).toBeUndefined();
  });

  it('SSE 事件：文本增量 / 工具调用 / 推理项 / 用量 / 出错', () => {
    const acc = { text: '', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 }, images: [], textFromDelta: false } as Parameters<typeof feedResponsesEvent>[0];
    for (const ev of TOOL_TURN) feedResponsesEvent(acc, ev);
    expect(acc.text).toBe('好的，我来建草稿');
    expect(acc.toolCalls).toEqual([{ id: 'call_1', name: 'create_draft', arguments: '{"title":"x"}' }]);
    expect(JSON.parse(acc.reasoningItem!)).toEqual({ type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC', summary: [] });
    expect(acc.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
    expect(() => feedResponsesEvent(acc, { type: 'error', error: { message: 'usage_limit_reached' } })).toThrow(/额度用完/);
    expect(() => feedResponsesEvent(acc, { type: 'response.failed', response: { error: { message: 'boom' } } })).toThrow(/boom/);
  });
});

describe('ChatgptSubscriptionProvider：直调 Codex 后端', () => {
  it('🔒 请求头/体与 Codex CLI 对齐；结果带文本、工具调用（推理项挂第一条）与用量', async () => {
    const { base, reqs } = await serve(() => ({ events: TOOL_TURN }));
    const p = new ChatgptSubscriptionProvider({ name: 'gpt', model: 'gpt-6-astra', tokens: freshTokens(), baseUrl: base });
    const r = await p.complete([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }], { tools: [{ name: 'create_draft', description: 'd', parameters: {} }] });
    expect(r.text).toBe('好的，我来建草稿');
    expect(r.toolCalls?.[0]).toMatchObject({ id: 'call_1', name: 'create_draft' });
    expect(r.toolCalls?.[0].reasoning).toContain('ENC');
    expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
    const req = reqs[0];
    expect(req.url).toBe('/responses');
    expect(req.headers.authorization).toBe(`Bearer ${p['tokens'].access}`);
    expect(req.headers['chatgpt-account-id']).toBe('acct_abcdef123456');
    expect(req.headers['openai-beta']).toBe('responses=experimental');
    expect(req.headers.originator).toBe('beacon');
    const body = req.body as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'gpt-6-astra', store: false, stream: true, instructions: 'S', tool_choice: 'auto' });
    expect(body.include).toEqual(['reasoning.encrypted_content']);
    expect((body.tools as { name: string }[])[0].name).toBe('create_draft');
  });

  it('🔒 401 → 用 refresh token 换新 → 重发一次，新 token 回写（onTokens）', async () => {
    const { base, reqs } = await serve((req, n) => {
      if (req.url === '/token') return { json: { id_token: jwt(CLAIMS), access_token: 'ACCESS-NEW', refresh_token: 'r2', expires_in: 3600 } };
      return n === 1 ? { status: 401, json: { error: { message: 'expired' } } } : { events: [{ type: 'response.output_text.delta', delta: 'ok' }, { type: 'response.completed', response: { usage: {} } }] };
    });
    const restore = overrideChatgptEndpointsForTest({ tokenUrl: `${base}/token` });
    const saved: ChatgptTokens[] = [];
    try {
      const p = new ChatgptSubscriptionProvider({ name: 'gpt', tokens: freshTokens(), baseUrl: base, onTokens: async (t) => { saved.push(t); } });
      const r = await p.complete([{ role: 'user', content: 'U' }]);
      expect(r.text).toBe('ok');
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ access: 'ACCESS-NEW', refresh: 'r2', accountId: 'acct_abcdef123456' });
      const refreshReq = reqs.find((q) => q.url === '/token')!;
      expect(refreshReq.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'r1', client_id: CHATGPT_CLIENT_ID });
      expect(reqs[reqs.length - 1].headers.authorization).toBe('Bearer ACCESS-NEW');
    } finally {
      restore();
    }
  });

  it('🔒 429 / 用量上限 → 明确报「额度用完」，不静默', async () => {
    const { base } = await serve(() => ({ status: 429, json: { error: { message: 'usage_limit_reached', type: 'usage_limit_reached' } } }));
    const p = new ChatgptSubscriptionProvider({ name: 'gpt', tokens: freshTokens(), baseUrl: base });
    await expect(p.complete([{ role: 'user', content: 'U' }])).rejects.toThrow(/额度用完/);
  });

  it('stream() 逐段吐文本', async () => {
    const { base } = await serve(() => ({ events: [{ type: 'response.output_text.delta', delta: 'a' }, { type: 'response.output_text.delta', delta: 'b' }, { type: 'response.completed', response: {} }] }));
    const p = new ChatgptSubscriptionProvider({ name: 'gpt', tokens: freshTokens(), baseUrl: base });
    const chunks: string[] = [];
    for await (const c of p.stream([{ role: 'user', content: 'U' }])) chunks.push(c);
    expect(chunks).toEqual(['a', 'b']);
  });

  it('生图：走 image_generation 工具，图从 image_generation_call.result 取回', async () => {
    const png = Buffer.from('\x89PNG\r\n\x1a\nfake').toString('base64');
    const { base, reqs } = await serve(() => ({ events: [{ type: 'response.output_item.done', item: { type: 'image_generation_call', id: 'ig_1', result: png } }, { type: 'response.completed', response: {} }] }));
    const p = new ChatgptSubscriptionProvider({ name: 'gpt', tokens: freshTokens(), baseUrl: base });
    const imgs = await p.generateImage({ prompt: '一只猫', size: '1536x1024', referenceImages: ['data:image/png;base64,AAA'] });
    expect(imgs).toEqual([png]);
    const body = reqs[0].body as Record<string, unknown>;
    expect(body.tools).toEqual([{ type: 'image_generation', size: '1536x1024', quality: 'medium', output_format: 'png' }]);
    expect(body.tool_choice).toEqual({ type: 'image_generation' });
    const content = (body.input as { content: { type: string }[] }[])[0].content;
    expect(content.map((c) => c.type)).toEqual(['input_text', 'input_image']);
  });

  it('方舟尺寸 → OpenAI 三档', () => {
    expect(openaiImageSize('1024x1024')).toBe('1024x1024');
    expect(openaiImageSize('1280x720')).toBe('1536x1024');
    expect(openaiImageSize('1080x1440')).toBe('1024x1536');
    expect(openaiImageSize('garbage')).toBe('1024x1024');
  });
});

describe('渠道落库 + 选路 + 形态闸', () => {
  async function tenant() {
    await prisma.tenant.deleteMany();
    const t = await prisma.tenant.create({ data: { name: 't', plan: 'enterprise' } });
    return t.id;
  }

  it('登录后存成 vendor=chatgpt 的 ModelProvider（首条自动默认、region=overseas）；给界面的视图不含 token', async () => {
    const tenantId = await tenant();
    await saveChatgptChannel(tenantId, freshTokens(), { model: 'gpt-6-astra' });
    const row = await getChatgptChannel(tenantId);
    expect(row).toMatchObject({ label: CHATGPT_LABEL, model: 'gpt-6-astra', isDefault: true });
    const raw = await prisma.modelProvider.findUniqueOrThrow({ where: { id: row!.id } });
    expect(raw.vendor).toBe(CHATGPT_VENDOR);
    expect(raw.region).toBe('overseas');
    expect(raw.apiKeyEnc).not.toContain('acct_abcdef123456'); // 加密入库，不是明文 JSON
    const view = chatgptChannelView(row!)!;
    expect(view).toMatchObject({ email: 'me@example.com', plan: 'plus', effort: 'medium' });
    expect(JSON.stringify(view)).not.toMatch(/"access"|"refresh"|r1/);
    // 再登一次：同一行换 token，不新建
    await saveChatgptChannel(tenantId, { ...freshTokens(), refresh: 'r9' });
    expect(await prisma.modelProvider.count({ where: { tenantId } })).toBe(1);
  });

  it('🔒 整机版：选路能选到它；SaaS：海外渠道整段跳过（行为与从前一致）', async () => {
    const tenantId = await tenant();
    await saveChatgptChannel(tenantId, freshTokens());
    vi.stubEnv('BEACON_EDITION', 'appliance');
    expect((await resolveProvider(tenantId, 'chat')).name).toBe(CHATGPT_LABEL);
    vi.stubEnv('BEACON_EDITION', 'saas');
    expect((await resolveProvider(tenantId, 'chat')).name).not.toBe(CHATGPT_LABEL);
  });

  it('🔒 能力矩阵：chatgptSubscription / overseasLlm 只在两个企业版开', () => {
    vi.stubEnv('BEACON_EDITION', 'saas');
    expect(can('chatgptSubscription')).toBe(false);
    expect(can('overseasLlm')).toBe(false);
    for (const ed of ['appliance', 'private']) {
      vi.stubEnv('BEACON_EDITION', ed);
      expect(can('chatgptSubscription')).toBe(true);
      expect(can('overseasLlm')).toBe(true);
    }
  });
});

describe('🔒 接线守卫', () => {
  it('每条 server action 都先过 assertCan(chatgptSubscription)（SaaS 上界面不显示拦不住 RPC）', () => {
    const src = strip(read('app/(app)/settings/chatgpt-actions.ts'));
    expect(src).toMatch(/assertCan\('chatgptSubscription'\)/);
    const exported = src.match(/export async function (\w+)/g) ?? [];
    expect(exported.length).toBeGreaterThanOrEqual(5);
    for (const fn of exported) {
      const i = src.indexOf(fn);
      const body = src.slice(i, src.indexOf('\n}', i));
      expect(body, `${fn} 没有走 guard()`).toMatch(/await guard\(\)/);
    }
  });

  it('接入与密钥页只在 can(chatgptSubscription) 时渲染这张卡；连通性测试对 chatgpt 走它自己那条', () => {
    const page = strip(read('app/(app)/settings/keys/page.tsx'));
    expect(page).toMatch(/editionCan\('chatgptSubscription'\)/);
    expect(page).toMatch(/chatgptOn && <ChatgptSubscriptionCard/);
    const actions = strip(read('app/(app)/settings/actions.ts'));
    expect(actions).toMatch(/p\.vendor === CHATGPT_VENDOR[\s\S]{0,200}pingChatgptChannel/);
  });

  it('网关：vendor=chatgpt 走订阅 provider；海外闸认 overseasLlm；看图没配视觉模型时退到它', () => {
    const gw = strip(read('lib/llm/gateway.ts'));
    expect(gw).toMatch(/p\.vendor === CHATGPT_VENDOR/);
    expect(gw).toMatch(/can\('overseasLlm'\)/);
    expect(gw).not.toMatch(/\|\| opts\?\.allowOverseas\)/);
    expect(gw).toMatch(/can\('chatgptSubscription'\)[\s\S]{0,120}getChatgptChannel/);
  });

  it('生图：只在用户显式把 image 指到它时才走（不兜底），且用 image_generation 工具', () => {
    const img = strip(read('lib/llm/image.ts'));
    expect(img).toMatch(/\.image === gpt\.id/);
    expect(img).toMatch(/provider\.chatgpt[\s\S]{0,400}generateImage\(/);
    const prov = strip(read('lib/llm/chatgpt/provider.ts'));
    expect(prov).toMatch(/type: 'image_generation'/);
  });

  it('🔒 客户端卡片只引纯 types 文件：provider/auth/channel 带着 node:fs 与 prisma，进浏览器包会让 next build 直接失败（第一次部署栽过）', () => {
    const card = strip(read('app/(app)/settings/ChatgptSubscriptionCard.tsx'));
    expect(card).toMatch(/^'use client'/);
    const imports = [...card.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    for (const p of imports) expect(p, `卡片引了 ${p}`).not.toMatch(/chatgpt\/(provider|auth|channel)$/);
    expect(imports).toContain('@/lib/llm/chatgpt/types');
    const types = strip(read('lib/llm/chatgpt/types.ts'));
    expect(types, 'types.ts 不许引任何模块（它要进浏览器包）').not.toMatch(/\bimport\b/);
  });

  it('文档在，且写了零代码那条路（hermes proxy + BEACON_DEFAULT_LLM_BASE_URL）与 Claude 不做的理由', () => {
    const doc = read('docs/整机版-用ChatGPT订阅跑模型.md');
    expect(doc).toContain('hermes proxy');
    expect(doc).toContain('BEACON_DEFAULT_LLM_BASE_URL');
    expect(doc).toMatch(/Anthropic[\s\S]{0,80}禁止/);
  });
});
