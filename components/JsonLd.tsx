// 往页面里塞一段 JSON-LD 结构化数据（2026-09-17）。
//
// ⚠️ **零可见输出**：`<script type="application/ld+json">` 不渲染任何东西，
//    不占位、不影响布局。这是「不增加可见内容」前提下唯一能给引擎补语义的通道。
//
// ⚠️⚠️ **转义不是可选的**。这段数据里含**外部平台来的热榜标题**——
//    如果某条标题里出现 `</script>`，浏览器会在那里结束脚本块，后面的内容当作 HTML 解析，
//    这就是一个现成的 XSS。JSON.stringify **不会**转义 `<`，所以必须自己来。
//    同理转掉 U+2028/U+2029：它们在 JSON 里合法，在 JavaScript 源码里却是换行符。
//    （根布局那段 JSON-LD 是纯静态文案，没有这个风险；这个组件专门为「含动态数据」而写。）
function safeJson(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function JsonLd({ data }: { data: unknown }) {
  // null / undefined 一律不输出。空的结构化数据比没有更糟：
  // 等于对引擎宣称「这一页有个清单」，而清单是空的。
  if (!data) return null;
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: safeJson(data) }}
    />
  );
}
