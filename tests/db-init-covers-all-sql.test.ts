import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

// 初始化脚本必须应用 prisma/postgres 下的**每一份** SQL。
//
// 历史缺口：脚本里写死只跑 01-pgvector 和 02-rls，03..09 全靠人记得手工执行。
// 忘一次 = 生产 42P01（表不存在），而且通常等到某个功能第一次被用到才炸；
// 私有化交付里更是每来一个客户都要人肉连库。
// 这条用例钉住「新增 SQL 不需要改脚本，也不会被漏掉」这个性质。
describe('db-init 覆盖全部 SQL', () => {
  const script = fs.readFileSync('scripts/db-init-supabase.sh', 'utf-8');

  it('脚本遍历目录，而不是列举个别文件名', () => {
    expect(script).toMatch(/for f in "\$SQL_DIR"\/\*\.sql/);
    // 写死单个文件名的老写法一旦回来，新增的 SQL 又会被漏掉
    expect(script).not.toMatch(/SQL_PGVECTOR=/);
    expect(script).not.toMatch(/SQL_RLS=/);
  });

  it('目录里的 SQL 都带数字前缀 —— 执行顺序靠文件名排序，无前缀就不确定', () => {
    const files = fs.readdirSync('prisma/postgres').filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const f of files) expect(f, `${f} 缺少数字前缀`).toMatch(/^\d{2}-/);
  });

  it('每份 SQL 都是幂等的（重复跑安全）—— 否则「重跑安装脚本」会炸', () => {
    const files = fs.readdirSync('prisma/postgres').filter((f) => f.endsWith('.sql'));
    for (const f of files) {
      const sql = fs.readFileSync(`prisma/postgres/${f}`, 'utf-8');
      const idempotent = /IF NOT EXISTS|IF EXISTS|CREATE OR REPLACE|DROP POLICY IF EXISTS/i.test(sql);
      expect(idempotent, `${f} 看不出幂等写法（IF NOT EXISTS / DROP ... IF EXISTS / CREATE OR REPLACE）`).toBe(true);
    }
  });
});
