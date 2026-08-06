// AIGC 标识（《人工智能生成合成内容标识办法》2025-09-01 施行 + 强制性国标 GB 45438-2025）
//
// 本模块刻意不依赖 prisma / server-only：复制到剪贴板也是《办法》第四条明列的「出口」，
// 客户端组件（components/CopyText.tsx）必须能直接引用。engine.ts 原样 re-export 保持旧引用可用。
//
// 法条要点：
// - 第四条(一)：文本类在「起始、末尾或者中间适当位置」添加文字提示或通用符号提示。
// - 第四条末款：提供下载、复制、导出功能时，应当确保**文件中**含有满足要求的显式标识。
// - 第五条：在文件元数据中添加隐式标识（生成合成属性 + 服务提供者名称/编码 + 内容编号）。
// - GB 45438-2025：文本显式标识须同时含「人工智能 / AI」与「生成 / 合成」两类关键词。

// 显式标识文案：含「人工智能」+「生成」，满足 GB 45438-2025 的关键词要求。
export const AIGC_LABEL = '本内容由人工智能生成';

// 判定方向决定一切，两个方向的代价极不对称：
// - 误判(false positive)：正文里提一句「AI 生成」被当成已标识 → 真标识不再追加 → **违反第四条**。致命。
// - 漏判(false negative)：真标识没认出来 → 多补一条标识 → 重复、难看，但**合规底线守住**。
// 故本模块一律往「不算标识」方向兜底：宁可多一条标识，也不能少。

// 标识行的整行匹配：必须**整行即一句「XX 由 AI 生成」的声明**，行尾不得再续正文。
//
// (由|系|为|经) 是**必填**的（历史实现里它是可选的）：光杆的「AI 生成」「人工智能生成」是名词短语，
// 在 Markdown 里极可能是标题或列表项（`## AI 生成` / `- AI 生成`——一篇讲 AI 绘图的文章就长这样），
// 不是对本文的声明。少了这个字，「一篇讨论 AI 生成的文章」会把自己判成已标识，然后拿到一份无标识的导出件。
const AIGC_LABEL_LINE =
  /^(本|该|此)?\s*(内容|文本|文章|文案|图片|视频|音频)?\s*(由|系|为|经)\s*(人工智能|AI)\s*(技术)?\s*(辅助)?\s*(生成|合成|生成合成)\s*(内容)?$/i;

// 行首装饰符：破折号、书名号/括号、项目符号等**纯排版修饰**。
// 刻意**不含** `#` 与 ASCII `-`/`+`：它们是 Markdown 的**块级结构符**（标题、列表项），不是装饰。
// 把 `## AI 生成` 剥成 `AI 生成` 就是上一轮那个误判的来源——结构符承载语义，剥掉等于改写了正文。
// 注意 `—`(U+2014)/`–`(U+2013) 与 ASCII `-` 是不同字符：ensureAigcLabel 追加的「——」仍会被正确剥离。
const DECOR_HEAD = /^[\s>·•·【\[（(「『—–]+/;
// `*`/`_` 两义：`*强调*` 是装饰，`* 列表项` 是块级结构。Markdown 的区分点就是**后面跟不跟空白**
// （列表符必须跟空白，强调符必须紧贴文字），照此区分即可，不必猜。
const EMPH_HEAD = /^[*_]+(?=\S)/;
const DECOR_TAIL = /[\s\-—–_*】\]）)」』。.!！]+$/;

// 逐层剥离行首装饰：`> **本内容由AI生成**` 这类嵌套要能剥干净。
function stripDecor(raw: string): string {
  let s = raw.trim();
  for (let i = 0; i < 4; i++) {
    const next = s.replace(DECOR_HEAD, '').replace(EMPH_HEAD, '');
    if (next === s) break;
    s = next;
  }
  return s.replace(DECOR_TAIL, '').trim();
}

export function hasAigcLabel(text: string): boolean {
  return text.split('\n').some((raw) => {
    const line = stripDecor(raw);
    return line.length > 0 && AIGC_LABEL_LINE.test(line);
  });
}

// 出口前确保带 AIGC 显式标识；缺失则追加到文末（第四条允许「起始、末尾或中间」）
export function ensureAigcLabel(text: string): string {
  if (hasAigcLabel(text)) return text;
  return `${text.trimEnd()}\n\n——${AIGC_LABEL}`;
}

// ── 隐式标识（第五条 / GB 45438-2025 文件元数据）──

// 服务提供者名称或编码：生产态配置备案主体名，不配则回退到产品名（dev 态零配置可跑）。
// 本模块在服务端（导出）和客户端（复制）都会跑，而 Next 只把 NEXT_PUBLIC_* 注入客户端包，
// 故两个都读：复制出口要生效必须配 NEXT_PUBLIC_AIGC_PRODUCER。
function producer(): string {
  return process.env.NEXT_PUBLIC_AIGC_PRODUCER || process.env.BEACON_AIGC_PRODUCER || '烽火台';
}

export type AigcMetadata = {
  AIGC: {
    Label: string; // "1" = 生成合成内容
    ContentProducer: string; // 服务提供者名称或编码
    ProduceID: string; // 该服务提供者范围内的内容唯一编号
    ReservedCode1?: string;
    ReservedCode2?: string;
  };
};

// 构造 GB 45438-2025 规定的隐式标识元数据载荷。
// 注意：本函数只产出**载荷**。真正写入文件元数据需要按格式改写文件头
// （OOXML 改 docProps/core.xml、PDF 改 Info/XMP），见 docs/合规词库运营.md 的缺口章节。
export function buildAigcMetadata(produceId: string): AigcMetadata {
  return { AIGC: { Label: '1', ContentProducer: producer(), ProduceID: produceId } };
}

export function aigcMetadataJson(produceId: string): string {
  return JSON.stringify(buildAigcMetadata(produceId));
}

// 复制/导出出口的 text/html 脚手架（唯一一份）：注释隐式标识 + <meta> + 包裹显式标识的容器。
// 剪贴板 text/html flavor、技能富文本复制都复用它，避免各处手搓两份脚手架、漏挂元数据。
// bodyHtml 视为**已经安全**的 HTML——调用方负责转义纯文本或做白名单消毒后再传进来，此处不再转义。
export function wrapAigcHtml(bodyHtml: string, produceId?: string): string {
  const json = aigcMetadataJson(produceId ?? crypto.randomUUID());
  return [
    `<!--${json}-->`,
    `<meta name="aigc-metadata" content="${json.replace(/"/g, '&quot;')}">`,
    `<div data-aigc-label="1">${bodyHtml}</div>`,
  ].join('');
}

// 复制出口的隐式标识：把**纯文本**转义 + 换行转 <br> 后交给 wrapAigcHtml 包裹。
// 粘贴进 Word / WPS / 公众号编辑器时随 HTML 一起带走，是复制路径上可实际落地的隐式标识。
export function aigcHtmlPayload(text: string, produceId: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return wrapAigcHtml(escaped.replace(/\n/g, '<br>'), produceId);
}
