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
    // 【逐条判，不是整份判】原来只要文件里**任何一处**出现 IF NOT EXISTS 就算过，
    // 于是一份十条语句、只有第一条幂等的 SQL 照样绿——而重跑时炸的是后面那九条。
    // 这条守卫存在的理由（安装脚本会被重跑、02-rls 每次加表都要重跑）恰恰要求逐条成立。
    const files = fs.readdirSync('prisma/postgres').filter((f) => f.endsWith('.sql'));
    expect(files.length, '一份 SQL 都没扫到，这条守卫自己坏了').toBeGreaterThanOrEqual(9);

    for (const f of files) {
      const sql = fs.readFileSync(`prisma/postgres/${f}`, 'utf-8')
        .replace(/--[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      const bad: string[] = [];
      for (const kw of [
        [/CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/gi, 'CREATE TABLE 少了 IF NOT EXISTS'],
        [/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)/gi, 'CREATE INDEX 少了 IF NOT EXISTS'],
        [/ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/gi, 'ADD COLUMN 少了 IF NOT EXISTS'],
      ] as const) {
        if ((sql.match(kw[0] as RegExp) ?? []).length > 0) bad.push(kw[1] as string);
      }
      // 策略没有 CREATE POLICY IF NOT EXISTS 这种写法，只能靠前面先 DROP
      const created = (sql.match(/CREATE\s+POLICY\s/gi) ?? []).length;
      const dropped = (sql.match(/DROP\s+POLICY\s+IF\s+EXISTS/gi) ?? []).length;
      if (created > dropped) bad.push(`${created} 条 CREATE POLICY 只配了 ${dropped} 条 DROP POLICY IF EXISTS`);

      expect(bad, `${f} 有不幂等的语句：${bad.join('；')}`).toEqual([]);
    }
  });
});
