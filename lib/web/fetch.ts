import dns from 'node:dns/promises';
import net from 'node:net';

// 带 SSRF 护栏的网页抓取 —— 全站唯一入口。
//
// 原本长在 lib/skills/import.ts 里（「从网址导入技能」用），现在群里发链接也要抓正文，
// 抽到这里共用。**不要再写第二份**：SSRF 护栏这种东西一旦有两份实现，
// 迟早有一份会漏掉重定向复验或 IPv4-mapped IPv6 这类边角，而漏的那份不会有任何报错。

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 2_000_000; // 2MB 上限
const MAX_REDIRECTS = 3;

// ── SSRF 护栏 ────────────────────────────────────────────
// 只允许 http/https + 公网地址。域名解析到内网、IP 字面量在私有段、localhost/.local 一律拒。
// 手动跟随重定向并逐跳复验（防「重定向到内网」绕过）。不是防 DNS rebinding 的银弹，
// 但挡住了直连内网/回环/云元数据（169.254.169.254）这类常见 SSRF 面。

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^100\.6[4-9]\./, /^100\.[7-9]\d\./, /^100\.1[01]\d\./, /^100\.12[0-7]\./];

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return PRIVATE_V4.some((r) => r.test(ip));
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
    // IPv4-mapped ::ffff:a.b.c.d
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return false;
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('网址格式不合法');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只支持 http/https 链接');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
    throw new Error('不允许访问内网 / 本机地址');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('不允许访问内网 / 本机地址');
    return u;
  }
  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new Error('无法解析该网址的域名');
  }
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('不允许访问内网 / 本机地址');
  }
  return u;
}

/** GitHub 网页版 blob 链接 → raw 直链（避免拿到 HTML 外壳而非原文）。 */
function normalizeGithubUrl(u: URL): URL {
  if (u.hostname === 'github.com') {
    const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
    if (m) return new URL(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`);
  }
  return u;
}

export type FetchedPage = { finalUrl: URL; contentType: string; text: string };

// 抓取抽象：默认走 safeFetch；单测注入假实现验证解析逻辑（不碰网络/DNS）。
export type FetchPage = (url: string) => Promise<FetchedPage>;

export async function safeFetch(startUrl: string, opts: { userAgent?: string } = {}): Promise<FetchedPage> {
  const ua = opts.userAgent ?? 'BeaconBot/1.0 (+https://beacon.iyunci.cn)';
  let current = normalizeGithubUrl(await assertPublicUrl(startUrl));
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(current, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: { 'user-agent': ua, accept: 'text/html,application/json,text/markdown,text/plain,*/*' },
      });
    } catch (e) {
      throw new Error(`抓取失败：${(e as Error).name === 'AbortError' ? '请求超时' : (e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    // 3xx：手动逐跳复验，防重定向绕过 SSRF
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`抓取失败：HTTP ${res.status} 但无跳转地址`);
      if (hop === MAX_REDIRECTS) throw new Error('重定向次数过多');
      current = normalizeGithubUrl(await assertPublicUrl(new URL(loc, current).toString()));
      continue;
    }
    if (!res.ok) throw new Error(`抓取失败：HTTP ${res.status}`);

    const contentType = res.headers.get('content-type') ?? '';
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw new Error('目标内容过大（>2MB）');
    // 编码：多数站点是 UTF-8；少数国内老站是 GB18030，用 header/meta 里的声明兜一道，
    // 否则抓回来是一片乱码，而乱码送进 LLM 会得到一段一本正经的胡说
    const charset = /charset=([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase();
    const text = decodeBuffer(buf, charset);
    return { finalUrl: current, contentType, text };
  }
  throw new Error('重定向次数过多');
}

function decodeBuffer(buf: ArrayBuffer, charset?: string): string {
  const tryDecode = (cs: string) => {
    try {
      return new TextDecoder(cs, { fatal: false }).decode(buf);
    } catch {
      return null;
    }
  };
  if (charset && charset !== 'utf-8' && charset !== 'utf8') {
    const t = tryDecode(charset);
    if (t) return t;
  }
  const utf8 = new TextDecoder('utf-8').decode(buf);
  // header 没声明编码时，再看 HTML 里的 <meta charset>；只在 utf-8 解出明显乱码时才重来
  const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(utf8.slice(0, 2000))?.[1]?.toLowerCase();
  if (meta && meta !== 'utf-8' && meta !== 'utf8') {
    const t = tryDecode(meta);
    if (t) return t;
  }
  return utf8;
}

/** 粗暴去标签：拿全文文本用，不保留结构。要正文请用 lib/clip/extract。 */
export function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = (titleMatch?.[1] ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return { title, text };
}
