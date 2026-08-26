import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAICompatibleProvider, stripJsonFences } from '@/lib/llm/openai-compatible';

// 走真 http server：要验的正是「端点拒绝 response_format 时自动重试」这条与真实 HTTP 语义耦合的路径。
// 每个 server 记录收到的请求体，断言重试确实去掉了 response_format。

type Handler = (body: any, reqCount: number) => { status: number; json: any };

function makeServer(handler: Handler) {
  const bodies: any[] = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      bodies.push(body);
      const { status, json } = handler(body, bodies.length);
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(json));
    });
  });
  return { srv, bodies };
}

async function listen(srv: http.Server): Promise<number> {
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return (srv.address() as AddressInfo).port;
}

const servers: http.Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

function ok(content: string) {
  return { status: 200, json: { choices: [{ message: { content } }], usage: { prompt_tokens: 3, completion_tokens: 5 } } };
}

describe('OpenAICompatibleProvider · response_format 优雅兼容', () => {
  it('🔒 端点 400 拒绝 response_format（MiniMax 同款）→ 自动去字段重试一次并成功', async () => {
    const { srv, bodies } = makeServer((_body, n) => {
      if (n === 1) {
        // 首次带 response_format → 复刻 MiniMax 的 400
        return { status: 400, json: { base_resp: { status_code: 2013, status_msg: "unknown response_format type 'json_object'" }, error: { message: "unknown response_format type 'json_object' (2013)" } } };
      }
      return ok('{"score": 8, "reason": "ok"}');
    });
    servers.push(srv);
    const port = await listen(srv);
    // 用唯一 baseUrl，避免命中其它用例已写入的 noNativeJson 进程级缓存
    const p = new OpenAICompatibleProvider({ name: 'minimax-like', baseUrl: `http://127.0.0.1:${port}/uniq-a`, apiKey: 'k', model: 'MiniMax-Text-01' });

    const r = await p.complete([{ role: 'user', content: '打分' }], { json: true });
    expect(r.mocked).toBe(false);
    expect(JSON.parse(r.text)).toEqual({ score: 8, reason: 'ok' }); // 真实结构化结果，不是降级 Mock
    // 第一次带了 response_format、第二次没带（去字段重试）
    expect(bodies[0].response_format).toEqual({ type: 'json_object' });
    expect(bodies[1].response_format).toBeUndefined();
    // 降级重试补了 JSON 系统提示
    expect(bodies[1].messages[0].role).toBe('system');
    expect(bodies[1].messages[0].content).toContain('JSON');
  });

  it('同一端点第二次 json 调用直接走降级路径，不再撞 400（进程级缓存生效）', async () => {
    const { srv, bodies } = makeServer((_body, n) => {
      if (n === 1) return { status: 400, json: { error: { message: "unknown response_format type 'json_object'" } } };
      return ok('{"ok": true}');
    });
    servers.push(srv);
    const port = await listen(srv);
    const base = `http://127.0.0.1:${port}/uniq-b`;
    const p = new OpenAICompatibleProvider({ name: 'mm', baseUrl: base, apiKey: 'k', model: 'M' });

    await p.complete([{ role: 'user', content: 'a' }], { json: true }); // 探到不支持 → 缓存
    const before = bodies.length; // = 2（400 + 重试）
    // 新实例、同 baseUrl+model → 命中缓存，直接不带 response_format
    const p2 = new OpenAICompatibleProvider({ name: 'mm', baseUrl: base, apiKey: 'k', model: 'M' });
    const r = await p2.complete([{ role: 'user', content: 'b' }], { json: true });
    expect(JSON.parse(r.text)).toEqual({ ok: true });
    expect(bodies.length).toBe(before + 1); // 只多了一次调用（无 400），证明没再撞
    expect(bodies[before].response_format).toBeUndefined();
  });

  it('原生支持 json 的端点（DeepSeek 同款）→ 一次成功，不重试、行为不变', async () => {
    const { srv, bodies } = makeServer(() => ok('{"a": 1}'));
    servers.push(srv);
    const port = await listen(srv);
    const p = new OpenAICompatibleProvider({ name: 'deepseek-like', baseUrl: `http://127.0.0.1:${port}/uniq-c`, apiKey: 'k', model: 'deepseek-chat' });
    const r = await p.complete([{ role: 'user', content: 'x' }], { json: true });
    expect(JSON.parse(r.text)).toEqual({ a: 1 });
    expect(bodies.length).toBe(1); // 没有重试
    expect(bodies[0].response_format).toEqual({ type: 'json_object' });
  });

  it('非 response_format 的真 400（如鉴权/参数错）→ 不吞不重试，如实抛错', async () => {
    const { srv, bodies } = makeServer(() => ({ status: 400, json: { error: { message: 'invalid model xyz' } } }));
    servers.push(srv);
    const port = await listen(srv);
    const p = new OpenAICompatibleProvider({ name: 'x', baseUrl: `http://127.0.0.1:${port}/uniq-d`, apiKey: 'k', model: 'M' });
    await expect(p.complete([{ role: 'user', content: 'x' }], { json: true })).rejects.toThrow(/LLM 调用失败 400/);
    expect(bodies.length).toBe(1); // 不属于 response_format 报错，不重试
  });

  it('🔒 bug#4：提到 response_format 但去字段重试仍失败 → 抛原错、**不毒化缓存**（下次仍带 response_format）', async () => {
    // 一台 server 跨调用变行为：#1 带字段 400(提到 response_format) → #2 去字段重试仍 400(另有其因) → 抛错；
    // 之后 #3 又带字段 → 200。若缓存被毒化，#3 会不带字段——用它来证伪。
    const { srv, bodies } = makeServer((_body, n) => {
      if (n === 1) return { status: 400, json: { error: { message: "unknown response_format type 'json_object'" } } };
      if (n === 2) return { status: 400, json: { error: { message: 'transient upstream error' } } };
      return ok('{"ok":1}');
    });
    servers.push(srv);
    const port = await listen(srv);
    const base = `http://127.0.0.1:${port}/uniq-f`;
    const p = new OpenAICompatibleProvider({ name: 'x', baseUrl: base, apiKey: 'k', model: 'MPoison' });

    // 第一次：重试仍失败 → 抛原始 400，且不写缓存
    await expect(p.complete([{ role: 'user', content: 'x' }], { json: true })).rejects.toThrow(/LLM 调用失败 400/);
    expect(bodies.length).toBe(2);

    // 第二次同端点+模型的 json 调用：若缓存被毒化会不带 response_format；正确行为是仍带（#3）
    const r = await new OpenAICompatibleProvider({ name: 'x', baseUrl: base, apiKey: 'k', model: 'MPoison' }).complete([{ role: 'user', content: 'y' }], { json: true });
    expect(JSON.parse(r.text)).toEqual({ ok: 1 });
    expect(bodies[2].response_format).toEqual({ type: 'json_object' }); // ★ 未毒化：仍先带字段
  });

  it('json 模式下模型返回 ```json 围栏 → 剥掉围栏交给上层严格解析', async () => {
    const { srv } = makeServer(() => ok('```json\n{"wrapped": true}\n```'));
    servers.push(srv);
    const port = await listen(srv);
    const p = new OpenAICompatibleProvider({ name: 'x', baseUrl: `http://127.0.0.1:${port}/uniq-e`, apiKey: 'k', model: 'deepseek-chat' });
    const r = await p.complete([{ role: 'user', content: 'x' }], { json: true });
    expect(JSON.parse(r.text)).toEqual({ wrapped: true });
  });

  it('stripJsonFences 单测', () => {
    expect(stripJsonFences('{"a":1}')).toBe('{"a":1}');
    expect(stripJsonFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripJsonFences('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripJsonFences('  {"a":1}  ')).toBe('{"a":1}');
  });
});

// ── 推理模型的思考块不许漏给用户 ────────────────────────────────────────────
//
// MiniMax M 系（M2.5 / M3）以及多数推理模型，会把整段内心独白放进 message.content
// 再接正式回答。2026-08-23 真机实测原样返回：
//   <think>用户要建草稿。但我没有他的人设信息……我决定先问他。</think>
//   在创建之前，我需要先确认一下你的写作偏好……
// 本项目在提示词泄漏上栽过三次，结论一直是同一条：**提示词只降概率，出口清洗才是保证**。
describe('剥掉推理模型的思考块', () => {
  it('成对的 <think> 整段剥掉，正式回答留下', async () => {
    const { stripThinking } = await import('@/lib/llm/openai-compatible');
    const raw = '<think>用户要建草稿。我决定先问他。</think>\n\n在创建之前，我需要确认你的写作偏好。';
    const out = stripThinking(raw);
    expect(out, '内心独白漏给用户了').not.toContain('我决定先问他');
    expect(out).toBe('在创建之前，我需要确认你的写作偏好。');
  });

  it('<thinking> 这种写法也认', async () => {
    const { stripThinking } = await import('@/lib/llm/openai-compatible');
    expect(stripThinking('<thinking>想一想</thinking>答案')).toBe('答案');
  });

  it('🔒 落单的开标签一律不动（不然会把人家半篇稿子吃掉）', async () => {
    const { stripThinking } = await import('@/lib/llm/openai-compatible');
    // 用户自己的正文里写了这个词，没有闭合标签——剥到底会把后面全吞了
    const raw = '这篇讲讲 <think> 标签在推理模型里是干什么的，以及为什么要剥掉它。';
    expect(stripThinking(raw), '把用户正文吃掉了').toBe(raw);
  });

  it('🔒 剥完什么都不剩时退回原文（宁可多一点也不能给空白）', async () => {
    const { stripThinking } = await import('@/lib/llm/openai-compatible');
    const raw = '<think>只有思考没有回答</think>';
    expect(stripThinking(raw), '用户拿到一片空白').not.toBe('');
  });

  it('没有思考块的正常回答一个字都不改', async () => {
    const { stripThinking } = await import('@/lib/llm/openai-compatible');
    const raw = '你有 2 条选题，我建议先做第一条。';
    expect(stripThinking(raw)).toBe(raw);
  });
});
