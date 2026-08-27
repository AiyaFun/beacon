import http from 'node:http';
import https from 'node:https';
import { assertPublicUrl, pinnedLookup } from './ssrf';
import { checkRobots } from './robots';

// 带 SSRF 护栏的网页抓取 —— 全站唯一入口。
//
// 原本长在 lib/skills/import.ts 里（「从网址导入技能」用），现在群里发链接也要抓正文，
// 抽到这里共用。**不要再写第二份**。
// SSRF 护栏本身在 ./ssrf.ts（robots.ts 也要用它，留在这里会成循环 import）；
// 下面这行 re-export 保留原来的入口，lib/skills/import.ts 等处不用改。
export { assertPublicUrl, isPrivateIp } from './ssrf';

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 2_000_000; // 2MB 上限
const MAX_REDIRECTS = 3;

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

export async function safeFetch(
  startUrl: string,
  opts: { userAgent?: string; respectRobots?: boolean } = {},
): Promise<FetchedPage> {
  const ua = opts.userAgent ?? 'BeaconBot/1.0 (+https://beacon.iyunci.cn)';
  // 默认遵守 robots。关掉它必须是**显式**的一次决定，不能靠忘了传参数悄悄绕过
  // （理由见 lib/web/robots.ts 文件头：违反 robots 会成为反法诉讼里对我们不利的事实）。
  const respectRobots = opts.respectRobots !== false;
  let resolved = await assertPublicUrl(startUrl);
  let current = normalizeGithubUrl(resolved.url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (respectRobots) {
      const verdict = await checkRobots(current);
      if (!verdict.allowed) throw new Error(`抓取被拒绝：${verdict.reason}`);
    }
    // 用 pinnedLookup 将 TCP 连接锁定在已验证的公网 IP 上，消除 DNS rebinding TOCTOU
    const agent = current.protocol === 'https:'
      ? new https.Agent({ lookup: pinnedLookup(resolved.resolvedIps) as never })
      : new http.Agent({ lookup: pinnedLookup(resolved.resolvedIps) as never });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(current, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: { 'user-agent': ua, accept: 'text/html,application/json,text/markdown,text/plain,*/*' },
        // @ts-expect-error Node.js fetch 接受 dispatcher / agent，类型定义未覆盖
        agent,
      });
    } catch (e) {
      throw new Error(`抓取失败：${(e as Error).name === 'AbortError' ? '请求超时' : (e as Error).message}`);
    } finally {
      clearTimeout(timer);
      agent.destroy();
    }

    // 3xx：手动逐跳复验，防重定向绕过 SSRF
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`抓取失败：HTTP ${res.status} 但无跳转地址`);
      if (hop === MAX_REDIRECTS) throw new Error('重定向次数过多');
      resolved = await assertPublicUrl(new URL(loc, current.toString()).toString());
      current = normalizeGithubUrl(resolved.url);
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
