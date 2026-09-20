// 记忆行标注的清洗——**纯函数、零依赖**，故意单独成文件（与 lib/version.ts 同理由）。
//
// 它要被两类地方用：选题理由（server action）与起稿成稿清洗（lib/studio/platform-format）。
// 后者迟早会被某个客户端组件引到，而 lib/memory/core.ts 顶上是 import prisma——
// 那一刻整个 Prisma 会被打进浏览器包。所以把这段纯逻辑单独放这里，两边都能安全地用。
//
// 把模型抄进正文的记忆行标注洗掉。
//
// 背景：memoryLine 给每条注入的记忆加了 `[类型名 · 时间 · 已重复验证N次]` 前缀，那是给模型看的
// 元信息。prompt 里明确说过它不是正文、别念类型名、别原样抄——三轮加码都没治住：
// 真机 2026-07-30（MiniMax-Text-01）最后一轮 6 条推荐理由里 5 条带着「[人设记忆 · 今天]」出街，
// 加了「不许把方括号那段标注原样抄进回答」之后反而从 1 条涨到 5 条（越强调越显著）。
//
// 结论：这类「模型必须记得不做某事」的约束，靠 prompt 是概率性的，靠代码才是确定的。
// prompt 里的那几条留着（能降低发生率、也解释了意图），但**最终保证**由这个函数给。
// 只删标注本身，不动它后面的句子——那句话通常是有效引用，删了会把好内容一起删掉。
export const MEMORY_TAG_RE = /\[[^\]\n]{0,12}记忆\s*·[^\]\n]{0,40}\]\s*/g;
// 删完之后的接缝：模型常写「根据[人设记忆 · 今天]的记录…」，删掉标注就剩「根据的记录」。
// 只在**确实删过标注**时才做这一步——「我根据的是数据」这种正常句子不能被误改。
const DANGLING_DE_RE = /(根据|依据|基于)的/g;

export function stripMemoryTags(text: string): string {
  if (!text) return text;
  const stripped = text.replace(MEMORY_TAG_RE, '');
  if (stripped === text) return text; // 没有标注，原样返回，绝不碰正常文本
  // ⚠️ 只合并**空格与制表符**，不动换行：这个函数现在也用在起稿成稿上，
  // 原来的 /\s{2,}/ 会把整篇稿子的空行吃掉、压成一大段（真机 2026-09-17 验到）。
  return stripped.replace(DANGLING_DE_RE, '$1').replace(/[ \t]{2,}/g, ' ').trim();
}