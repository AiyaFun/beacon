import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// 两份 schema 必须同构。
//
// 【为什么需要这条】`prisma/schema.prisma`(sqlite/dev) 与 `prisma/schema.postgres.prisma`(生产)
// 是两个文件，而**本地 tsc 与全部 4000+ 用例跑的都是 sqlite 那份**。只改了 sqlite：
// 本地全绿 → 服务器构建才报错（生产 client 从 postgres 那份生成）。
//
// 2026-08-20 真实发生：加 ScheduledAgent / BrowserTask 时，用同一个 python 匹配串改两份，
// 而两份的**缩进格式不同**（`workflowRuns    WorkflowRun[]` vs `workflowRuns WorkflowRun[]`），
// postgres 那份没匹配上——`str.replace` 不匹配时静默跳过，不报错。
// 结果是模型加进去了、Workspace 的反向关系没加，被部署闸门在服务器上拦下。
//
// 判据只比**结构**（模型名、字段名），不比格式与类型：
// 两份天然有差异（provider、原生类型、pgvector 那几列只在生产有），比全文只会天天误报。

const ROOT = path.resolve(__dirname, '..');
const SQLITE = fs.readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8');
const PG = fs.readFileSync(path.join(ROOT, 'prisma/schema.postgres.prisma'), 'utf8');

/** 只在生产那份存在的东西，每条都要有理由。 */
const PG_ONLY_FIELDS = new Set([
  'embedding_vec', // pgvector：向量列，sqlite 没有这个类型
  'centroid_vec',
]);

function models(src: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const fields = new Set<string>();
    for (const line of m[2].split('\n')) {
      const t = line.trim();
      // 跳过注释、块级属性（@@index 等）、空行
      if (!t || t.startsWith('//') || t.startsWith('@@')) continue;
      const f = /^(\w+)\s/.exec(t);
      if (f) fields.add(f[1]);
    }
    out.set(m[1], fields);
  }
  return out;
}

const A = models(SQLITE);
const B = models(PG);

describe('两份 schema 同构（只改一份 = 本地全绿、服务器才炸）', () => {
  it('模型清单一致', () => {
    const onlySqlite = [...A.keys()].filter((k) => !B.has(k));
    const onlyPg = [...B.keys()].filter((k) => !A.has(k));
    expect(onlySqlite, `这些模型只在 sqlite 那份有：${onlySqlite.join('、')}`).toEqual([]);
    expect(onlyPg, `这些模型只在 postgres 那份有：${onlyPg.join('、')}`).toEqual([]);
  });

  it('每个模型的字段清单一致（含关系字段——漏了反向关系 prisma 会拒绝生成 client）', () => {
    const diffs: string[] = [];
    for (const [name, fa] of A) {
      const fb = B.get(name);
      if (!fb) continue; // 上一条用例管
      for (const f of fa) if (!fb.has(f)) diffs.push(`${name}.${f} 只在 sqlite 有`);
      for (const f of fb) if (!fa.has(f) && !PG_ONLY_FIELDS.has(f)) diffs.push(`${name}.${f} 只在 postgres 有`);
    }
    expect(diffs, `两份 schema 字段不一致：\n  ${diffs.join('\n  ')}`).toEqual([]);
  });

  it('守卫本身不许静默失效（两份都要解析出足够多的模型）', () => {
    // 正则挂了的话上面两条会「零差异」全绿——那是最坏的假绿
    expect(A.size).toBeGreaterThan(40);
    expect(B.size).toBeGreaterThan(40);
    expect(A.get('Workspace')?.size ?? 0).toBeGreaterThan(10);
  });
});
