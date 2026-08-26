/**
 * 烽火台 MCP 服务（整机版 / 私有化版专用）。
 *
 * 用法：`npm run mcp`，或直接配进 MCP 客户端（Claude Desktop 等）：
 *
 *   {
 *     "mcpServers": {
 *       "beacon": {
 *         "command": "npx",
 *         "args": ["tsx", "/path/to/beacon/mcp-server.ts"],
 *         "env": {
 *           "BEACON_API_URL": "http://127.0.0.1:3070",
 *           "BEACON_API_TOKEN": "bck_..."
 *         }
 *       }
 *     }
 *   }
 *
 * ── 它是什么 ────────────────────────────────────────────────────────────────
 * 一个**薄代理**：把 MCP 的 tools/call 转成对本机烽火台 /api/v1 的 HTTP 调用。
 * 所有判断（权限、配额、确认闸、审计）都在烽火台那侧，这里一件都不做——
 * 在代理层复制任何一条规矩，两边迟早对不上，而对不上的那一次多半发生在安全边界上。
 *
 * ── 为什么不引 MCP SDK ──────────────────────────────────────────────────────
 * MCP 的 stdio 传输就是**按行分隔的 JSON-RPC 2.0**，用到的方法只有三个
 *（initialize / tools/list / tools/call）。为这点东西往 package.json 里加一个依赖，
 * SaaS 的 docker 镜像也得跟着背——与 Playwright 不进依赖是同一个理由。
 *
 * ── 刻意不暴露「确认」──────────────────────────────────────────────────────
 * 写操作会停在 awaiting_confirm，而这里**没有 confirm 工具**。
 * 调用 MCP 的通常是另一个模型：让模型 A 起草、模型 B 代签，
 * 「睡着时花钱的合约不让模型代签」那条规矩就形同虚设。
 * 要确认，去网页上点那一下——那是人做的。
 */
const API = (process.env.BEACON_API_URL || 'http://127.0.0.1:3070').replace(/\/+$/, '');
const TOKEN = process.env.BEACON_API_TOKEN || '';

type RpcId = string | number | null;
type Rpc = { jsonrpc: '2.0'; id?: RpcId; method?: string; params?: Record<string, unknown> };

/** 日志一律走 stderr：stdout 是 JSON-RPC 通道，往里写一个字就把协议搞乱了。 */
const log = (msg: string) => process.stderr.write(`[beacon-mcp] ${msg}\n`);

function send(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const ok = (id: RpcId, result: unknown) => send({ jsonrpc: '2.0', id, result });
const fail = (id: RpcId, code: number, message: string) => send({ jsonrpc: '2.0', id, error: { code, message } });

/** 给模型看的一段文本结果。MCP 的 content 形状。 */
const text = (s: string) => ({ content: [{ type: 'text', text: s }] });

async function api(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.ok === false) {
    throw new Error(String(body.error ?? `HTTP ${res.status}`));
  }
  return body;
}

const TOOLS = [
  {
    name: 'beacon_run',
    description:
      '让烽火台去做一件内容运营相关的事（查选题、看数据、写初稿、采竞对等），用一句中文说清楚目标。'
      + '它是**异步**的：这里立刻返回一个 runId，用 beacon_run_status 看进度。'
      + '⚠️ 凡是会改数据或花钱的步骤，烽火台会停下来等人在网页上确认——'
      + '你在这里确认不了，遇到 awaiting_confirm 就如实告诉用户去点一下。',
    inputSchema: {
      type: 'object',
      properties: { goal: { type: 'string', description: '要它做什么，一句中文' } },
      required: ['goal'],
    },
  },
  {
    name: 'beacon_run_status',
    description:
      '看一次执行走到哪了。状态：running=在跑 / awaiting_confirm=停下来等人确认 / '
      + 'waiting_browser=等浏览器插件 / done / failed / cancelled。返回里带每一步做了什么。',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'beacon_run 返回的 runId' } },
      required: ['runId'],
    },
  },
  {
    name: 'beacon_recent_runs',
    description: '列出最近几次执行（目标、状态、结论摘要）。用户问「刚才那件事怎么样了」时用。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '默认 10，上限 30' } },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === 'beacon_run') {
    const goal = String(args.goal ?? '').trim();
    if (!goal) return text('要说清楚让它做什么。');
    const r = await api('/api/v1/runs', { method: 'POST', body: JSON.stringify({ goal }) });
    return text(
      `已经开始了（runId: ${r.runId}）。它在后台跑，用 beacon_run_status 看进度。\n`
      + '如果状态变成 awaiting_confirm，说明有一步要改数据或花钱，需要用户去烽火台网页上点一下确认。',
    );
  }

  if (name === 'beacon_run_status') {
    const runId = String(args.runId ?? '').trim();
    if (!runId) return text('要给出 runId。');
    const r = await api(`/api/v1/runs/${encodeURIComponent(runId)}`);
    const steps = Array.isArray(r.steps) ? (r.steps as { kind: string; tool: string; ok: boolean; result: string }[]) : [];
    const lines = [
      `状态：${r.status}`,
      r.answer ? `\n结论：${r.answer}` : '',
      r.error ? `\n出错：${r.error}` : '',
      // 停在等确认时**必须把「去哪儿点」说出来**：调用方是个程序，
      // 它不知道这台机器的网页在哪，而卡着不动最容易被当成挂了
      r.needsConfirm
        ? `\n⚠️ 有一步要人确认：${(r.needsConfirm as { tool: string }).tool}\n`
          + `   参数：${(r.needsConfirm as { args: string }).args}\n`
          + `   请用户打开 ${API}/assistant?run=${runId} 点确认（你在这里确认不了）`
        : '',
      r.waitingFor ? `\n${r.waitingFor}` : '',
      steps.length ? `\n\n做过的步骤：\n${steps.map((s) => `· ${s.kind} ${s.tool} ${s.ok ? '' : '（失败）'}`).join('\n')}` : '',
    ];
    return text(lines.filter(Boolean).join(''));
  }

  if (name === 'beacon_recent_runs') {
    const limit = Number(args.limit) || 10;
    const r = await api(`/api/v1/runs?limit=${limit}`);
    const runs = (r.runs ?? []) as { runId: string; goal: string; status: string; answer: string | null }[];
    if (runs.length === 0) return text('还没有任何执行记录。');
    return text(runs.map((x) => `· [${x.status}] ${x.goal}${x.answer ? ` → ${x.answer}` : ''}（${x.runId}）`).join('\n'));
  }

  throw new Error(`没有名为 ${name} 的工具`);
}

/** 还没回完的请求。stdin 关掉时要等它们收尾，不能说走就走。 */
const inflight = new Set<Promise<void>>();

async function handle(msg: Rpc): Promise<void> {
  const id = msg.id ?? null;
  try {
    switch (msg.method) {
      case 'initialize':
        ok(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'beacon', version: '1.0.0' },
        });
        return;
      case 'notifications/initialized':
        return; // 通知没有 id，不回
      case 'tools/list':
        ok(id, { tools: TOOLS });
        return;
      case 'tools/call': {
        const p = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        const result = await callTool(String(p.name ?? ''), p.arguments ?? {});
        ok(id, result);
        return;
      }
      case 'ping':
        ok(id, {});
        return;
      default:
        // 认不出的方法回标准错误码，别静默——客户端要能看出是「不支持」而不是「挂了」
        if (id !== null) fail(id, -32601, `不支持的方法：${msg.method}`);
        return;
    }
  } catch (e) {
    const message = (e as Error).message;
    // 工具执行失败要回成**工具结果**而不是协议错误：模型看得到原因才能换个说法，
    // 回协议错误的话多数客户端只会显示一句「工具调用失败」
    if (msg.method === 'tools/call' && id !== null) {
      ok(id, { ...text(`没跑成：${message}`), isError: true });
      return;
    }
    if (id !== null) fail(id, -32000, message);
  }
}

// export 一下把这个文件变成模块：否则它与别的顶层脚本共用全局作用域，
// 两个都叫 main 就撞名（tsc 报 Duplicate function implementation）
export function main(): void {
  if (!TOKEN) {
    log('缺少 BEACON_API_TOKEN。到烽火台「账号与安全 → 对外调用令牌」签一枚，填进 MCP 配置的 env 里。');
    process.exit(1);
  }
  log(`已连接 ${API}`);

  // 按行读 stdio：MCP 的 stdio 传输就是按行分隔的 JSON-RPC
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const task = handle(JSON.parse(line) as Rpc);
        inflight.add(task);
        void task.finally(() => inflight.delete(task));
      } catch {
        // 半截 JSON / 客户端发了脏数据：跳过这一行就好，别把整个进程带走
        log('收到一行读不懂的数据，已跳过');
      }
    }
  });
  // 【为什么不能直接 exit】stdin 关掉时可能还有请求在处理中（工具调用要走一次 HTTP）。
  // 立刻退出的话那条请求**永远不会有回复**，客户端那边看到的是「调用卡住了」。
  // 等在飞的都收尾再走；给个上限，免得某个吊住的请求让进程永远不退。
  process.stdin.on('end', () => {
    if (inflight.size === 0) process.exit(0);
    const bail = setTimeout(() => process.exit(0), 35_000);
    void Promise.allSettled([...inflight]).then(() => {
      clearTimeout(bail);
      process.exit(0);
    });
  });
}

main();
