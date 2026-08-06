import { AIGC_LABEL, ensureAigcLabel, hasAigcLabel, wrapAigcHtml } from '@/lib/compliance/aigc';

// 富文本复制的唯一出口（浏览器端）。
//
// 每个「复制成品」按钮都要做同样四件事：补显式 AIGC 标识、包隐式标识元数据、
// 同时写 text/plain 与 text/html 两个 flavor、在旧浏览器上退回纯文本。
// 抄第二遍就一定会漏掉其中一件——而漏掉的通常是标识（《标识办法》第四、五条）。
//
// ⚠️ bodyHtml 必须是**调用方已经保证安全**的 HTML：
//   - 技能产出（LLM 生成，不可信）→ 调用前先过 SkillPanel 的 DOMParser 白名单消毒；
//   - markdown-lite 渲染（先转义再套标签）→ 由构造保证安全。
// 本函数不做消毒，它只负责标识与剪贴板。

export async function copyRichText(bodyHtml: string, plainText: string): Promise<void> {
  const plain = ensureAigcLabel(plainText);
  // 可见的显式标识：AIGC_LABEL 是本地常量文案，直接拼进已经安全的 HTML
  const withLabel = hasAigcLabel(plainText) ? bodyHtml : `${bodyHtml}<p>——${AIGC_LABEL}</p>`;

  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      const payload = wrapAigcHtml(withLabel, crypto.randomUUID());
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([plain], { type: 'text/plain' }),
          'text/html': new Blob([payload], { type: 'text/html' }),
        }),
      ]);
      return;
    }
  } catch {
    // 富文本写入失败（权限、浏览器差异）不该让用户什么都拿不到——落到纯文本
  }
  await navigator.clipboard.writeText(plain).catch(() => {});
}

/** HTML → 纯文本，供 text/plain flavor 用。粗粒度即可：它只是「粘到不认富文本的地方」的兜底。 */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<(?:br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/blockquote)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}
