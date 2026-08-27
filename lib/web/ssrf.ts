import dns from 'node:dns/promises';
import net from 'node:net';

// SSRF 护栏 —— 全站唯一一份。
//
// 原本长在 lib/web/fetch.ts 里。2026-08-24 加 robots 闸时抽出来：robots.ts 也要验地址，
// 而它被 fetch.ts 依赖，留在原处就成了 fetch ↔ robots 的循环 import。
// **不要再写第二份**：这种东西一旦有两份实现，迟早有一份会漏掉重定向复验或
// IPv4-mapped IPv6 这类边角，而漏的那份不会有任何报错。
//
// 只允许 http/https + 公网地址。域名解析到内网、IP 字面量在私有段、localhost/.local 一律拒。
// 调用方需手动跟随重定向并**逐跳**复验（防「重定向到内网」绕过）。
// DNS rebinding 防护：assertPublicUrl 把解析到的公网 IP 列表一起返回（resolvedIps），
// 调用方可以用 pinnedLookup() 构造一个只返回这些 IP 的 lookup 函数传给 http(s).Agent，
// 使得实际 TCP 连接锁定在已验证的地址上，消除 resolve→connect 之间的 TOCTOU 窗口。
// safeFetch 已经在用这条路径。

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

export type PublicUrlResult = { url: URL; resolvedIps: string[] };

export async function assertPublicUrl(raw: string): Promise<PublicUrlResult> {
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
    return { url: u, resolvedIps: [host] };
  }
  let addrs: { address: string; family: number }[];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new Error('无法解析该网址的域名');
  }
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('不允许访问内网 / 本机地址');
  }
  return { url: u, resolvedIps: addrs.map((a) => a.address) };
}

/**
 * 构造一个只返回已验证 IP 的 lookup 函数，传给 http(s).Agent 的 lookup 选项。
 * 消除 DNS rebinding TOCTOU：实际 TCP 连接锁定在 assertPublicUrl 已检查过的地址上。
 */
export function pinnedLookup(ips: string[]): (hostname: string, opts: object, cb: Function) => void {
  return (_hostname: string, _opts: object, cb: Function) => {
    const ip = ips[0];
    cb(null, ip, net.isIPv6(ip) ? 6 : 4);
  };
}
