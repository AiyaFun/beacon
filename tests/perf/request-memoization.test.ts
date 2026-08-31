import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 请求内记忆化（2026-08-29 第五轮，量出来的）。
//
// ── 量到的事实 ──
//   · `getSession()` 全站 **223 个调用点**，内部 `getMemberByToken` 打 **5 次库**；
//     一次渲染里布局调一次、页面调一次、每个服务端子组件再各调一次——
//     **每多一层服务端组件就多 5 次数据库往返**，而它们查的是同一个东西。
//   · `listRuns(id, { takePerKind: 8 })` 在首页那一次渲染里被调**两次、参数一模一样**
//     （TenantShell 的「最近」+ 首页的「进行中」），内部 6 次库。
//   · 全站 `React.cache()` 使用次数：**0**。
//
// 这类损耗不报错、不变红，只表现为「每个页面都慢那么一点」——最难被归因的一种。

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('会话解析：请求内只查一次', () => {
  const src = read('lib/auth.ts');

  it('🔒 getMemberByToken 走 cache()', () => {
    expect(src).toContain("import { cache } from 'react'");
    expect(src).toContain('export const getMemberByToken = cache(getMemberByTokenUncached)');
  });

  it('🔒 缓存在 getMemberByToken 这一层，不是 getSession（切账号的安全性靠这个）', () => {
    // getSession() 每次重新读 cookie；有的 action 先读会话再 set(ACCOUNT_COOKIE) 切账号。
    // 缓存在 getSession 那层，切完账号后同一请求里再读会拿到**旧账号**。
    // 缓存在这层，参数变了缓存键就变 —— 切账号天然 miss，安全由构造保证。
    const sess = read('lib/session.ts');
    expect(sess).not.toContain('cache(');
  });

  it('🔒 缓存键包含 preferredAccountId（少了它，切账号会读到旧的）', () => {
    const i = src.indexOf('async function getMemberByTokenUncached');
    expect(i).toBeGreaterThan(0);
    expect(src.slice(i, i + 200)).toContain('preferredAccountId');
  });
});

describe('跑动记录：同一请求里不重复查', () => {
  const src = read('lib/runs/index.ts');

  it('🔒 缓存下沉到只吃原始值的那一层', () => {
    // React 的 cache() 按参数身份比，而 { takePerKind: 8 } 每次都是新对象，
    // 直接给 listRuns 套 cache() 永远命中不了
    expect(src).toContain('const listRunsCached = cache(listRunsUncached)');
    expect(src).toContain('listRunsCached(workspaceId, opts.takePerKind ?? 20)');
  });

  it('对外签名没变（几十处调用点不用动）', () => {
    expect(src).toContain('export function listRuns(workspaceId: string, opts: ListRunsOpts = {})');
  });
});

describe('首页那次重复调用还在（缓存正是为它而加）', () => {
  it('布局与首页确实用相同参数各调一次 listRuns', () => {
    const shell = read('components/TenantShell.tsx');
    const home = read('app/(app)/page.tsx');
    expect(shell).toContain('listRuns(session.workspaceId, { takePerKind: 8 })');
    expect(home).toContain('listRuns(s.workspaceId, { takePerKind: 8 })');
    // 两处参数必须一致，否则缓存不命中 —— 哪天有人改了其中一个数，这条会红
    const n = (shell.match(/takePerKind: 8/g) ?? []).length + (home.match(/takePerKind: 8/g) ?? []).length;
    expect(n, '两处的 takePerKind 不再相同，缓存就失效了').toBe(2);
  });
});
