// 版本号比较——**纯函数、零依赖**，故意单独成文件。
//
// 原先它住在 lib/downloads.ts 里，而那个文件顶部 import 了 node:fs（要读清单）。
// 客户端组件一旦 import 它，就会把 fs 拽进浏览器包里。桌面客户端的「有新版」提醒
// 必须在浏览器里比版本，所以把它挪到这里，两边都能安全地用。
export function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
