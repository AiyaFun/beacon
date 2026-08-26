import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SW = fs.readFileSync(path.join(ROOT, 'extension/sw.js'), 'utf8');

// 「可选链拦不住未声明的标识符」这一类崩溃的回归守卫。
//
// 【真实事故形状】消息监听器的形参写作 `_sender`（下划线=本来不打算用），
// 而分支里写成 `sender?.tab?.id`——`sender` 从未声明，`?.` 只兜 null/undefined，
// 兜不住 ReferenceError，整个消息处理当场抛。当时唯一的调用方总带 msg.tabId 短路了它，
// 于是这段死代码在插件里躺了很久没炸；调用方哪天不带就是一次崩溃。
//
// 这条守的是「形参叫 _sender 时，正文里不许出现裸 sender 取值」。
// 注释里的 `sender` 不算（那是在讲这条规矩本身），所以先剥注释再看。
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('sw.js 不许引用未声明的 sender', () => {
  it('监听器形参是 _sender 时，正文里不许出现裸 sender 取值', () => {
    const code = stripComments(SW);

    const listener = /chrome\.runtime\.onMessage\.addListener\(\s*\((\w+),\s*(\w+),/.exec(code);
    expect(listener, '没找到消息监听器——sw.js 结构变了，这条守卫要跟着改').toBeTruthy();

    const senderParam = listener![2];
    if (!senderParam.startsWith('_')) return; // 形参就叫 sender，那用它是对的

    // 监听器正文从 addListener 起到文件末尾（它是 sw.js 最后一个顶层块）
    const body = code.slice(listener!.index);
    const bare = [...body.matchAll(/(^|[^\w.$])sender\s*[?.[]/g)];
    expect(
      bare.length,
      `监听器形参是 ${senderParam}，但正文里有 ${bare.length} 处裸 sender 取值——` +
        '未声明的标识符会抛 ReferenceError，可选链兜不住',
    ).toBe(0);
  });

  it('把坏写法喂回来，这条守卫会红（不许假绿）', () => {
    const broken = 'chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {\n  const t = sender?.tab?.id;\n});';
    const body = stripComments(broken);
    expect([...body.matchAll(/(^|[^\w.$])sender\s*[?.[]/g)].length).toBeGreaterThan(0);
  });
});
