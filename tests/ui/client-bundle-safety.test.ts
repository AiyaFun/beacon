import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// 'use client' 文件不许 import 到服务端模块。
//
// 【为什么非要有这条】这类错 **tsc 不报、单测不红**：类型是对的、函数也存在，
// 只有真的把页面在浏览器里打开时才炸，形态是
//   Module not found: Can't resolve 'dns' / UnhandledSchemeError: node:crypto
// 也就是说，本地不起 dev、只跑 tsc+vitest 的话，它会一路绿到生产。
// 2026-08-19 一天之内踩了两次：
//   ① 出图工位从 lib/illustration/run 取一个张数上限 → 拉起 llmImage → quota → ioredis；
//   ② 发布凭证卡从 lib/publish/weibo 取 140 这个数字 → 拉起 node:crypto + prisma。
// 两次的正解都一样：**常量搬到 client-safe 的纯数据模块**（lib/cover/rules、lib/publish/capability）。

const ROOT = path.resolve(__dirname, '../..');
const DIRS = ['app', 'components'];

/**
 * **真正碰不得的东西**：Node 内置模块与只能在服务端跑的包。
 * 判据是「顺着 import 走下去会不会碰到它们」，不是「那个文件叫什么名字」。
 *
 * 【2026-08-30：这条守卫此前只查直接 import，且清单是手写的】
 * 上面那段注释写着「用**实际依赖图**来验，而不是靠命名约定」，
 * 而实现是一张 13 条模块名的清单 + 一条只匹配 `import … from '<那 13 个之一>'` 的正则——
 * 也就是说它查的恰恰是**命名约定**，而且只查一层。
 * 变异验证当场证实：在 components/NotificationBell.tsx（'use client'）里加
 *   `import { SHELL_DEFAULTS } from '@/lib/agent/shell';`
 *（lib/agent/shell.ts 顶层 import 了 node:child_process 与 node:fs/promises）
 * → 这三条用例全绿、tsc 也过，只有 next build 才炸。
 * 而「从服务端模块里取一个常量」正是它注释里记着的那两次真实事故的形状。
 */
const FORBIDDEN_LEAVES = [
  /^node:/,            // node:crypto / node:fs / node:child_process …
  /^(fs|path|crypto|child_process|dns|net|tls|os|http|https|zlib|worker_threads)$/,
  /^@prisma\//,
  /^prisma$/,
  /^ioredis$/,
  /^bullmq$/,
  /^playwright(-core)?$/,
  /^nodemailer$/,
];

/**
 * 顺着 `@/` 与相对 import 走依赖图，返回第一条「客户端文件 → … → 禁用叶子」的路径。
 *
 * 只跟仓库内的模块（`@/` 与 `./`）：第三方包的内部依赖跟不动，也没必要——
 * 真正会出事的是我们自己的服务端模块被客户端引进去。
 * 深度有上限：图里有环也不会转不出来。
 */
function serverLeakPath(entryRel: string, srcOf: (rel: string) => string | null): string[] | null {
  const seen = new Set<string>();
  const stack: { rel: string; path: string[] }[] = [{ rel: entryRel, path: [entryRel] }];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur.path.length > 12 || seen.has(cur.rel)) continue;
    seen.add(cur.rel);
    const src = srcOf(cur.rel);
    if (src === null) continue;
    // 【'use server' 是真正的边界，遍历到此为止】客户端 import 一个 server action，
    // Next.js 在编译期把它换成一次网络调用——action 文件里引的服务端模块**不会进客户端包**。
    // 不在这里停的话，几乎每个客户端组件都会被报成泄漏（它们本来就该调 action），
    // 那条守卫就会因为噪音太大而被人关掉。
    // 「不许从 action 文件里取常量」是另一回事，由下面那条用例单独管。
    if (cur.rel !== entryRel && /^\s*['"]use server['"]/.test(src)) continue;
    // 【`import type` 不算依赖】它在编译期被整条擦掉，运行时那条边不存在，
    // 打不进客户端包。不排除的话，凡是从服务端模块取一个类型的客户端组件都会被误报——
    // 而那是完全正当的写法。注意只排除**整条**是 type 的：
    // `import { type A, realThing } from 'x'` 仍然会产生真实的运行时 import。
    for (const m of src.matchAll(/(?:^|\n)(\s*import\s(?:\s*type\s)?[^\n]*?from\s*['"]([^'"]+)['"])/g)) {
      const stmt = m[1];
      const spec = m[2];
      if (/^\s*import\s+type\s/.test(stmt)) continue;
      // 'use server' 文件另有一条用例专门管，这里不重复跟进去
      if (FORBIDDEN_LEAVES.some((re) => re.test(spec))) return [...cur.path, spec];
      if (!spec.startsWith('@/') && !spec.startsWith('.')) continue;
      const rel = spec.startsWith('@/')
        ? spec.slice(2)
        : path.normalize(path.join(path.dirname(cur.rel), spec));
      stack.push({ rel, path: [...cur.path, rel] });
    }
  }
  return null;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') walk(p, out);
    } else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const FILES = DIRS.flatMap((d) => walk(path.join(ROOT, d))).map((f) => ({
  rel: path.relative(ROOT, f),
  src: fs.readFileSync(f, 'utf8'),
}));

const CLIENT_FILES = FILES.filter((f) => /^\s*['"]use client['"]/.test(f.src));

describe("'use client' 文件的依赖安全", () => {
  it('客户端组件确实存在（正则失效时别静默通过）', () => {
    expect(CLIENT_FILES.length).toBeGreaterThan(20);
  });

  it('🔒 顺着依赖图走下去不许碰到服务端模块（tsc 与单测都拦不住，只有 next build 才炸）', () => {
    // 解析一个仓库内模块的源码。带扩展名的直接读；不带的按 .ts/.tsx/index 依次试。
    const cache = new Map<string, string | null>();
    const srcOf = (rel: string): string | null => {
      if (cache.has(rel)) return cache.get(rel)!;
      const cands = [rel, `${rel}.ts`, `${rel}.tsx`, `${rel}/index.ts`, `${rel}/index.tsx`];
      let out: string | null = null;
      for (const c of cands) {
        const abs = path.join(ROOT, c);
        try {
          if (fs.statSync(abs).isFile()) { out = fs.readFileSync(abs, 'utf8'); break; }
        } catch { /* 试下一个 */ }
      }
      cache.set(rel, out);
      return out;
    };

    const bad: string[] = [];
    for (const f of CLIENT_FILES) {
      const leak = serverLeakPath(f.rel, srcOf);
      if (leak) bad.push(leak.join('\n     → '));
    }
    expect(
      bad,
      '这些客户端组件顺着 import 走下去会碰到服务端模块，页面在浏览器里编译失败：\n\n'
      + `${bad.join('\n\n')}\n\n`
      + '正解是把要用的常量搬到 client-safe 的纯数据模块（如 lib/cover/rules、lib/publish/capability），'
      + '而不是在客户端引服务端文件。',
    ).toEqual([]);
  });

  it('🔒 这条守卫真的会顺着依赖走（不是只查直接 import）', () => {
    // 【为什么要这条】上一版就是「只查直接 import + 手写模块名单」，
    // 而它的注释写的却是「用实际依赖图来验」。判据与说明不一致时，
    // 坏掉的一定是判据——所以这里拿一条**人造的两跳链路**喂给同一个函数。
    const fake: Record<string, string> = {
      'components/X.tsx': "'use client'\nimport { A } from '@/lib/mid';",
      'lib/mid.ts': "import { spawn } from 'node:child_process';\nexport const A = 1;",
    };
    const leak = serverLeakPath('components/X.tsx', (rel) => fake[rel] ?? fake[`${rel}.ts`] ?? null);
    expect(leak, '两跳的泄漏没被跟出来——依赖图遍历坏了').toBeTruthy();
    expect(leak!.join(' → ')).toContain('node:child_process');

    // 反过来：干净的链路不该被误报
    const clean: Record<string, string> = {
      'components/Y.tsx': "'use client'\nimport { B } from '@/lib/pure';",
      'lib/pure.ts': 'export const B = 2;',
    };
    expect(serverLeakPath('components/Y.tsx', (rel) => clean[rel] ?? clean[`${rel}.ts`] ?? null)).toBeNull();
  });

  it('🔒 server action 文件不许被当成普通模块从客户端取常量', () => {
    // 'use server' 文件的每一个导出都会变成一个可被外部调用的端点。
    // 从客户端 import 常量会把它连带打进 action 清单，既没必要也扩大了攻击面。
    const serverActionFiles = new Set(
      FILES.filter((f) => /^\s*['"]use server['"]/.test(f.src)).map((f) => f.rel.replace(/\.tsx?$/, '')),
    );
    const bad: string[] = [];
    for (const f of CLIENT_FILES) {
      const imports = [...f.src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)];
      for (const [, names, spec] of imports) {
        if (!spec.startsWith('.') && !spec.startsWith('@/')) continue;
        const resolved = spec.startsWith('@/')
          ? spec.slice(2)
          : path.normalize(path.join(path.dirname(f.rel), spec));
        if (!serverActionFiles.has(resolved)) continue;
        // action 本身可以引（那是正常用法）；这里拦的是**常量/类型之外的普通值**混进来
        const bare = names
          .split(',')
          .map((n) => n.trim())
          .filter((n) => n && !n.startsWith('type ') && !/^act[A-Z]/.test(n));
        if (bare.length) bad.push(`${f.rel} → ${spec}：${bare.join('、')}`);
      }
    }
    expect(bad, `这些客户端组件从 'use server' 文件里取了非 action 的东西：\n${bad.join('\n')}`).toEqual([]);
  });
});
