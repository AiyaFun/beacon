import { execFileSync } from 'node:child_process';
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

export const TEST_DB_DIR = path.join(os.tmpdir(), 'beacon-vitest-db');
export const TEMPLATE_DB = path.join(TEST_DB_DIR, 'template.db');

export default function setup() {
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });

  const root = path.resolve(__dirname, '../..');
  execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: root,
    // 绝对路径 file: URL —— 相对路径会被 prisma 解析成相对 schema 目录，从而写进仓库
    env: { ...process.env, DATABASE_URL: `file:${TEMPLATE_DB}` },
    stdio: 'pipe',
  });

  if (!fs.existsSync(TEMPLATE_DB)) throw new Error(`模板库未生成：${TEMPLATE_DB}`);

  return () => {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  };
}
