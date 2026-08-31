import { describe, it, expect } from 'vitest';
import { applyLinePrefix, wrapSelection } from '@/app/(app)/studio/md-lite-edit';
import { mdLiteToHtml } from '@/lib/studio/markdown';

// 编辑器工具条的选区计算（2026-08-30）。
//
// ── 为什么现在才有 ──
// 抽出来之前这两个函数是 Rewriter() 里的闭包（那个函数 802 行），直接读写 textarea。
// **闭包里的偏移计算测不了**，而偏移算错不报错，只表现为「光标莫名其妙跑了」——
// 用户会以为是自己手滑，不会来报。

describe('加行前缀', () => {
  it('光标所在行加上前缀', () => {
    const r = applyLinePrefix('甲\n乙', 0, 0, '- ');
    expect(r.value).toBe('- 甲\n乙');
    expect([r.selStart, r.selEnd]).toEqual([2, 2]);
  });

  it('跨行选中时每一行都加', () => {
    const r = applyLinePrefix('甲\n乙', 0, 3, '- ');
    expect(r.value).toBe('- 甲\n- 乙');
    expect(r.selEnd).toBe(7); // 两行各加两个字符
  });

  // ── 这条是修复的理由 ──
  // 原来收尾写的是 setSelectionRange(s + prefix.length, e + delta)：
  // 起点**无条件**加 prefix.length，可是首行本来就有前缀时它压根没动。
  // `- 甲\n乙` 光标在位置 2 再按一次 → (2+2, 2+0) = (4, 2)，起点大于终点，
  // 浏览器塌成 4 —— 光标从「甲」上跳到换行符之后，也就是跑到下一行去了。
  it('🔒 已经有前缀的行再按一次，光标不许动', () => {
    const r = applyLinePrefix('- 甲\n乙', 2, 2, '- ');
    expect(r.value, '这一行不该被改动').toBe('- 甲\n乙');
    expect([r.selStart, r.selEnd], '光标跳走了（原来会跳到下一行）').toEqual([2, 2]);
  });

  it('🔒 起点永远不大于终点（塌陷正是光标乱跑的直接原因）', () => {
    for (const [t, s, e] of [['- 甲\n乙', 2, 2], ['- 甲', 0, 3], ['甲', 0, 0], ['- 甲\n- 乙', 1, 5]] as const) {
      const r = applyLinePrefix(t, s, e, '- ');
      expect(r.selStart, `${JSON.stringify(t)} @${s},${e}`).toBeLessThanOrEqual(r.selEnd);
    }
  });

  it('混着来：有前缀的不动，没前缀的加', () => {
    const r = applyLinePrefix('- 甲\n乙', 0, 4, '- ');
    expect(r.value).toBe('- 甲\n- 乙');
  });

  it('🔒 正文以换行开头、光标在最前面时不差一格', () => {
    // lastIndexOf 的 fromIndex 传负数会被当成 0：光标在 0 时 s-1 = -1，
    // 于是「正文第一个字符就是换行」会让行首被算成 1，前缀加到了第二行上。
    const r = applyLinePrefix('\n乙', 0, 0, '- ');
    expect(r.value, '前缀加错行了').toBe('- \n乙');
  });

  it('最后一行（后面没有换行符）也能加', () => {
    const r = applyLinePrefix('甲\n乙', 2, 2, '- ');
    expect(r.value).toBe('甲\n- 乙');
  });
});

describe('包住选区', () => {
  it('选中的部分被记号包起来，且仍然选中原来那段', () => {
    const r = wrapSelection('今天很好', 0, 2, '**');
    expect(r.value).toBe('**今天**很好');
    expect(r.value.slice(r.selStart, r.selEnd)).toBe('今天');
  });

  it('没选中时插入一对记号，光标停在中间', () => {
    const r = wrapSelection('今天', 2, 2, '**');
    expect(r.value).toBe('今天****');
    expect([r.selStart, r.selEnd]).toEqual([4, 4]);
  });

  it('🔒 选中内容原样保留（记号不许吃掉字）', () => {
    const r = wrapSelection('abc', 1, 2, '_');
    expect(r.value).toBe('a_b_c');
    expect(r.value.slice(r.selStart, r.selEnd)).toBe('b');
  });
});

// ── 块级标记一行只能有一个（2026-08-30 修）────────────────────────────────────
//
// 原来只判「有没有一模一样的前缀」（`l.startsWith(prefix)`）。于是在 AI 稿里
// 极常见的这几行上，标记会被叠加，然后**当成正文显示出来**：
//   `### 三级标题` 点「小标题」→ `## ### 三级标题` → <h2>### 三级标题</h2>
//   `1. 文字`      点「列表」  → `- 1. 文字`      → <li>1. 文字</li>
//
// 【为什么断言拿渲染结果而不是拼出来的字符串】这条守卫真正要守的是
// 「用户在预览里看到的字是干净的」。只比字符串的话，哪天 mdLiteToHtml 认得的标记
// 变了（比如支持了 `+ ` 当无序列表），这里仍然是绿的，而预览已经坏了。
describe('换块级标记：一行只能有一个', () => {
  const textOf = (html: string) => html.replace(/<[^>]+>/g, '');

  it.each([
    ['### 三级标题', '## ', '三级标题', '小标题按到三级标题上'],
    ['## 二级标题', '### ', '二级标题', '反过来也一样'],
    ['* 文字', '- ', '文字', '星号列表换成短横列表'],
    ['1. 文字', '- ', '文字', '有序换无序'],
    ['1) 文字', '- ', '文字', '右括号那种有序也认'],
    ['> 引用', '- ', '引用', '引用换成列表'],
    ['- 文字', '> ', '文字', '列表换成引用'],
    ['## 标题', '- ', '标题', '标题换成列表'],
  ])('%s + 「%s」→ 预览里只剩「%s」（%s）', (line, prefix, want) => {
    const r = applyLinePrefix(line, 0, 0, prefix);
    expect(textOf(mdLiteToHtml(r.value)), `渲染出来是 ${r.value}`).toBe(want);
  });

  it('🔒 换标记时起点可能往前挪，不许挪到上一行去', () => {
    // `### 标题` → `## 标题` 少一个字符，headDelta = -1。
    //
    // 【光标必须正好在行首才分得出来】第一版把光标放在 `### ` 的空格上（s=7），
    // 那时 s + headDelta = 6 本来就大于行首 4，夹不夹一模一样——**样本不到门槛**，
    // 变异验证当场抓到（本会话第三次同一形状）。
    // 只有光标停在行首时，s + headDelta 才会落到上一行的换行符上。
    const t = '前一行\n### 标题';
    const lineStart = t.indexOf('###'); // = 4
    const r = applyLinePrefix(t, lineStart, lineStart, '## ');
    expect(r.selStart, '起点被推到上一行去了').toBeGreaterThanOrEqual(lineStart);
    expect(r.selStart).toBeLessThanOrEqual(r.selEnd);
  });

  it('已经是这个标记的，再按一次原样不动（幂等）', () => {
    for (const [line, p] of [['## 标题', '## '], ['- 文字', '- '], ['> 引用', '> ']] as const) {
      expect(applyLinePrefix(line, 0, 0, p).value, `${line} + ${p}`).toBe(line);
    }
  });

  it('跨行选中时中间的空行不加标记（那是段落分隔）', () => {
    const r = applyLinePrefix('甲\n\n乙', 0, 4, '- ');
    expect(r.value).toBe('- 甲\n\n- 乙');
  });

  it('🔒 但光标单独停在空行上要能起一个空列表项', () => {
    // 所有编辑器都这样：点「列表」→ 出现一个空的项，接着打字。
    expect(applyLinePrefix('', 0, 0, '- ').value).toBe('- ');
    expect(applyLinePrefix('甲\n\n乙', 2, 2, '- ').value).toBe('甲\n- \n乙');
  });
});
