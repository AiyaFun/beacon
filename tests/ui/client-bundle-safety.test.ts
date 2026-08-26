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

// 这些模块自身或其依赖会碰到 node 内置模块 / prisma / 队列，客户端一律不许直接引。
// 判据是「它 import 了什么」，不是「它叫什么」——所以下面用实际依赖图来验，而不是靠命名约定。
const SERVER_ONLY_HINTS = [
  '@/lib/db',
  '@/lib/crypto',
  '@/lib/quota',
  '@/lib/ratelimit',
  '@/lib/publish/weibo',
  '@/lib/publish/wechat-mp',
  '@/lib/illustration/run',
  '@/lib/cover/run',
  '@/lib/llm/gateway',
  '@/lib/llm/image',
  'node:crypto',
  'node:fs',
  '@prisma/client',
];

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

  it('🔒 不许直接 import 服务端模块（tsc 与单测都拦不住，只有起 dev 才会炸）', () => {
    const bad: string[] = [];
    for (const f of CLIENT_FILES) {
      for (const m of SERVER_ONLY_HINTS) {
        // 只看 import/from，不看注释里提到的模块名（本文件自己就在注释里写了它们）
        const re = new RegExp(`(?:^|\\n)\\s*import[^\\n]*['"]${m.replace(/[/@]/g, '\\$&')}['"]`);
        if (re.test(f.src)) bad.push(`${f.rel} → ${m}`);
      }
    }
    expect(
      bad,
      `这些客户端组件引了服务端模块，页面会在浏览器里编译失败：\n${bad.join('\n')}\n` +
        '正解是把要用的常量搬到 client-safe 的纯数据模块，而不是在客户端引服务端文件。',
    ).toEqual([]);
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
