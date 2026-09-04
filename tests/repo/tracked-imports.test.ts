import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// 已提交的文件 import 的 `@/…` 目标，必须也已提交（2026-09-04）。
//
// 真踩：i18n 那批把 `app/(app)/skills/SkillCenter.tsx` 改成 import '@/lib/skills/i18n'，
// 但 lib/skills/i18n.ts 忘了 git add。本地 tsc / 5887 条单测全绿——文件明明在工作区里。
// 而部署只发 HEAD（git archive），到了生产 `next build` 才报 Module not found。
// 多会话共用一个工作区、各自只暂存自己的文件时，这类「提交漏文件」几乎必然发生，
// 所以变成机器判据：扫每个已跟踪的 ts/tsx，`@/x` 解析到的文件必须在 `git ls-files` 里。

const ROOT = path.resolve(__dirname, '..', '..');

function tracked(): Set<string> | null {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
    return new Set(out.split('\0').filter(Boolean));
  } catch {
    return null; // 不在 git 仓库里（比如整机包解压后跑测试）——没有判据可用，跳过
  }
}

const EXT = ['.ts', '.tsx', '/index.ts', '/index.tsx', '.js', '.json'];

describe('🔒 已提交文件 import 的 @/ 目标也要已提交', () => {
  it('每个 @/ import 都能在 git ls-files 里找到', () => {
    const files = tracked();
    if (!files) return;
    const bad: string[] = [];
    for (const f of files) {
      if (!/\.(ts|tsx)$/.test(f) || f.startsWith('public/downloads/')) continue;
      const src = readFileSync(path.join(ROOT, f), 'utf8');
      for (const m of src.matchAll(/from\s+['"]@\/([^'"]+)['"]/g)) {
        const target = m[1];
        // 已跟踪，或在工作区也不存在（那是 tsc 的事，不归这条管）
        const hit = EXT.some((e) => files.has(target + e)) || files.has(target);
        if (hit) continue;
        const onDisk = EXT.some((e) => existsSync(path.join(ROOT, target + e)));
        if (onDisk) bad.push(`${f} → @/${target}（文件在工作区里，但没 git add）`);
      }
    }
    expect(bad, '这些 import 的目标没进 git：本地全绿，发到生产 next build 才炸。git add 它们。\n').toEqual([]);
  });
});
