import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 工具层的依赖方向守卫（2026-08-30）。
//
// ── 抽契约层之前长什么样 ──
//   tools.ts ──import──▶ tools-insight/content/produce/draft-plan
//        ▲                              │
//        └───────import type────────────┘
// 一个环。它一直没炸，**只因为回边全是 `import type`**——编译期擦掉了，
// 运行时那条边不存在。也就是说：这份代码的正确性靠的是「碰巧没人需要运行时的值」。
//
// ── 它已经在收费了 ──
// `str` / `num` / `clamp` 三个五行小函数，抽之前在这五个文件里**各抄了一份**。
// 不是懒：一旦写成 `import { clamp } from './tools'`，type-only 就变成真 import，
// 环就成了真环——模块初始化时拿到 undefined，而报错现场离病根十万八千里。
// 抄一份最省事。**五份重复的 clamp 就是那条环留下的齿痕。**
//
// 所以这道守卫盯的不是「有没有环」，而是「回边有没有从 type 退化成 value」——
// 前者今天已经没有了，后者才是明天会发生的事。

const ROOT = process.cwd();
const AGENT_DIR = join(ROOT, 'lib/agent');

/**
 * 剥掉注释再断言。
 *
 * 【为什么必须剥】这道守卫第一次跑就被**自己的注释**绊倒了：tool-types.ts 开头
 * 那段说明里写着 `import type { AgentTool } from './tools'`（在讲抽之前长什么样），
 * 于是「契约层不许引 tools」这条当场变红。
 * 同样，一条被注释掉的 re-export 也不该算「还在」。
 * 这是本项目反复踩的一种假红/假绿，既有守卫 tests/fake-green-guard.ts 同款处理。
 */
function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** lib/agent 下所有 tools-*.ts（新加一个会自动被盯上，不用改这张表）。 */
function siblingToolFiles(): string[] {
  return readdirSync(AGENT_DIR).filter((n) => /^tools-.*\.ts$/.test(n));
}

describe('工具层依赖方向：tools-*.ts 不许反过来引 tools.ts', () => {
  const files = siblingToolFiles();

  it('确实扫到了兄弟文件（守卫自己不能空转）', () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  it.each(files)('%s 从 tool-types 拿契约，不从 tools 拿', (name) => {
    const src = strip(readFileSync(join(AGENT_DIR, name), 'utf8'));
    expect(
      src,
      `${name} 引了 './tools'。tools.ts 反过来 import 这个文件，这就是一个环——`
      + '今天靠 `import type` 被擦掉所以不炸，明天有人需要一个运行时的值就会炸，'
      + '而且炸在模块初始化、报错现场离病根很远。契约请从 ./tool-types 拿。',
    ).not.toMatch(/from ['"]\.\/tools['"]/);
  });

  it('🔒 契约层自己不许引任何一个 tools 文件（它必须是叶子）', () => {
    const src = strip(readFileSync(join(AGENT_DIR, 'tool-types.ts'), 'utf8'));
    expect(src).not.toMatch(/from ['"]\.\/tools/);
  });

  it('🔒 str/num/clamp 只有一份定义（五份重复正是那条环的齿痕）', () => {
    let defs = 0;
    for (const name of [...files, 'tools.ts', 'tool-types.ts']) {
      const src = strip(readFileSync(join(AGENT_DIR, name), 'utf8'));
      defs += (src.match(/^export const clamp = |^const clamp = /gm) ?? []).length;
    }
    expect(defs, '又有人在 tools-*.ts 里自己抄了一份 clamp——请从 ./tool-types 引').toBe(1);
  });

  it('存量 import 点还能从 tools.ts 拿到契约（re-export 没被删）', () => {
    // 十来处 `from '@/lib/agent/tools'` 拿类型的地方靠这行活着
    const src = strip(readFileSync(join(AGENT_DIR, 'tools.ts'), 'utf8'));
    expect(src).toContain("export type { ToolContext, ToolResult, ArtifactKind, AgentTool } from './tool-types'");
    expect(src).toContain("export { DEFAULT_TOOL_TIMEOUT_MS, toolTimeoutMs } from './tool-types'");
  });
});
