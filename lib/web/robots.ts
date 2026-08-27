// robots.txt 遵守 —— 服务端主动抓取网页前的一道闸。
//
// 【为什么要有它】robots 协议在中国**不是法律**，但《互联网搜索引擎服务自律公约》把它
// 定成行业惯例，百度诉 360 案（(2013)一中民初字第 2668 号）据此认定「无视 robots 抓取」
// 违反商业道德、构成不正当竞争。也就是说：它不是合规义务，但违反它会在反法诉讼里
// 成为对我们不利的事实。成本极低（一次带缓存的 GET），不做没有理由。
//
// 【适用范围】只管**服务端主动发起**的抓取（lib/web/fetch.ts 的 safeFetch）。
// 不管浏览器插件——插件是用户本人在自己浏览器里读自己屏幕上的页面，那是「人在浏览」，
// robots 面向的是自动化抓取程序，套过去既无必要也说不通。
//
// 【失败时怎么办】RFC 9309 §2.3.1 说 5xx 应视为「完全禁止」。我们不这么做，取舍如下：
//   · 4xx（含 404 无 robots.txt）→ **放行**。这是 RFC 明确的语义：没有 robots 即无限制。
//   · 5xx / 超时 / DNS 失败      → **放行并记 warn**。目标站抖一下就让用户的功能整个坏掉，
//     代价高于短暂越界的风险；而这类错误是暂时性的，不代表站点意图。
//   · robots.txt 自身超过 512KB  → 只解析前 512KB（RFC 9309 §2.5 的建议下限）。
// 这个取舍是刻意的，改之前先想清楚：把它改成「失败即禁止」，等于把我们的可用性
// 挂在别人服务器的健康度上。

import http from 'node:http';
import https from 'node:https';
import { assertPublicUrl } from './fetch';
import { pinnedLookup } from './ssrf';

/** 我们对外声明的抓取者名字。与 safeFetch 默认 UA 里的 token 一致。 */
export const BEACON_UA_TOKEN = 'beaconbot';

const ROBOTS_TIMEOUT_MS = 5_000;
const ROBOTS_MAX_BYTES = 512 * 1024;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 小时
const CACHE_MAX_ENTRIES = 200;

type Rule = { path: string; allow: boolean };
type Group = { rules: Rule[]; crawlDelaySec: number | null };
/** null = 该站没有对我们生效的规则（无 robots.txt / 抓取失败 / 无匹配组），一律放行。 */
type Parsed = Group | null;

const cache = new Map<string, { at: number; parsed: Parsed }>();

/** 测试用：清空缓存。生产代码不要调。 */
export function __clearRobotsCache() {
  cache.clear();
}

// ── 解析 ────────────────────────────────────────────────
//
// ⚠️ 分组规则容易写错，这里写明白：robots.txt 里连续的多行 User-agent 共享**同一组**
// 规则，直到出现第一条 Disallow/Allow 才算这组开始。写成「一行 UA 一组」会让
//   User-agent: *
//   User-agent: BeaconBot
//   Disallow: /x
// 里的 BeaconBot 组变成空组 → 我们以为自己不受限，实际是被 Disallow 的。

export function parseRobots(text: string, uaToken: string): Parsed {
  const ua = uaToken.toLowerCase();
  const groups: { agents: string[]; rules: Rule[]; crawlDelaySec: number | null }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastLineWasAgent = false;

  for (const raw of text.split(/\r?\n/)) {
    // 注释可以出现在行尾
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      // 上一条也是 UA → 并入同一组；否则开新组
      if (!lastLineWasAgent || !current) {
        current = { agents: [], rules: [], crawlDelaySec: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastLineWasAgent = true;
      continue;
    }
    lastLineWasAgent = false;
    if (!current) continue; // 组外的指令（如 Sitemap）忽略

    if (field === 'disallow' || field === 'allow') {
      // `Disallow:`（空值）= 不禁止任何东西，不是禁止根路径。丢掉它，否则会被当成 path=''
      // 的规则参与最长匹配，长度 0 排在最后，行为上恰好无害——但语义上是错的，别依赖巧合。
      if (field === 'disallow' && value === '') continue;
      current.rules.push({ path: value, allow: field === 'allow' });
    } else if (field === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelaySec = n;
    }
  }

  // 精确匹配我们的 UA 优先；没有就退到 `*`；两者都没有 = 该站没管我们
  const exact = groups.filter((g) => g.agents.some((a) => a === ua || (a !== '*' && ua.includes(a))));
  const wildcard = groups.filter((g) => g.agents.includes('*'));
  const picked = exact.length > 0 ? exact : wildcard;
  if (picked.length === 0) return null;

  // 同一 UA 出现在多个组里时合并（robots.txt 允许，虽然少见）
  return {
    rules: picked.flatMap((g) => g.rules),
    crawlDelaySec: picked.map((g) => g.crawlDelaySec).find((d) => d != null) ?? null,
  };
}

/**
 * 路径是否被规则允许。
 *
 * 最长匹配优先（RFC 9309 §2.2.2）；长度相同时 Allow 胜过 Disallow。
 * 支持 `*` 通配与 `$` 行尾锚。没有任何规则命中 → 允许。
 */
export function isPathAllowed(group: Parsed, pathWithQuery: string): boolean {
  if (!group || group.rules.length === 0) return true;
  let best: { len: number; allow: boolean } | null = null;
  for (const r of group.rules) {
    if (!matchRule(r.path, pathWithQuery)) continue;
    // 通配符规则的「长度」按模式串算，够用：`/a*` 与 `/ab` 同时命中 /abc 时，
    // 前者 3 后者 3，平手走 Allow 优先，这与主流实现一致。
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
  }
  return best ? best.allow : true;
}

function matchRule(pattern: string, path: string): boolean {
  if (pattern === '') return false;
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  // 逐段拆 `*`，再把每段当字面量去正则转义——直接把整串塞进 RegExp 会被路径里的
  // `.` `?` `+` `(` 等字符改变语义（真实站点的 Disallow 里这些很常见）。
  const parts = body.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp('^' + parts.join('.*') + (anchored ? '$' : ''));
  return re.test(path);
}

// ── 取回 ────────────────────────────────────────────────

async function loadRobots(origin: string, uaToken: string): Promise<Parsed> {
  const hit = cache.get(origin);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.parsed;

  let parsed: Parsed = null;
  try {
    // 走 assertPublicUrl 而不是 safeFetch：safeFetch 现在会回头调本模块，套一层就成环。
    // robots.txt 只有一跳、只读纯文本，这点检查够了。
    const { resolvedIps } = await assertPublicUrl(`${origin}/robots.txt`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ROBOTS_TIMEOUT_MS);
    try {
      const agent = origin.startsWith('https')
        ? new https.Agent({ lookup: pinnedLookup(resolvedIps) as never })
        : new http.Agent({ lookup: pinnedLookup(resolvedIps) as never });
      const res = await fetch(`${origin}/robots.txt`, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: { 'user-agent': `${uaToken}/1.0`, accept: 'text/plain,*/*' },
        // @ts-expect-error Node.js fetch 接受 agent，类型定义未覆盖
        agent,
      });
      if (res.ok) {
        const buf = await res.arrayBuffer();
        const text = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, ROBOTS_MAX_BYTES));
        parsed = parseRobots(text, uaToken);
      } else if (res.status >= 500) {
        console.warn(`[robots] ${origin} 返回 ${res.status}，本次放行（见本文件顶部的取舍说明）`);
      }
      // 4xx 一律 parsed=null（放行）：没有 robots.txt 就是没有限制
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.warn(`[robots] 取 ${origin}/robots.txt 失败（${(e as Error).message}），本次放行`);
  }

  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(origin, { at: Date.now(), parsed });
  return parsed;
}

export type RobotsVerdict = { allowed: true } | { allowed: false; reason: string };

/** 目标 URL 是否被其站点的 robots.txt 允许抓取。 */
export async function checkRobots(url: URL, uaToken = BEACON_UA_TOKEN): Promise<RobotsVerdict> {
  const group = await loadRobots(url.origin, uaToken);
  const target = url.pathname + (url.search || '');
  if (isPathAllowed(group, target)) return { allowed: true };
  return {
    allowed: false,
    reason: `${url.hostname} 的 robots.txt 不允许抓取 ${url.pathname}`,
  };
}
