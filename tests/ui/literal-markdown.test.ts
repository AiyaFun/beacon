import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// 【真机抓到的】写文案时顺手用了 Markdown 的 `**加粗**`，而 JSX 里的文本是**原样渲染**的——
// 用户看到的就是一串星号。这类瑕疵有两个特点：
//   · tsc、单测、build 全都发现不了（它是合法字符串）
//   · 写的人自己也看不见（在编辑器里那两个星号看起来就像加粗标记）
// 只有真的打开页面盯着那句话才会发现。所以钉一条守卫，让下一次在提交前就红。
//
// 真机那次是新写的派发卡，顺带扫出了一处存量（浏览器读网页的开关说明）。

const ROOT = path.resolve(__dirname, '../..');

/** 要扫的目录：会渲染给用户的组件与页面。 */
const DIRS = ['components', 'app'];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.next', 'coverage'].includes(e.name)) continue;
      walk(p, out);
    } else if (e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/** 剥注释：解释这条规矩的注释里本来就会写到星号。 */
function stripComments(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('渲染给用户的文本里不许有字面 Markdown', () => {
  it('JSX 文本节点里没有 **加粗** 这种写法（页面上会原样显示成星号）', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const d of DIRS) {
      for (const file of walk(path.join(ROOT, d))) {
        scanned++;
        const src = stripComments(fs.readFileSync(file, 'utf8'));
        // 只看标签之间的文本节点：>…**…**…<
        for (const m of src.matchAll(/>([^<>{}]*\*\*[^<>{}]*)</g)) {
          offenders.push(`${path.relative(ROOT, file)}: ${m[1].trim().slice(0, 50)}`);
        }
      }
    }
    expect(offenders, `这些地方的星号会原样显示给用户，改成 <strong>：\n${offenders.join('\n')}`).toEqual([]);
    // 目录改名 / walk 过滤写错，都会让上面那条永远是绿的
    expect(scanned, '一个文件都没扫到，遍历坏了').toBeGreaterThan(50);
  });

  it('这条守卫真的扫得到东西（正则坏了会静默全过）', () => {
    // 【防「守卫自己坏了却一直绿」】把一段带星号的假 JSX 喂给同一个正则，
    // 扫不出来就说明正则失效了，而那时上面那条会永远是绿的
    const fake = '<p>这句话**应该被抓到**才对</p>';
    expect([...stripComments(fake).matchAll(/>([^<>{}]*\*\*[^<>{}]*)</g)].length).toBe(1);
    // 注释里的星号不该被抓（否则解释这条规矩的注释自己会判红）
    const inComment = '{/* 这里写 **加粗** 是在讲规矩 */}<p>正常文本</p>';
    expect([...stripComments(inComment).matchAll(/>([^<>{}]*\*\*[^<>{}]*)</g)].length).toBe(0);
  });
});
