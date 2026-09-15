import vm from 'node:vm';
import type { ToolContext, ToolResult } from '../tool-types';

// ── AI 自写工具的沙箱运行时（2026-09-09）───────────────────────────────────────
//
// 【它能做什么】跑一段模型写的 JS：`async function main(args, sdk)`。sdk 只有四样：
//   sdk.tools.call(name, args)  调它在起草时声明过的静态工具（uses 白名单，且次数封顶）
//   sdk.log(...)                记几行日志（回到审核页给人看）
//   sdk.now()                   当前时间戳
//   sdk.args                    调用参数（与 main 的第一个参数相同）
// 没有 require / process / fetch / 文件——它不是脚本环境，是「把几个工具拼起来」的胶水。
//
// 【node:vm 不是安全边界】这是 Node 官方文档的原话：恶意代码可以顺着原型链摸到宿主对象。
// 所以：① 只在单租户形态启用（lib/edition.ts aiAuthoredTools：SaaS 恒关）；
//      ② 起草的是模型、启用的是人——技能中心里看过代码才 enabled；
//      ③ 这里仍然把能关的都关掉：空原型上下文、冻结的 sdk、同步部分带 timeout、外层总限时。
//         （不用 microtaskMode='afterEvaluate'：那个模式下 await 真 I/O 之后的续段永远不会被
//         宿主事件循环接着跑，任何调了工具的 main 都会挂死——第一版就栽在这。代价是
//         「await 之后再写死循环」只能靠外层限时兜底，而它兜不住不让出事件循环的循环。）
//
// 【产物契约】main 返回 { summary, data? } 或字符串；抛错 = 工具失败（ok:false，原因原样带回给模型）。

export const AI_TOOL_TIMEOUT_MS = 20_000;
export const AI_TOOL_MAX_SUBCALLS = 10;
export const AI_TOOL_MAX_LOG_LINES = 50;
export const AI_TOOL_MAX_CODE_CHARS = 20_000;

export type AiToolRow = {
  id: string;
  name: string;
  label: string;
  description: string;
  params: string;
  uses: string;
  code: string;
};

export type SubcallFn = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

/** 编译检查：语法 + 必须定义 main。起草时就拦，不等到运行才炸。 */
export function compileAiTool(code: string): { ok: true } | { ok: false; error: string } {
  if (!code || !code.trim()) return { ok: false, error: '代码为空' };
  if (code.length > AI_TOOL_MAX_CODE_CHARS) return { ok: false, error: `代码超过 ${AI_TOOL_MAX_CODE_CHARS} 字` };
  if (!/\basync\s+function\s+main\s*\(/.test(code) && !/\bconst\s+main\s*=\s*async/.test(code)) {
    return { ok: false, error: '必须定义 async function main(args, sdk)' };
  }
  if (/\brequire\s*\(|\bimport\s*\(|\bprocess\b|\bglobalThis\b|\bFunction\s*\(|\beval\s*\(/.test(code)) {
    return { ok: false, error: '不许用 require / import() / process / globalThis / Function / eval：这是拼工具的胶水，不是脚本环境' };
  }
  // vm 逃逸的经典路径是顺着 sdk.constructor.constructor 摸到宿主的 Function。
  // 文本闸挡不住有心人（字符串拼接就绕过去了），但能挡住模型「顺手」写出来的那种——
  // 真正的边界仍然是形态（单租户）+ 人审（启用前看代码），见文件头。
  if (/\bconstructor\b|__proto__|\bprototype\b|\bReflect\b|\bProxy\b/.test(code)) {
    return { ok: false, error: '不许碰 constructor / __proto__ / prototype / Reflect / Proxy：拼工具用不到这些' };
  }
  try {
    new vm.Script(code, { filename: 'ai-tool.js' });
  } catch (e) {
    return { ok: false, error: `语法错误：${(e as Error).message.slice(0, 200)}` };
  }
  return { ok: true };
}

/** 在沙箱里跑一次。subcall 由调用方提供（它负责白名单、权限、开关；沙箱只管次数）。 */
export async function runAiTool(
  row: AiToolRow,
  ctx: ToolContext,
  args: Record<string, unknown>,
  subcall: SubcallFn,
  opts: { timeoutMs?: number } = {},
): Promise<ToolResult & { logs: string[] }> {
  const timeoutMs = opts.timeoutMs ?? AI_TOOL_TIMEOUT_MS;
  const logs: string[] = [];
  let calls = 0;
  let uses: string[] = [];
  try { uses = JSON.parse(row.uses) as string[]; } catch { uses = []; }
  const allowed = new Set(uses);

  const sdk = Object.freeze({
    args: Object.freeze(structuredClone(args)),
    now: () => Date.now(),
    log: (...parts: unknown[]) => {
      if (logs.length >= AI_TOOL_MAX_LOG_LINES) return;
      logs.push(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ').slice(0, 500));
    },
    tools: Object.freeze({
      call: async (name: unknown, a: unknown) => {
        const n = String(name);
        if (!allowed.has(n)) throw new Error(`这个工具起草时没有声明要用 ${n}（uses 里只有：${uses.join('、') || '无'}）`);
        if (++calls > AI_TOOL_MAX_SUBCALLS) throw new Error(`一次最多调 ${AI_TOOL_MAX_SUBCALLS} 次工具`);
        const r = await subcall(n, (a && typeof a === 'object' ? a : {}) as Record<string, unknown>);
        // 回沙箱的是纯数据副本：不把宿主对象引用递进去
        return structuredClone({ ok: r.ok, summary: r.summary, data: r.data ?? null, error: r.error ?? null });
      },
    }),
  });

  // 空原型上下文：没有 process / require / fetch；JSON/Math/Array 等是这个上下文自己的内建对象
  const context = vm.createContext(Object.create(null)) as Record<string, unknown>;
  try {
    const script = new vm.Script(`${row.code}\n;(typeof main === 'function' ? main : null)`, { filename: `ai-tool:${row.name}` });
    const main = script.runInContext(context, { timeout: timeoutMs }) as ((a: unknown, s: unknown) => unknown) | null;
    if (typeof main !== 'function') return { ok: false, error: '代码里没有 main 函数', summary: `${row.label}：代码里没有 main`, logs };

    // 【main 必须在 vm 里调用】从宿主直接 main(...) 的话，函数体第一个 await 之前的同步死循环
    // 不受 timeout 管，事件循环被卡死，外层的 deadline 永远没机会触发（第一版就是这么挂住整个测试进程的）。
    // 在 vm 里调：到第一个 await 为止的同步段受 timeout 管；之后等 I/O 的续段靠外层 deadline 兜底。
    context.__args = sdk.args;
    context.__sdk = sdk;
    const invoke = new vm.Script('main(__args, __sdk)', { filename: `ai-tool:${row.name}:invoke` });
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`超过 ${timeoutMs / 1000} 秒还没跑完`)), timeoutMs); timer.unref?.(); });
    deadline.catch(() => {}); // 正常跑完时它会被丢弃，别让它变成 unhandled rejection
    let out: unknown;
    try {
      out = await Promise.race([Promise.resolve(invoke.runInContext(context, { timeout: timeoutMs })), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    const norm = normalize(out);
    return { ok: true, data: norm.data, summary: `${row.label}：${norm.summary}`, logs };
  } catch (e) {
    const msg = (e as Error)?.message?.slice(0, 300) || String(e).slice(0, 300);
    return { ok: false, error: msg, summary: `${row.label} 失败：${msg}`, logs };
  } finally {
    void ctx; // ctx 仅用于类型对齐与将来扩展；沙箱里刻意拿不到它
  }
}

function normalize(out: unknown): { summary: string; data: unknown } {
  if (out == null) return { summary: '（没有返回内容）', data: null };
  if (typeof out === 'string') return { summary: out.slice(0, 400), data: out };
  if (typeof out === 'object') {
    const o = out as { summary?: unknown; data?: unknown };
    const summary = typeof o.summary === 'string' ? o.summary.slice(0, 400) : JSON.stringify(out).slice(0, 400);
    let data: unknown = o.data !== undefined ? o.data : out;
    try { data = structuredClone(data); } catch { data = JSON.parse(JSON.stringify(data)); }
    return { summary, data };
  }
  return { summary: String(out).slice(0, 400), data: out };
}
