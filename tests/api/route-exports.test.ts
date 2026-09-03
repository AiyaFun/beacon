import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// route.ts 只许导出 Next 认识的那几样（2026-09-03 加）。
//
// 【为什么值得一条常驻守卫】Next 的 App Router 对 route 文件的导出有白名单，多导出一个
// 普通常量/函数，`next build` 在**类型检查那一步**才报
//   Type error: Route "app/api/xxx/route.ts" does not match the required types of a Next.js Route.
// 而 `tsc --noEmit` 与全部单测都是绿的——本地怎么跑都发现不了，只有构建那一刻炸。
//
// 这一课在 2026-07 的飞书机器人路由上吃过一次，当时只写进了注释与记忆；
// 今天（executor 路由导出 READ_TEXT_FN）又原样犯了一遍。注释治不了这个，所以变成机器判据。
//
// 修法永远是同一个：把那个常量/函数搬到 lib/ 下，route.ts 只 import 它。

const ROOT = path.resolve(__dirname, '..', '..');

/** Next 允许 route 文件导出的名字。改这份清单前先查 Next 版本的文档。 */
const ALLOWED = new Set([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
  'dynamic', 'dynamicParams', 'revalidate', 'fetchCache', 'runtime',
  'preferredRegion', 'maxDuration', 'generateStaticParams',
]);

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) routeFiles(p, out);
    else if (e.name === 'route.ts' || e.name === 'route.tsx') out.push(p);
  }
  return out;
}

describe('🔒 route.ts 的导出', () => {
  const files = routeFiles(path.join(ROOT, 'app'));

  it('扫得到路由文件（扫不到的话这条守卫恒绿，等于不存在）', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('每个 route 文件都只导出 Next 认识的那几样', () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      // export const X / export function X / export async function X / export class X
      for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+(\w+)/gm)) {
        if (!ALLOWED.has(m[1])) bad.push(`${path.relative(ROOT, f)} 导出了 ${m[1]}`);
      }
      // export { X } / export type { X } —— 类型导出不影响运行时，但 Next 的检查只看值导出
      for (const m of src.matchAll(/^export\s+\{([^}]*)\}/gm)) {
        if (/^\s*type\s/.test(m[1])) continue;
        for (const raw of m[1].split(',')) {
          const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
          if (name && !ALLOWED.has(name)) bad.push(`${path.relative(ROOT, f)} 导出了 ${name}`);
        }
      }
    }
    expect(
      bad,
      'route.ts 只许导出 HTTP 方法与 Next 的几个配置常量。多导出一个，`next build` 会报\n'
      + '「does not match the required types of a Next.js Route」，而 tsc 与单测全绿——只有构建那一刻才炸。\n'
      + '把它搬到 lib/ 下，route.ts 只 import。\n',
    ).toEqual([]);
  });
});
