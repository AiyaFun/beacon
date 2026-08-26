import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// RLS 生效路径的静态守卫。
//
// 背景：31 张表都开了 FORCE ROW LEVEL SECURITY，但策略是「app_current_tenant() IS NULL → 放行」
// （worker/回调没有租户上下文，必须放行）。于是**只有走 withSession() 的查询才真受行级隔离约束**。
// 2026-07-30 体检时发现 withSession 全仓零调用点 = 行级隔离对网页请求形同虚设。
//
// 这份守卫钉两件事：
//   ① 高风险写操作（按用户传进来的 id 查归属再改/删）必须留在 withSession 里，不许退回裸 prisma；
//   ② withSession 的回调里**不许**出现 LLM/嵌入/外部抓取调用——交互式事务会独占连接，
//      把几十秒的模型调用圈进事务是比「少一层兜底」严重得多的事故。

const APP = join(process.cwd(), 'app');

function read(rel: string): string {
  return readFileSync(join(APP, rel), 'utf8');
}

/** 取某个 export function 的函数体（粗切：到下一个顶格 `export ` 为止，够用于本守卫）。 */
function bodyOf(src: string, fnName: string): string {
  const start = src.indexOf(`export async function ${fnName}`);
  if (start < 0) return '';
  const rest = src.slice(start + 1);
  const next = rest.indexOf('\nexport ');
  return next < 0 ? rest : rest.slice(0, next);
}

// 已迁移清单：文件 → 必须在 withSession 里的 action
const MIGRATED: { file: string; fns: string[] }[] = [
  { file: '(app)/material/actions.ts', fns: ['actUpdateMaterial', 'actDeleteMaterial'] },
  { file: '(app)/persona/actions.ts', fns: ['actDeleteMemory', 'actUpdateMemory'] },
  { file: '(app)/data/actions.ts', fns: ['actAttachPublishUrl'] },
  { file: '(app)/topics/actions.ts', fns: ['actAccept'] },
  // 账号合并/删除：按用户传进来的两个 id 搬数据、删账号，是本仓最不可逆的一对写操作
  { file: '(app)/actions.ts', fns: ['actAccountInventory', 'actMergeAccounts', 'actDeleteAccount'] },
];

describe('RLS 生效路径', () => {
  for (const { file, fns } of MIGRATED) {
    for (const fn of fns) {
      it(`${fn} 仍走 withSession（不许退回裸 prisma）`, () => {
        const body = bodyOf(read(file), fn);
        expect(body, `${file} 里找不到 ${fn}`).not.toBe('');
        expect(body).toContain('withSession(');
        // 事务里必须用 tx，不能混用全局 prisma——混用等于那句查询根本没进 RLS 上下文。
        // 两种写法都认：直接 `tx.xxx.` 查询，或把 tx 交给 lib 里的函数（如 mergeAccounts(tx, …)）。
        const inTx = body.slice(body.indexOf('withSession('));
        expect(inTx).toMatch(/\btx\.\w+\.|\(\s*tx\s*,/);
      });
    }
  }

  it('withSession 的事务里不许有 LLM / 嵌入 / 外部抓取（会独占数据库连接）', () => {
    const banned = /(llmComplete|llmCompleteStream|embedText|getEmbedder|safeFetch|upsertMemoryEmbedding)\s*\(/;
    const offenders: string[] = [];
    let scopes = 0;
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name)) {
          const src = readFileSync(p, 'utf8');
          let i = src.indexOf('withSession(');
          while (i >= 0) {
            // 粗切一个作用域窗口：足够覆盖单个 action 的事务体
            const window = src.slice(i, i + 2000);
            const end = window.indexOf('\n  });');
            const scope = end > 0 ? window.slice(0, end) : window;
            scopes++;
            if (banned.test(scope)) offenders.push(`${p.replace(process.cwd() + '/', '')}`);
            i = src.indexOf('withSession(', i + 1);
          }
        }
      }
    };
    walk(APP);
    expect(offenders, `这些文件把慢调用写进了 withSession 事务：${offenders.join(', ')}`).toEqual([]);
    // 【没有这句它可以永远绿】遍历失败、或者 withSession( 这个字面量被改名，
    // 一个作用域都切不出来时 offenders 恒为空——而那正是这条守卫最该报警的时候。
    expect(scopes, '一个 withSession 作用域都没切出来，扫描坏了').toBeGreaterThan(5);
  });
});
