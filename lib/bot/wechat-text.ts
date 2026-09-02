// 微信侧文本分段（2026-09-02）。
//
// 微信客服文本上限 2048 字节（中文 3 字节/字 ≈ 680 字），协议网关那边对超长消息也不稳。
// 此前两条通道都是 `text.slice(0, 600)` —— 「截断不打回」是对的，但对一条**对话回复**来说，
// 截断等于把答案的后半截扔了，用户看到的是一句戛然而止的话，还以为机器人抽风。
// 拆成几条按序发，才是聊天工具里的正常形态。
//
// 拆分优先级：段落边界（\n\n）→ 换行 → 句末标点 → 硬切。每段 ≤ WECHAT_TEXT_MAX 字。
// 上限按**字符**算而不是字节：混排时字节数不直观，600 字在最坏情况（全中文）也 ≈ 1800 字节，留有余量。

export const WECHAT_TEXT_MAX = 600;
/** 一条回复最多拆几段——再多就是刷屏，后面的直接丢弃（并在末段标注） */
export const WECHAT_TEXT_MAX_PARTS = 5;

export function splitWechatText(text: string, max = WECHAT_TEXT_MAX): string[] {
  const t = (text ?? '').trim();
  if (!t) return [];
  if (t.length <= max) return [t];

  const parts: string[] = [];
  let rest = t;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    // 从后往前找一个最像「自然停顿」的位置；找不到就硬切
    let cut = -1;
    for (const re of [/\n\n(?![\s\S]*\n\n)/, /\n(?![\s\S]*\n)/, /[。！？；!?;](?![\s\S]*[。！？；!?;])/]) {
      const m = re.exec(window);
      if (m && m.index > max * 0.3) { cut = m.index + m[0].length; break; }
    }
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
    if (parts.length >= WECHAT_TEXT_MAX_PARTS - 1) break;
  }
  if (rest) {
    parts.push(rest.length > max ? `${rest.slice(0, max - 12).trim()}…（后文略）` : rest);
  }
  return parts.filter(Boolean);
}
