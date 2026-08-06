import { describe, it, expect } from 'vitest';
import { extractArticle, decodeEntities } from '@/lib/clip/extract';

// HTML → 正文。摘要与要点的质量全押在这一步：
// 把导航栏、推荐位、版权声明当成正文喂给模型，它就会一本正经地总结「关注我们」。

const WECHAT = `
<html><head>
  <meta property="og:title" content="我们把内容中台重做了一遍">
  <meta property="article:published_time" content="2026-07-20T10:00:00+08:00">
</head><body>
  <nav>首页 关于 联系我们</nav>
  <h1 id="activity-name">我们把内容中台重做了一遍</h1>
  <a id="js_name">大脑壳网络</a>
  <div id="js_content">
    <p>第一段：我们发现旧系统的瓶颈在采集口径不统一。</p>
    <p>第二段：重做后单账号日处理量从 3 万涨到 12 万。</p>
    <p>第三段：踩过的最大的坑是时区。</p>
  </div>
  <div id="js_pc_qr_code">扫码关注我们</div>
  <footer>版权所有 © 2026</footer>
</body></html>`;

describe('extractArticle · 公众号', () => {
  const a = extractArticle(WECHAT);

  it('标题优先取 og:title', () => {
    expect(a.title).toBe('我们把内容中台重做了一遍');
  });

  it('作者取到公众号名，发布时间取到 meta', () => {
    expect(a.author).toBe('大脑壳网络');
    expect(a.publishedAt).toContain('2026-07-20');
  });

  it('🔒 正文只有 #js_content 里的三段 —— 导航/二维码/页脚都不算正文', () => {
    expect(a.text).toContain('采集口径不统一');
    expect(a.text).toContain('12 万');
    expect(a.text).not.toContain('扫码关注');
    expect(a.text).not.toContain('版权所有');
    expect(a.text).not.toContain('首页 关于');
  });

  it('段落结构保住了（要点提取靠它看层次）', () => {
    expect(a.text.split('\n').length).toBeGreaterThanOrEqual(3);
  });
});

describe('extractArticle · 通用页面', () => {
  it('<article> 语义容器优先于满页噪声', () => {
    const html = `<html><body>
      <nav>导航导航导航导航导航</nav>
      <article><p>${'这是真正的正文内容。'.repeat(20)}</p></article>
      <aside>相关阅读：另一篇文章</aside>
    </body></html>`;
    const a = extractArticle(html);
    expect(a.text).toContain('这是真正的正文内容');
    expect(a.text).not.toContain('相关阅读');
    expect(a.text).not.toContain('导航导航');
  });

  it('没有语义容器时取文本量最大的块', () => {
    const html = `<html><body>
      <div>短短的侧栏</div>
      <div>${'正文正文正文正文正文。'.repeat(30)}</div>
    </body></html>`;
    expect(extractArticle(html).text).toContain('正文正文');
  });

  it('script/style 的内容绝不进正文', () => {
    const html = `<html><body><article><script>var a=1;console.log("不该出现")</script>
      <style>.x{color:red}</style><p>${'真正的内容。'.repeat(30)}</p></article></body></html>`;
    const a = extractArticle(html);
    expect(a.text).not.toContain('console.log');
    expect(a.text).not.toContain('color:red');
    expect(a.text).toContain('真正的内容');
  });

  it('超长正文截断并明说截断了（不静默丢内容）', () => {
    const html = `<article><p>${'字'.repeat(5000)}</p></article>`;
    const a = extractArticle(html, { maxChars: 1000 });
    expect(a.text.length).toBeLessThan(1100);
    expect(a.text).toContain('已截断');
  });

  it('解析不出正文时返回空串，交给调用方明说（而不是把导航当文章存下来）', () => {
    expect(extractArticle('<html><body></body></html>').text).toBe('');
  });
});

describe('decodeEntities', () => {
  it('常见实体都还原', () => {
    expect(decodeEntities('a&nbsp;b&amp;c&lt;d&gt;e&quot;f')).toBe('a b&c<d>e"f');
    expect(decodeEntities('&#20320;&#x597d;')).toBe('你好');
  });

  it('🔒 &amp; 最后解码 —— 否则 &amp;lt; 会被二次解码成 <', () => {
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
  });
});
