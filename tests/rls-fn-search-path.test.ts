import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SQL = readFileSync(join(process.cwd(), 'prisma/postgres/02-rls.sql'), 'utf8');
/** 剥掉 SQL 注释再断言——注释里正在解释这件事本身，不剥会被自己的说明骗（本仓踩过三次） */
const code = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

// 2026-08-26 生产事故：RLS 辅助函数体内是未限定的 FROM "CreatorAccount"，而应用连接的
// search_path 是 "$user",public（Prisma 的 ?schema= 从不 SET search_path）——
// 于是所有 tenant-rls 事务一评估策略就报「表不存在」。平时不炸（策略 IS NULL 短路）、
// 本地也不炸（测试库对象在默认 schema），只有生产的这几条路径踩中。
describe('🔒 RLS 的 SQL 函数必须 pin search_path', () => {
  it('02-rls.sql 里每个 CREATE FUNCTION 都带 SET search_path', () => {
    const fns = [...code.matchAll(/CREATE OR REPLACE FUNCTION\s+(\w+)[\s\S]*?\$\$\s*LANGUAGE\s+sql\s+([^;]*);/gi)];
    expect(fns.length, '一个函数都没扫到，正则大概是坏的').toBeGreaterThanOrEqual(3);
    for (const m of fns) {
      expect(m[2], `函数 ${m[1]} 没 pin search_path —— 函数体按会话 search_path 解析表名，生产会炸`)
        .toMatch(/SET search_path FROM CURRENT/i);
    }
  });

  it('31 号修复文件存在且 ALTER 的是限定名（不限定的话 ALTER 自己就找不到函数）', () => {
    const fix = readFileSync(join(process.cwd(), 'prisma/postgres/31-rls-fn-search-path.sql'), 'utf8');
    for (const fn of ['app_current_tenant', 'app_tenant_workspaces', 'app_tenant_accounts']) {
      expect(fix, `31 号文件漏了 ${fn}`).toMatch(new RegExp(`ALTER FUNCTION beacon\\.${fn}\\(\\) SET search_path`));
    }
  });
});
