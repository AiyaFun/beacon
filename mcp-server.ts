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
  // ── 浏览器动词：指挥用户自己的采集插件干白名单里的三件事 ──────────────────
  // 这不是「远程驱动浏览器」：没有打开任意 URL、点击、填表、执行脚本的动词，
  // 能派的动作是一份写死在插件代码里的白名单。三个动词都是异步排队——
  // 要有一台装了插件的浏览器在线才会被领走，用 beacon_browser_task_status 看进度。
  {
    name: 'beacon_collect_competitor',
    description:
      '让用户的浏览器插件去采一个**已订阅**竞对的公开主页（作品与数据）。'
      + 'competitor 用监控列表里的 id、主页 handle 或名字（精确匹配；同名多个会让你带 id 重来）。'
      + '不在监控列表里的采不了——先让用户在烽火台「竞对监控」里订阅。'
      + '异步排队：立刻返回 taskId，插件在线时才执行，不会立刻有数据。',
    inputSchema: {
      type: 'object',
      properties: {
        competitor: { type: 'string', description: '监控列表里的竞对：id / 主页 handle / 名字（精确匹配）' },
        limit: { type: 'number', description: '采几条作品，默认 20，最多 50' },
      },
      required: ['competitor'],
    },
  },
  {
    name: 'beacon_collect_self',
    description:
      '让用户的浏览器插件回填**用户本人**创作后台的数据（用他自己的登录态，进他自己的后台）。'
      + '目前只支持 platform=wechat（公众号）。异步排队，插件在线时执行。',
    inputSchema: {
      type: 'object',
      properties: { platform: { type: 'string', description: '目前只有 wechat' } },
      required: ['platform'],
    },
  },
  {
    name: 'beacon_read_page',
    description:
      '让用户的浏览器插件打开一个网页、把**已渲染的可见正文**读回来（服务端直接抓不到的平台用它：'
      + '要登录、或整页 JS 渲染）。只读不动：不点击、不填写、不提交。'
      + '⚠️ 两个前置：工作区要开过「让插件替我读网页」开关（默认关）；'
      + 'URL 必须在硬编码的站点白名单里（抖音/B站/小红书/知乎/微博/公众号文章/头条/百家号/X/YouTube 等），'
      + '清单外的一律拒绝。别的网址让烽火台服务端直接抓（beacon_run 里说「剪藏这条链接」）。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: '要读的网页地址（必须在白名单站点里）' } },
      required: ['url'],
    },
  },
  {
    name: 'beacon_browser_task_status',
    description:
      '看一个浏览器任务走到哪了。状态：pending=等插件在线来领 / claimed=正在做 / done / failed / '
      + 'expired（48 小时无人执行自动作废）/ cancelled。beacon_read_page 跑完后这里会带回摘要与正文节选。',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: '排队时返回的 taskId' } },
      required: ['taskId'],
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

  // 三个浏览器动词共用同一条创建路：白名单校验、开关、监控列表归属全在服务端那侧判
  const BROWSER_CREATE: Record<string, (a: Record<string, unknown>) => Record<string, unknown>> = {
    beacon_collect_competitor: (a) => ({ kind: 'collect_competitor', competitor: String(a.competitor ?? ''), ...(a.limit ? { limit: Number(a.limit) } : {}) }),
    beacon_collect_self: (a) => ({ kind: 'collect_self', platform: String(a.platform ?? '') }),
    beacon_read_page: (a) => ({ kind: 'open_and_read', url: String(a.url ?? '') }),
  };
  if (BROWSER_CREATE[name]) {
    const r = await api('/api/v1/browser-tasks', { method: 'POST', body: JSON.stringify(BROWSER_CREATE[name](args)) });
    return text(`已排队（taskId: ${r.taskId}）。\n${String(r.note ?? '')}`);
  }

  if (name === 'beacon_browser_task_status') {
    const taskId = String(args.taskId ?? '').trim();
    if (!taskId) return text('要给出 taskId。');
    const r = await api(`/api/v1/browser-tasks/${encodeURIComponent(taskId)}`);
    const read = r.read as
      | { url: string; title: string; summary: string | null; points: string[]; textPreview: string; textTruncated: boolean; note?: string }
      | undefined;
    const lines = [
      `${r.label}：${r.status}`,
      r.result ? `\n回执：${r.result}` : '',
      r.error ? `\n出错：${r.error}` : '',
      r.waitingFor ? `\n${r.waitingFor}` : '',
      read
        ? `\n\n读到的内容：${read.title}（${read.url}）`
          + (read.summary ? `\n摘要：${read.summary}` : '')
          + (read.points?.length ? `\n要点：\n${read.points.map((p) => `· ${p}`).join('\n')}` : '')
          + (read.textPreview ? `\n正文节选：\n${read.textPreview}` : '')
          + (read.textTruncated ? `\n（${read.note ?? '正文有截断'}）` : '')
        : '',
    ];
    return text(lines.filter(Boolean).join(''));
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
