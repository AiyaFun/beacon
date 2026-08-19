import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 全局 setup：跑一次 `prisma db push` 建出一个空库模板，后续每个测试文件复制一份用。
// 这样 schema 迁移只付一次代价（~2s），而每个文件仍拿到全新隔离的库。
//
// 为什么用真 SQLite 而不是 mock prisma：
//   邀请流的核心正确性恰恰在 DB 语义上——`updateMany({where:{status:'pending'}})` 的原子抢占、
//   Member.phone 的唯一约束、expiresAt 的时间比较。mock 掉 prisma 等于把要测的东西换成手写桩，
//   测的是桩的行为不是实现的行为。真 SQLite 才能证明「同一 token 不可复用」。
//
// ⚠️ **每次运行必须有自己的目录**。这里曾经写死 `os.tmpdir()/beacon-vitest-db`，
// 而 setup 的第一句就是把整个目录 rmSync 掉——于是同一台机器上第二个 vitest 进程一启动，
// 就把**第一个进程正在用的** template.db 和它所有的临时库一起删了。
// 第一个进程随即报上百条 `ENOENT: copyfile … template.db`，形态是「几乎所有测试文件都挂了」，
// 看起来像灾难性回归，实际一行业务代码都没错（2026-07-29 撞过，2026-08-07 又撞了一次）。
// 触发条件毫不罕见：编辑器里跑着一轮、终端又跑一轮，或者两个会话各跑各的。
// `--no-file-parallelism` 治的是同一进程内的并发，对这个跨进程的问题没有任何作用。
const RUN_DIR = path.join(os.tmpdir(), 'beacon-vitest-db', `${process.pid}-${crypto.randomUUID().slice(0, 8)}`);

export const TEST_DB_DIR = RUN_DIR;
export const TEMPLATE_DB = path.join(RUN_DIR, 'template.db');

/** worker 进程靠这个环境变量找到本次运行的目录（globalSetup 在主进程跑，worker fork 时继承）。 */
export const TEST_DB_DIR_ENV = 'BEACON_TEST_DB_DIR';

// 崩溃退出（Ctrl-C / 进程被杀）留下的目录没人清。按 mtime 扫一遍：
// 六小时是个安全阈值——任何一次真实运行都远短于它，所以不可能误删正在跑的那一份。
function sweepStale(root: string) {
  try {
    for (const name of fs.readdirSync(root)) {
      const p = path.join(root, name);
      const st = fs.statSync(p);
      if (st.isDirectory() && Date.now() - st.mtimeMs > 6 * 3600_000) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    }
  } catch {
    /* 清不掉就算了，这只是省磁盘，不能影响测试 */
  }
}

export default function setup() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  sweepStale(path.dirname(RUN_DIR));
  process.env[TEST_DB_DIR_ENV] = RUN_DIR;

  const root = path.resolve(__dirname, '../..');
  execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: root,
    // 绝对路径 file: URL —— 相对路径会被 prisma 解析成相对 schema 目录，从而写进仓库
    env: { ...process.env, DATABASE_URL: `file:${TEMPLATE_DB}` },
    stdio: 'pipe',
  });

  if (!fs.existsSync(TEMPLATE_DB)) throw new Error(`模板库未生成：${TEMPLATE_DB}`);

  return () => {
    // 只删自己那一份，绝不动兄弟目录（那可能是另一个正在跑的进程）
    fs.rmSync(RUN_DIR, { recursive: true, force: true });
  };
}
