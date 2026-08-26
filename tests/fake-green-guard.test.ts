import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// 「扫源码的守卫」自己的守卫。
//
// 这个项目里有一百多条静态守卫，形状都是「读一个源文件 → 断言里面有/没有某段文字」。
// 它们的失效方式非常特别：**不会报错，只会一直绿**。而写它的人当场是看不出来的，
// 因为它「通过了」。2026-08-23 一次全量排查抓到的真例：
//
//   · `toContain('默认停在发布按钮前')` —— 那句话在 capability.ts 里**只存在于文件头注释**，
//     是我为讲清楚这条通道写的说明。八条平台文案全改回「我们绝不替你点」它照样绿，
//     而它当时放过的恰好就是它该抓的（快手那条没说破代点开关）。
//   · `toContain('PortraitConsentText')` —— 它是 `PortraitConsentTextForLibrary` 的**严格前缀**。
//     把封面工位换成渲染形象库那份同意文案（承诺「加密保存」，而一次性上传应该是
//     「默认用完即弃」，口径正好相反），整组 14 条用例全绿。
//
// 所以把当时那个一次性排查脚本固化成一条常驻守卫，机械地判三件事：
//   COMMENT_ONLY  剥掉注释就不成立 → 它守的是注释，代码怎么改都绿
//   NEVER_MATCHES 在目标文件里根本命中不到 → 断错了对象
//   PREFIX_TRAP   断的标识符是仓库里另一个更长标识符的前缀 → 换个东西也能满足
//
// 判不了的一律不报（绑不到具体文件、变量被重复赋值、正则太动态）——
// 宁可漏报，也不要用假报去消耗以后读这条用例的人。

const ROOT = path.resolve(__dirname, '..');

/**
 * 明知故犯的例外，每条都要写清为什么。
 * key = `<测试文件相对路径>:<被断言的字面量>`
 */
const EXEMPT: Record<string, string> = {};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 剥注释。字符串与模板串里的内容不动（URL 里的 // 不能当注释砍）。 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let q: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (q) {
      if (c === '\\') { out += c + (d ?? ''); i += 2; continue; }
      if (c === q) q = null;
      out += c; i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; i++; continue; }
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && d === '*') {
      i += 2; out += '  ';
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      i += 2; out += '  '; continue;
    }
    out += c; i++;
  }
  return out;
}

const EXT = /\.(tsx?|jsx?|mjs|cjs|json|md|sql|html|css|prisma|ya?ml|sh|txt)$/;
const CODE = /\.(tsx?|jsx?|mjs|cjs)$/;

function existsRel(rel: string): boolean {
  if (!rel || rel.startsWith('@/') || rel.startsWith('.')) return false;
  const abs = path.join(ROOT, rel);
  return fs.existsSync(abs) && fs.statSync(abs).isFile();
}

type Binding = { rel: string; strips: boolean };

/**
 * 变量名 → 它读的那个源文件。
 *
 * 只认「这个名字在整份测试里**只被赋值过一次**」的情形。`const src = read(...)`
 * 在每个用例里重新指一个文件是这套测试最常见的写法，硬绑一个会把其余用例的断言
 * 全判成「从不命中」——那种假报比漏报更浪费人。
 */
function bindings(testSrc: string): Map<string, Binding> {
  const stripHelpers = new Set<string>();
  for (const m of testSrc.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*\([^)]*\)\s*(?::[^=]*)?=>([\s\S]*?);/g)) {
    if (/replace\(/.test(m[2]) && /\\\/\\\*|\\\/\\\/|stripComments/.test(m[2])) stripHelpers.add(m[1]);
  }
  const assigned = new Map<string, number>();
  for (const m of testSrc.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/g)) {
    assigned.set(m[1], (assigned.get(m[1]) ?? 0) + 1);
  }

  const out = new Map<string, Binding>();
  for (const m of testSrc.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*([\s\S]*?);/g)) {
    const [, name, rhs] = m;
    if ((assigned.get(name) ?? 0) > 1) continue;
    if (!/readFileSync|(?:^|[^.\w])(?:read|code|src|load)(?:Src|File)?\s*\(/i.test(rhs)) continue;
    if (/=>\s*(?:fs\.)?readFileSync/.test(rhs) || /^\s*\(/.test(rhs)) continue; // 助手定义本身
    const lits = [...rhs.matchAll(/['"`]([^'"`\n]+)['"`]/g)].map((x) => x[1]).filter((s) => EXT.test(s) && existsRel(s));
    if (lits.length !== 1) continue;
    let strips = /replace\(/.test(rhs) && /\\\/\\\*|\\\/\\\/|stripComments/.test(rhs);
    for (const h of stripHelpers) if (new RegExp(`(?:^|[^.\\w])${h}\\s*\\(`).test(rhs)) strips = true;
    out.set(name, { rel: lits[0], strips });
  }
  return out;
}

type Assertion = { v: string; neg: boolean; op: string; body: string; line: number };

function assertions(testSrc: string, names: Iterable<string>): Assertion[] {
  const alt = [...names].map((n) => n.replace(/\$/g, '\\$')).join('|');
  if (!alt) return [];
  const re = new RegExp(
    String.raw`expect\(\s*(${alt})\s*(?:,[^)]*)?\)(\.not)?\.(toMatch|toContain)\(\s*`
    + String.raw`(\/(?:\\.|\[(?:\\.|[^\]])*\]|[^/\n])+\/[gimsuy]*|'(?:\\.|[^'])*'|"(?:\\.|[^"])*")\s*[,)]`,
    'g',
  );
  const out: Assertion[] = [];
  for (const m of testSrc.matchAll(re)) {
    out.push({ v: m[1], neg: !!m[2], op: m[3], body: m[4], line: testSrc.slice(0, m.index).split('\n').length });
  }
  return out;
}

function toRegex(body: string): RegExp | null {
  if (body.startsWith('/')) {
    const last = body.lastIndexOf('/');
    try { return new RegExp(body.slice(1, last), body.slice(last + 1).replace(/[gy]/g, '') + 'g'); }
    catch { return null; }
  }
  try {
    const lit = JSON.parse(body[0] === "'" ? `"${body.slice(1, -1).replace(/(?<!\\)"/g, '\\"')}"` : body) as string;
    return new RegExp(lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  } catch { return null; }
}

function count(re: RegExp, s: string): number {
  const r = new RegExp(re.source, re.flags);
  let c = 0;
  for (;;) {
    const m = r.exec(s);
    if (!m) break;
    c++;
    if (m[0] === '') r.lastIndex++;
    if (c > 99) break;
  }
  return c;
}

/** 仓库里出现过的标识符（只用于前缀陷阱判定）。 */
function repoIdents(): Set<string> {
  const out = new Set<string>();
  const scan = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) scan(p);
      else if (CODE.test(e.name)) {
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/[A-Za-z_$][\w$]{3,}/g)) out.add(m[0]);
      }
    }
  };
  for (const d of ['app', 'lib', 'components', 'extension']) scan(path.join(ROOT, d));
  return out;
}

type Finding = { kind: string; file: string; line: number; rel: string; body: string; note?: string };

function scanAll(): { findings: Finding[]; bound: number; checked: number } {
  const idents = repoIdents();
  const findings: Finding[] = [];
  let bound = 0;
  let checked = 0;

  for (const file of walk(path.join(ROOT, 'tests'))) {
    const rawTest = fs.readFileSync(file, 'utf8');
    if (!/readFileSync/.test(rawTest)) continue;
    // 【测试文件自己的注释也要先剥】否则「为了说清这条守卫原来长什么样」而在注释里
    // 原样引用的那行 expect(...) 会被当成一条真断言——这个探测器第一版就栽在这上面，
    // 与它要抓的形状一模一样。
    const src = stripComments(rawTest);
    const bind = bindings(src);
    if (bind.size === 0) continue;
    bound += bind.size;

    const cache = new Map<string, { raw: string; bare: string }>();
    const contentOf = (rel: string) => {
      if (!cache.has(rel)) {
        const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        cache.set(rel, { raw, bare: CODE.test(rel) ? stripComments(raw) : raw });
      }
      return cache.get(rel)!;
    };

    for (const a of assertions(src, bind.keys())) {
      const b = bind.get(a.v);
      const re = toRegex(a.body);
      if (!re || !b) continue;
      if (EXEMPT[`${path.relative(ROOT, file)}:${a.body}`]) continue;
      checked++;

      const c = contentOf(b.rel);
      const raw = b.strips ? c.bare : c.raw;
      const rec = { file: path.relative(ROOT, file), line: a.line, rel: b.rel, body: a.body };

      if (a.neg) {
        // 否定断言里只有一种机械判得了的：它禁的东西**只在注释里**出现过，
        // 说明这条守卫从来只拦到过注释
        if (count(re, raw) > 0 && count(re, c.bare) === 0) findings.push({ kind: 'NEG_COMMENT_ONLY', ...rec });
        continue;
      }

      if (count(re, raw) === 0) { findings.push({ kind: 'NEVER_MATCHES', ...rec }); continue; }
      if (count(re, c.bare) === 0) { findings.push({ kind: 'COMMENT_ONLY', ...rec }); continue; }

      if (a.op === 'toContain' && !a.body.startsWith('/') && CODE.test(b.rel)) {
        const lit = a.body.slice(1, -1);
        if (/^[A-Za-z_$][\w$]{3,}$/.test(lit)) {
          const longer = [...idents].filter((x) => x !== lit && x.startsWith(lit));
          if (longer.length > 0) findings.push({ kind: 'PREFIX_TRAP', ...rec, note: longer.slice(0, 3).join('、') });
        }
      }
    }
  }
  return { findings, bound, checked };
}

const RESULT = scanAll();

const HOWTO: Record<string, string> = {
  COMMENT_ONLY: '断言只在注释里命中 —— 它守的是注释，代码怎么改都绿。先剥注释再断言，并把断言落到真正的代码/文案上。',
  NEG_COMMENT_ONLY: '这条否定断言只拦得到注释 —— 先剥注释（用 code() 那种助手）再断言。',
  NEVER_MATCHES: '断言在目标文件里根本命中不到 —— 断错对象了（多半是变量绑到了别的文件）。',
  PREFIX_TRAP: '断的标识符是另一个更长标识符的前缀 —— 换成那个更长的东西它照样绿。加定界（比如断 `<Foo />` 而不是 `Foo`）。',
};

describe('扫源码的守卫不许是假绿', () => {
  it('没有「只在注释里成立」「从不命中」「前缀可冒充」的静态断言', () => {
    const lines = RESULT.findings.map(
      (f) => `  ${f.kind}  ${f.file}:${f.line}  断言 ${f.body.slice(0, 60)}  目标 ${f.rel}`
        + `${f.note ? `（更长的同前缀标识符：${f.note}）` : ''}\n      → ${HOWTO[f.kind]}`,
    );
    expect(RESULT.findings, `以下静态守卫是假绿（被守的代码坏掉时它们不会红）：\n${lines.join('\n')}\n\n`
      + '确实要保留的，在本文件的 EXEMPT 里按 `<测试路径>:<断言字面量>` 写明理由。').toEqual([]);
  });

  it('这条守卫真的扫到东西了（扫不到会静默全过）', () => {
    // 上面那条断言的是「违规清单为空」。绑定认不出来、正则失效、目录改名，
    // 任何一种都会让清单**恒为空**——那正是它自己要抓的第七种假绿。
    //
    // 【门槛要分辨「扫到了」和「一个没扫到」，不是钉住当前的数】第一版写的是 >200，
    // 而当时的真实值是 198——收紧别的守卫时把几条 toContain 合并掉，数一掉它就红。
    // 那种阈值只是把「样本达不到门槛」这种假绿倒过来变成了误报，一样会让人开始忽略它。
    // 坏掉的样子是 0，所以门槛留在安全的量级上就够了。
    expect(RESULT.bound, '一个「读了源文件的变量」都没绑上，绑定逻辑坏了').toBeGreaterThan(30);
    expect(RESULT.checked, '一条静态断言都没检查到，抽取逻辑坏了').toBeGreaterThan(80);
  });

  it('三个判据本身都还认得出对应的假绿（判据坏了也会静默全过）', () => {
    // 拿现造的样本喂给同一套函数，判据一旦失效这里先红。
    const bare = stripComments('const a = 1; // 这里有 needle\n/* 还有 needle */\nconst b = 2;');
    expect(bare, '剥注释坏了：注释里的东西没被剥掉').not.toContain('needle');
    expect(stripComments("const u = 'https://x/y'; // c"), '把字符串里的 // 当注释砍了').toContain('https://x/y');

    const probe = "const SRC = read('lib/db.ts');\nexpect(SRC).toContain('needle');";
    expect(bindings(probe).get('SRC')?.rel, '绑定认不出 read(字面量) 这种写法').toBe('lib/db.ts');
    expect(assertions(probe, ['SRC']), '断言抽取坏了').toHaveLength(1);
  });
});
