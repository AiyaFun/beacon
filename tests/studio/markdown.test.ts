import { describe, it, expect } from 'vitest';
import { supportsMarkdown, hasMarkdownMarkers, mdLiteToHtml, mdLiteToPlain } from '@/lib/studio/markdown';

describe('轻结构 markdown · 平台开关', () => {
  it('只有文章型平台开（当前是公众号）', () => {
    expect(supportsMarkdown('wechat')).toBe(true);
    for (const p of ['douyin', 'xiaohongshu', 'shipinhao', 'bilibili', 'x', 'youtube']) {
      expect(supportsMarkdown(p), p).toBe(false);
    }
  });

  it('平台缺失时不开——宁可不给记号，也不能让 ** 原样发到抖音口播稿里', () => {
    expect(supportsMarkdown(undefined)).toBe(false);
    expect(supportsMarkdown('')).toBe(false);
  });
});

describe('轻结构 markdown · 记号识别', () => {
  it('认出五种记号', () => {
    expect(hasMarkdownMarkers('## 小标题')).toBe(true);
    expect(hasMarkdownMarkers('这里有**重点**要说')).toBe(true);
    expect(hasMarkdownMarkers('- 第一条')).toBe(true);
    expect(hasMarkdownMarkers('1. 第一条')).toBe(true);
    expect(hasMarkdownMarkers('> 引用一句')).toBe(true);
  });

  it('普通正文不误报', () => {
    expect(hasMarkdownMarkers('今天聊聊副业这件事。3个坑，一个一个说。')).toBe(false);
    // 单个星号、破折号开头的口语不是记号
    expect(hasMarkdownMarkers('他说*大概*吧')).toBe(false);
    expect(hasMarkdownMarkers('—— 这是破折号')).toBe(false);
  });
});

describe('轻结构 markdown · 渲染', () => {
  it('小标题 / 加粗 / 列表 / 引用 / 段落各自渲染', () => {
    const html = mdLiteToHtml('## 第一节\n正文一句**重点**。\n- 甲\n- 乙\n> 引用\n\n第二段');
    expect(html).toContain('<h2>第一节</h2>');
    expect(html).toContain('<strong>重点</strong>');
    expect(html).toContain('<ul><li>甲</li><li>乙</li></ul>');
    expect(html).toContain('<blockquote>引用</blockquote>');
    expect(html).toContain('<p>第二段</p>');
  });

  it('有序列表用 ol，且 1. 与 1) 都认', () => {
    expect(mdLiteToHtml('1. 甲\n2) 乙')).toBe('<ol><li>甲</li><li>乙</li></ol>');
  });

  it('列表被普通段落打断后会正确闭合，不会把后面的段落吞进 li', () => {
    const html = mdLiteToHtml('- 甲\n结束语');
    expect(html).toBe('<ul><li>甲</li></ul><p>结束语</p>');
  });

  // 这是整个渲染器唯一的安全边界：先转义、再套标签。倒过来就是存储型 XSS。
  it('正文里的 HTML 一律当字面量转义，不产生可执行标签', () => {
    const html = mdLiteToHtml('## <script>alert(1)</script>\n<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('加粗记号里夹 HTML 也进不去（转义发生在套标签之前）', () => {
    const html = mdLiteToHtml('**<b>x</b>**');
    expect(html).toBe('<p><strong>&lt;b&gt;x&lt;/b&gt;</strong></p>');
  });

  it('& 单独出现也转义，不会产出半截实体', () => {
    expect(mdLiteToHtml('A & B')).toBe('<p>A &amp; B</p>');
  });

  it('空正文渲染成空串，不产出空标签', () => {
    expect(mdLiteToHtml('')).toBe('');
    expect(mdLiteToHtml('\n\n  \n')).toBe('');
  });
});

describe('轻结构 markdown · 转纯文本', () => {
  it('剥掉记号但不重排，字还是那些字', () => {
    expect(mdLiteToPlain('## 标题\n正文**重点**\n- 甲\n1. 乙\n> 引')).toBe('标题\n正文重点\n· 甲\n1. 乙\n引');
  });
});
