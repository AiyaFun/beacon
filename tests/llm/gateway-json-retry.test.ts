import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { llmComplete } from '@/lib/llm/gateway';

// 网关对 json:true 调用的健壮性（review 指出的静默降级修复）：
// 真实响应解析不出 JSON → 重试一次 → 仍不行 → 如实降级 Mock（degraded=true）。

// 一台可编排「每次调用返回什么 content」的假 OpenAI 端点
const scripted: string[] = [];
let calls = 0;
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const content = scripted[calls] ?? scripted[scripted.length - 1] ?? '{}';
    calls++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }));
  });
});
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
const port = (srv.address() as AddressInfo).port;
afterAll(() => srv.close());

beforeEach(() => {
  calls = 0;
  scripted.length = 0;
  vi.unstubAllEnvs();
  vi.stubEnv('BEACON_DEFAULT_LLM_BASE_URL', `http://127.0.0.1:${port}/v1`);
  vi.stubEnv('BEACON_DEFAULT_LLM_API_KEY', 'test-key');
  vi.stubEnv('BEACON_DEFAULT_LLM_MODEL', 'test-model');
  vi.stubEnv('BEACON_QUOTA_ENABLED', '0'); // 不测配额，专注 json 重试
});

describe('gateway · json 模式解析失败的重试+降级', () => {
  it('首答非 JSON、重试后是合法 JSON → 用真实结果，不降级', async () => {
    scripted.push('这不是JSON，是一段解释文字。', '{"score": 9}');
    const r = await llmComplete(null, 'scoring', [{ role: 'user', content: '打分' }], { json: true });
    expect(calls).toBe(2); // 重试了一次
    expect(r.mocked).toBe(false);
    expect(r.degraded).toBeFalsy();
    expect(JSON.parse(r.text)).toEqual({ score: 9 });
  });

  it('🔒 首答与重试都非 JSON → 如实降级 Mock（degraded=true, mocked=true）', async () => {
    scripted.push('还是解释文字，不是 JSON。', '依然不是 JSON。');
    const r = await llmComplete(null, 'scoring', [{ role: 'user', content: '打分' }], { json: true });
    expect(calls).toBe(2); // 原调用 + 重试各一次，之后走 Mock 不再打真端点
    expect(r.mocked).toBe(true); // ★ 复用 Mock 徽标基建
    expect(r.degraded).toBe(true);
  });

  it('首答即合法 JSON → 不重试', async () => {
    scripted.push('{"ok": 1}');
    const r = await llmComplete(null, 'scoring', [{ role: 'user', content: 'x' }], { json: true });
    expect(calls).toBe(1);
    expect(r.mocked).toBe(false);
  });

  it('非 json 模式（纯文本）→ 不做 JSON 校验、不重试', async () => {
    scripted.push('随便一段自然语言回复');
    const r = await llmComplete(null, 'chat', [{ role: 'user', content: 'x' }], {}); // 无 json
    expect(calls).toBe(1);
    expect(r.mocked).toBe(false);
    expect(r.text).toContain('自然语言');
  });
});
