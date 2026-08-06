// 结构化日志 + 可选错误上报。零依赖（只用 Node/Web 内置），edge 与 node runtime 都能跑。
// 输出：生产 = JSON 行（喂 Loki/CloudWatch/阿里云 SLS）；dev = 带颜色的人类可读行。
// 级别：BEACON_LOG_LEVEL 覆盖，默认 dev=debug / prod=info。
// 铁律：所有输出都过 redact()。生产日志里不允许出现 API key / 验证码 / token / 手机号明文。

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogContext = Record<string, unknown>;

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// 未显式声明 BEACON_ENV 的容器也按生产处理（宁可少打日志，不可漏密）
const IS_PROD = process.env.BEACON_ENV === 'prod' || process.env.NODE_ENV === 'production';

// ── 脱敏 ────────────────────────────────────────────────

// 完全打码的字段名（比较时统一小写并去掉 _ - 分隔符）
const SECRET_KEYS = new Set([
  'password', 'pwd', 'pass', 'passwd',
  'secret', 'secretkey', 'secretid', 'clientsecret',
  'accesskeyid', 'accesskeysecret',
  'apikey', 'apikeyenc', 'apisecret', 'privatekey',
  'token', 'accesstoken', 'refreshtoken', 'sessiontoken', 'idtoken', 'sessionid', 'session',
  'cookie', 'setcookie', 'authorization', 'auth', 'bearer',
  'masterkey', 'encryptionkey', 'dsn', 'credential', 'credentials', 'signature',
  'smscode', 'verifycode', 'verificationcode', 'otp', 'captcha', 'pin',
  'idcard', 'idnumber', 'bankcard',
]);
// 部分保留的字段名（打码但留可辨认片段，方便排查）
const PHONE_KEYS = new Set(['phone', 'mobile', 'tel', 'phonenumber', 'telephone', 'contact']);
const EMAIL_KEYS = new Set(['email', 'mail', 'emailaddress']);

// 值层面的兜底规则：即使字段名不敏感（比如上游报错信息里回显了 key），也要拦住
const VALUE_RULES: { re: RegExp; to: string }[] = [
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, to: 'sk-***' },                    // OpenAI/DeepSeek 风格 key
  { re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, to: 'Bearer ***' },   // Authorization 头
  { re: /\b(?:LTAI|AKID)[A-Za-z0-9]{12,}/g, to: '***' },               // 阿里云 / 腾讯云 AccessKey
  { re: /(\b[a-z][a-z0-9+.-]*:\/\/[^:/?#\s]+):[^@\s]+@/gi, to: '$1:***@' }, // URL 里的密码（DATABASE_URL/REDIS_URL）
];

function normKey(k: string): string {
  return k.toLowerCase().replace(/[_-]/g, '');
}

// 手机号：留前 3 后 4（138****8000），够定位人又不算明文
function maskPhone(v: string): string {
  const d = v.replace(/\D/g, '');
  if (d.length < 7) return '***';
  return `${d.slice(0, 3)}****${d.slice(-4)}`;
}

function maskEmail(v: string): string {
  const at = v.indexOf('@');
  if (at <= 0) return '***';
  return `${v[0]}***${v.slice(at)}`;
}

function scrubString(s: string): string {
  let out = s;
  for (const r of VALUE_RULES) out = out.replace(r.re, r.to);
  return out;
}

// code 字段只在值像验证码（4-8 位纯数字）时打码——否则 ECONNREFUSED / HTTP 状态码这类
// 排查必需的错误码会被误伤。
function looksLikeVerifyCode(v: unknown): boolean {
  return typeof v === 'string' && /^\d{4,8}$/.test(v);
}

const MAX_DEPTH = 4;
const MAX_ARRAY = 20;
const MAX_STRING = 2000;

// 递归脱敏 + 结构化。返回可安全 JSON.stringify 的克隆。
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    const s = scrubString(value);
    return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…(${s.length})` : s;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      stack: value.stack ? scrubString(value.stack) : undefined,
    };
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    if (depth >= MAX_DEPTH) return '[depth]';
    seen.add(value);

    if (Array.isArray(value)) {
      const arr = value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1, seen));
      if (value.length > MAX_ARRAY) arr.push(`…(共 ${value.length} 项)`);
      return arr;
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const nk = normKey(k);
      if (SECRET_KEYS.has(nk)) out[k] = '***';
      else if (PHONE_KEYS.has(nk) && typeof v === 'string') out[k] = maskPhone(v);
      else if (EMAIL_KEYS.has(nk) && typeof v === 'string') out[k] = maskEmail(v);
      else if (nk === 'code' && looksLikeVerifyCode(v)) out[k] = '***';
      else out[k] = redact(v, depth + 1, seen);
    }
    return out;
  }
  return String(value);
}

// ── 错误上报（可选，配 BEACON_SENTRY_DSN 才启用）──────────

export interface ErrorReporter {
  readonly name: string;
  capture(err: Error, ctx?: LogContext): void;
  /** 进程退出前等待在途上报落地 */
  flush(timeoutMs?: number): Promise<void>;
}

let reporter: ErrorReporter | null = null;

/** 接入点：装了 @sentry/nextjs 之后在 instrumentation 里 setReporter() 换掉内置实现即可。 */
export function setReporter(r: ErrorReporter | null): void {
  reporter = r;
}

export function getReporter(): ErrorReporter | null {
  return reporter;
}

/** 手动上报（log.error 会自动调用，一般不用直接调） */
export function captureException(err: unknown, ctx?: LogContext): void {
  if (!reporter) return;
  const e = err instanceof Error ? err : new Error(String(err));
  try {
    reporter.capture(e, ctx);
  } catch {
    // 上报失败绝不能影响主流程
  }
}

export function flushReports(timeoutMs = 2000): Promise<void> {
  return reporter ? reporter.flush(timeoutMs).catch(() => {}) : Promise.resolve();
}

// 内置最小 Sentry 实现：手写 envelope 协议，fetch 直发，不引依赖。
// 只上报「异常类型 + 消息 + 原始 stack 文本 + tags」，不做 source map 解析和 frame 拆分
// （那部分手写不靠谱，需要时装官方 SDK 走 setReporter 替换）。
class SentryEnvelopeReporter implements ErrorReporter {
  readonly name = 'sentry-envelope';
  private endpoint: string;
  private dsn: string;
  private pending = new Set<Promise<unknown>>();
  // 简易限流：崩溃循环时别把配额和进程一起打爆
  private windowStart = 0;
  private sent = 0;

  constructor(dsn: string) {
    // DSN: <scheme>://<publicKey>@<host>[/<path>]/<projectId>
    const u = new URL(dsn);
    const segs = u.pathname.split('/').filter(Boolean);
    const projectId = segs.pop();
    if (!u.username || !projectId) throw new Error('DSN 缺少 publicKey 或 projectId');
    const prefix = segs.length ? `/${segs.join('/')}` : ''; // 自建 Sentry 可能挂在子路径下
    this.dsn = dsn;
    this.endpoint = `${u.protocol}//${u.host}${prefix}/api/${projectId}/envelope/?sentry_key=${u.username}&sentry_version=7`;
  }

  private allow(): boolean {
    const now = Date.now();
    if (now - this.windowStart > 60_000) {
      this.windowStart = now;
      this.sent = 0;
    }
    return ++this.sent <= 60;
  }

  capture(err: Error, ctx?: LogContext): void {
    if (!this.allow()) return;
    const eventId = crypto.randomUUID().replace(/-/g, '');
    const clean = redact(ctx ?? {}) as LogContext;
    const event = {
      event_id: eventId,
      timestamp: Date.now() / 1000,
      platform: 'node',
      level: 'error',
      logger: 'beacon',
      environment: process.env.BEACON_ENV ?? 'unknown',
      release: process.env.BEACON_RELEASE || undefined,
      server_name: process.env.BEACON_SERVICE || undefined,
      exception: { values: [{ type: err.name, value: scrubString(err.message) }] },
      tags: {
        service: String(clean.service ?? process.env.BEACON_SERVICE ?? 'web'),
        tenantId: clean.tenantId ? String(clean.tenantId) : undefined,
        jobName: clean.jobName ? String(clean.jobName) : undefined,
      },
      extra: { ...clean, stack: err.stack ? scrubString(err.stack) : undefined },
    };
    const body =
      JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString(), dsn: this.dsn }) +
      '\n' +
      JSON.stringify({ type: 'event' }) +
      '\n' +
      JSON.stringify(event) +
      '\n';

    const p = fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-sentry-envelope' },
      body,
      signal: AbortSignal.timeout(5000),
    })
      .catch(() => {})
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  async flush(timeoutMs = 2000): Promise<void> {
    if (!this.pending.size) return;
    await Promise.race([
      Promise.allSettled([...this.pending]),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ]);
  }
}

// ── Logger ──────────────────────────────────────────────

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  /** error 级会自动触发错误上报（若已配 DSN）。惯例：把 Error 放在 ctx.err */
  error(msg: string, ctx?: LogContext): void;
  /** 派生带固定字段的子 logger，如 log.child({ jobName: 'ingest_hot' }) */
  child(bindings: LogContext): Logger;
}

function resolveLevel(): LogLevel {
  const raw = (process.env.BEACON_LOG_LEVEL || '').toLowerCase();
  if (raw in LEVELS) return raw as LogLevel;
  return IS_PROD ? 'info' : 'debug';
}

let minLevel = LEVELS[resolveLevel()];

const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m', // 灰
  info: '\x1b[36m',  // 青
  warn: '\x1b[33m',  // 黄
  error: '\x1b[31m', // 红
};
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const USE_COLOR = !IS_PROD && !process.env.NO_COLOR;

// 把 err.stack 从上下文里摘出来单独展示（仅 dev 排版用）
function splitStack(merged: LogContext): { stack?: string; rest: LogContext } {
  const e = merged.err as { name?: string; message?: string; stack?: string } | undefined;
  if (!e || typeof e !== 'object' || typeof e.stack !== 'string') return { rest: merged };
  return {
    stack: e.stack,
    rest: { ...merged, err: `${e.name ?? 'Error'}: ${e.message ?? ''}` },
  };
}

function emit(level: LogLevel, msg: string, bindings: LogContext, ctx?: LogContext): void {
  if (LEVELS[level] < minLevel) return;

  const merged = redact({ ...bindings, ...ctx }) as LogContext;
  const safeMsg = scrubString(msg);

  if (IS_PROD) {
    // JSON 行：一行一事件，字段扁平
    const line = JSON.stringify({
      level,
      time: new Date().toISOString(),
      svc: process.env.BEACON_SERVICE || 'web',
      msg: safeMsg,
      ...merged,
    });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  } else {
    const t = new Date().toISOString().slice(11, 23);
    // dev 下 stack 单独换行打，塞进 key=value 尾巴里没法看
    const { stack, rest } = splitStack(merged);
    const tail = Object.entries(rest)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
    const lv = level.toUpperCase().padEnd(5);
    const head = USE_COLOR ? `${DIM}${t}${RESET} ${COLORS[level]}${lv}${RESET}` : `${t} ${lv}`;
    const body = tail ? `${safeMsg}  ${USE_COLOR ? DIM + tail + RESET : tail}` : safeMsg;
    const line = stack ? `${head} ${body}\n${USE_COLOR ? DIM + stack + RESET : stack}` : `${head} ${body}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  if (level === 'error') {
    const err = ctx?.err ?? ctx?.error;
    captureException(err instanceof Error ? err : new Error(safeMsg), { ...bindings, ...ctx });
  }
}

function make(bindings: LogContext): Logger {
  return {
    debug: (m, c) => emit('debug', m, bindings, c),
    info: (m, c) => emit('info', m, bindings, c),
    warn: (m, c) => emit('warn', m, bindings, c),
    error: (m, c) => emit('error', m, bindings, c),
    child: (b) => make({ ...bindings, ...b }),
  };
}

/** 根 logger。惯例上下文字段见 docs/可观测性.md */
export const log: Logger = make({});

export function createLogger(bindings: LogContext = {}): Logger {
  return make(bindings);
}

// ── 启动初始化（instrumentation.ts / worker.ts 调用）──────

let inited = false;

/** 进程启动时调一次：重算级别、装错误上报、打启动横幅。重复调用无副作用。 */
export function initObservability(service: string): void {
  if (inited) return;
  inited = true;
  process.env.BEACON_SERVICE = service;
  minLevel = LEVELS[resolveLevel()];

  const dsn = process.env.BEACON_SENTRY_DSN;
  if (dsn && !reporter) {
    try {
      setReporter(new SentryEnvelopeReporter(dsn));
    } catch (e) {
      // DSN 写错不能拖垮启动
      log.warn('BEACON_SENTRY_DSN 解析失败，错误上报未启用', { err: e });
    }
  }

  log.info('可观测性已就绪', {
    service,
    level: resolveLevel(),
    format: IS_PROD ? 'json' : 'pretty',
    reporter: reporter?.name ?? 'none',
  });
}
