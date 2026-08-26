import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { qualifiedTable } from '@/lib/db';

// 2026-07-28 生产事故的回归测试。
//
// 事故：兑现事务里的行锁写成 `$queryRaw\`SELECT 1 FROM "Tenant" … FOR UPDATE\``。
// 生产库业务表在 beacon schema，而**裸 SQL 不吃连接串的 ?schema=**（那只作用于 Prisma
// 自己生成的 SQL）→ 42P01 relation "Tenant" does not exist
// → **用户付了钱、回调验签解密全过、最后一步兑现抛错**，微信收 5xx 重发 15 次。
//
// 为什么 1519 个测试全绿也没拦住：dev/CI 跑 SQLite，那行被 `file:` 判断整条跳过 ——
// 「只在生产分支执行的裸 SQL」是覆盖率的天然盲区。所以这里补两道：
//   ① qualifiedTable 的行为（含非法 schema 名拒绝拼 SQL）；
//   ② **源码级扫描**：lib/ 下任何裸 SQL 都不许出现未加 schema 限定的表名 —— 这条才是真正
//      能拦住"下一次有人这么写"的那道闸，且不需要 Postgres 就能跑。

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('qualifiedTable', () => {
  it('连接串带 schema= 时按它限定', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://u:p@h:5432/db?sslmode=require&schema=beacon');
    expect(qualifiedTable('Tenant')).toBe('"beacon"."Tenant"');
  });

  it('没有 schema= 时回落 public（本地 Postgres / 单 schema 部署）', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://u:p@h:5432/db');
    expect(qualifiedTable('Tenant')).toBe('"public"."Tenant"');
  });

  it('schema 名会被 URL 解码', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://u:p@h:5432/db?schema=my%5Fschema');
    expect(qualifiedTable('Tenant')).toBe('"my_schema"."Tenant"');
  });

  it('非法 schema 名一律拒绝，不带着可疑串去拼 SQL', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://u:p@h:5432/db?schema=beacon";DROP TABLE "Tenant');
    expect(() => qualifiedTable('Tenant')).toThrow(/不是合法标识符/);
  });
});

/** 递归收集 lib/ 下所有 .ts 文件。 */
function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) tsFiles(p, acc);
    else if (name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

describe('裸 SQL 不许写未限定 schema 的表名', () => {
  it('lib/ 全量扫描', () => {
    // 裸 SQL 里形如 FROM "Tenant" / JOIN "PaymentOrder" / UPDATE "Tenant" 的写法，
    // 只要没写成 "schema"."Table" 或 ${qualifiedTable(...)}，在多 schema 生产上就是定时炸弹。
    const bad: string[] = [];
    const pattern = /\b(?:FROM|JOIN|UPDATE|INTO)\s+"([A-Za-z_][A-Za-z0-9_]*)"/g;
    let scanned = 0;
    let withRawSql = 0;

    for (const file of tsFiles(join(process.cwd(), 'lib'))) {
      scanned++;
      const src = readFileSync(file, 'utf8');
      // 只看确实出现裸 SQL 的文件，避免把普通字符串误判
      if (!/\$query(Raw|RawUnsafe)|\$execute(Raw|RawUnsafe)/.test(src)) continue;
      withRawSql++;
      src.split('\n').forEach((line, i) => {
        if (!/\$query(Raw|RawUnsafe)|\$execute(Raw|RawUnsafe)/.test(line)) return;
        for (const m of line.matchAll(pattern)) {
          // "schema"."Table" 形式：紧跟一个点说明前面那个才是 schema，放行
          const after = line.slice((m.index ?? 0) + m[0].length);
          if (after.startsWith('.')) continue;
          bad.push(`${file.replace(process.cwd() + '/', '')}: ${line.trim()}`);
        }
      });
    }

    expect(bad, `以下裸 SQL 的表名没带 schema 限定，生产（schema=beacon）会 42P01：\n${bad.join('\n')}`).toEqual([]);

    // 【这条守卫自己坏了会静默全过】上面那句断言的是「违规清单为空」——
    // 而遍历失败、过滤条件写反、正则失效，任何一种都会让清单**恒为空**，
    // 于是它一直绿着，直到某天生产上又来一次 42P01（那次是付了钱发不出货）。
    expect(scanned, 'lib/ 下一个 .ts 都没扫到，遍历坏了').toBeGreaterThan(100);
    expect(withRawSql, '一个用裸 SQL 的文件都没找到——过滤条件大概写反了').toBeGreaterThan(0);
    // 正则本身也要证明它抓得住：喂一行已知违规的进去
    const probe = 'await prisma.$queryRaw`SELECT * FROM \"Tenant\" WHERE id = 1`';
    expect([...probe.matchAll(pattern)].length, '正则连明显违规的都抓不住').toBeGreaterThan(0);
  });
});
