import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 运行时依赖必须真的在运行时装得到（2026-08-29 补）。
//
// 【这条守卫存在的理由，是一个已经发生过的、只在客户机器上发生的故障】
// lib/browser/local.ts 会 `await import('playwright-core')`，但 playwright-core
// 从来没写进 package.json 的 dependencies —— 它只是 devDependency `@playwright/test`
// 的传递依赖。于是：
//
//   deploy/appliance/install.sh  → `npm ci`（含 devDeps）        → 首装能用
//   deploy/appliance/update.sh   → `npm ci --omit=dev`           → **升级后被裁掉**
//   deploy/appliance/update.ps1  → 同上
//
// 也就是说：**任何做过一次一键更新的整机，本机浏览器采集是彻底坏的。**
// 而 Docker（private 形态）用的是完整 `npm ci` 并整份拷贝 node_modules，所以不受影响——
// 这正是它能一直没被发现的原因：本地全绿、私有化全绿，只有卖出去的那台机器坏。
//
// 【为什么不是「把 --omit=dev 去掉」】那会让客户机器上多装几百 MB 的测试框架。
// 正确的方向是：**运行时用到的东西，就得声明成运行时依赖**。
//
// 这条守卫也是「部署盲区」那一类的通用形状：本地跑得通不等于装出去跑得通。

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const pkg = JSON.parse(read('package.json')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/**
 * 服务端源码里动态 import 的第三方包 → 必须在 dependencies 里。
 * 新增一条时，同时把用它的文件写在右边，出问题时一眼知道去哪看。
 */
const RUNTIME_IMPORTS: { pkg: string; usedBy: string }[] = [
  { pkg: 'playwright-core', usedBy: 'lib/browser/local.ts' },
];

describe('运行时依赖：--omit=dev 之后还得在', () => {
  it.each(RUNTIME_IMPORTS)('$pkg 在 dependencies 里（$usedBy 会 import 它）', ({ pkg: name, usedBy }) => {
    expect(read(usedBy)).toContain(`'${name}'`);
    expect(
      pkg.dependencies?.[name],
      `${name} 被 ${usedBy} 在运行时 import，但不在 dependencies 里。`
      + '整机版升级脚本跑的是 `npm ci --omit=dev`，装出去的机器上它会消失，'
      + '报错是 Cannot find module，完全不指向真因。',
    ).toBeTruthy();
  });

  it('package-lock 里也不能标成 dev-only（--omit=dev 认的是 lock 不是 package.json）', () => {
    const lock = JSON.parse(read('package-lock.json')) as {
      packages?: Record<string, { dev?: boolean }>;
    };
    for (const { pkg: name } of RUNTIME_IMPORTS) {
      const entry = lock.packages?.[`node_modules/${name}`];
      expect(entry, `lock 里没有 node_modules/${name}`).toBeTruthy();
      expect(entry?.dev, `${name} 在 lock 里被标成 dev，--omit=dev 仍然会裁掉它`).not.toBe(true);
    }
  });

  it('整机升级脚本确实在用 --omit=dev（前提变了这条守卫就该重写）', () => {
    // 【为什么要断言这个前提】上面两条的全部意义都建立在「升级会裁掉 devDeps」之上。
    // 哪天有人把 --omit=dev 去掉了，这条会红——那时该做的是重新想清楚，
    // 而不是让两条守卫在一个不成立的前提上继续绿着。
    expect(read('deploy/appliance/update.sh')).toContain('--omit=dev');
    expect(read('deploy/appliance/update.ps1')).toContain('--omit=dev');
  });
});
