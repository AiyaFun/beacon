import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseChangelog, notesForVersion, stripInlineMarkdown } from '@/lib/appliance/changelog';
import { APP_VERSION } from '@/lib/market/version';
import { APPLIANCE_EXCLUDE } from '@/lib/appliance/package-exclude';

// 整机版更新清单的「更新说明」来自 CHANGELOG.md（2026-09-02 起）。
// 此前 notes 只有一句自动生成的 SQL 计数，客户看到的是一个版本号什么都不说。

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('CHANGELOG 解析', () => {
  const md = `# 更新日志

## 1.2.0 (2026-01-02)
- 第一条 **加粗** 与 \`代码\`
- [链接文字](https://x) 第二条

### 展开说明
这段不是条目。
- 但三级标题下的条目仍算 1.2.0 的

## v1.1.0
* 星号也认
`;

  it('按二级标题切版本，列表项进条目，段落与三级标题不进', () => {
    const s = parseChangelog(md);
    expect([...s.keys()]).toEqual(['1.2.0', '1.1.0']);
    expect(s.get('1.2.0')).toEqual(['第一条 加粗 与 代码', '链接文字 第二条', '但三级标题下的条目仍算 1.2.0 的']);
    expect(s.get('1.1.0')).toEqual(['星号也认']);
  });

  it('没有这一版 → null，与「有段落但空」区分开', () => {
    expect(notesForVersion(md, '9.9.9')).toBeNull();
    expect(notesForVersion('## 3.0.0\n\n## 2.0.0\n- x', '3.0.0')).toEqual([]);
  });

  it('剥 markdown 只剥标记不剥文字', () => {
    expect(stripInlineMarkdown('**a** `b` [c](d)')).toBe('a b c');
  });
});

describe('🔒 当前版本必须有更新说明', () => {
  it(`CHANGELOG.md 里有 ${APP_VERSION} 的段落且至少一条条目`, () => {
    const notes = notesForVersion(read('CHANGELOG.md'), APP_VERSION);
    expect(notes, `CHANGELOG.md 缺 ## ${APP_VERSION}`).not.toBeNull();
    expect(notes!.length).toBeGreaterThan(0);
    // 条目是发给客户看的，别把内部路径当说明
    for (const n of notes!) expect(n, n).not.toMatch(/^(lib|app|scripts|tests)\//);
  });

  it('打包脚本真的读了它（写了没接的守卫）', () => {
    const src = read('scripts/pack-appliance.ts');
    expect(src).toContain("from '../lib/appliance/changelog'");
    expect(src).toMatch(/notesForVersion\(changelog, version\)/);
    // 没说明就中止，而不是静默退回空数组
    expect(src).toMatch(/process\.exit\(1\)/);
  });

  it('CHANGELOG 不被 GitHub 发布脚本或更新包剥掉', () => {
    expect(read('scripts/publish-github.sh')).not.toMatch(/CHANGELOG/);
    expect(APPLIANCE_EXCLUDE.some((p) => /CHANGELOG/i.test(p))).toBe(false);
  });
});
