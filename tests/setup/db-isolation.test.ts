import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { TEST_DB_DIR } from './global-setup';

// 两个 vitest 进程同时跑，不许互相删库。
//
// 【撞过两次】测试库目录曾经写死成 `os.tmpdir()/beacon-vitest-db`，而 globalSetup 的第一句
// 就是把整个目录 rmSync 掉。于是同一台机器上第二个 vitest 进程一启动，
// 就把**第一个进程正在用的**模板库连同它所有临时库一起删了。两种形态都见过：
//   · 先跑的那个报上百条 `ENOENT: copyfile … template.db`——看起来像「几乎所有测试都挂了」；
//   · 后跑的那个 `prisma db push` 直接炸 SQLite error，然后 `Test Files no tests`。
// 两种都不是业务代码的问题，但都长得像灾难性回归，排查会先往错的方向跑很远
//（2026-07-29 一次，2026-08-07 又一次）。
//
// 触发条件毫不罕见：编辑器里跑着一轮、终端又跑一轮，或者两个会话各跑各的。
// 注意 `--no-file-parallelism` 治的是**同一进程内**的并发，对这个跨进程问题没有任何作用——
// 别再把它当成这件事的解法。

describe('测试库目录按运行隔离', () => {
  it('🔒 不是所有进程共用的那个固定路径', () => {
    expect(TEST_DB_DIR).not.toBe(path.join(os.tmpdir(), 'beacon-vitest-db'));
  });

  it('🔒 仍然在 beacon-vitest-db 底下（便于人工清理），但多一层本次运行专属的目录', () => {
    const parent = path.join(os.tmpdir(), 'beacon-vitest-db');
    expect(TEST_DB_DIR.startsWith(parent + path.sep)).toBe(true);
    expect(path.basename(TEST_DB_DIR).length).toBeGreaterThan(4);
  });

  it('worker 拿到的库确实落在本次运行的目录里（环境变量真的传下来了）', () => {
    const url = process.env.DATABASE_URL ?? '';
    expect(url.startsWith('file:')).toBe(true);
    expect(path.dirname(url.slice('file:'.length))).toBe(process.env.BEACON_TEST_DB_DIR);
  });
});
