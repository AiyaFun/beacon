// 后端调用 Anthropic Agent Skills（如 pptx/docx/xlsx/pdf，或自建 skill）。
// 用于把创作工坊的成稿一键导出为演示文稿/文档等交付物。
//
// 与本项目的 OpenAI 兼容 LLM 网关不同：Agent Skills 只在 Anthropic 官方 Messages API 上可用，
// 必须使用 Anthropic 官方 API Key（x-api-key），且需要 code_execution 工具 + 两个 beta header。
//
// 参考：claude-api skill — Agent Skills (Messages API)。

import { deflateRawSync } from 'node:zlib';
import { AIGC_LABEL, ensureAigcLabel } from '../compliance/engine';
// zip / OOXML 原语与 AIGC 自定义属性已抽到 lib/deliverable/（本地 pptx 渲染器要用同一套，
// 见 lib/deliverable/zip.ts 文件头）。此处只 import，行为与抽取前完全一致。
import {
  readZipEntries,
  buildZip,
  appendZipEntry,
  patchContentTypes,
  escapeXml,
  unescapeXml,
} from '../deliverable/zip';
import { AIGC_PROPS_PART, AIGC_PROPS_CONTENT_TYPE, aigcCustomPropsXml } from '../deliverable/aigc-props';

const ANTHROPIC_BASE = 'https://api.anthropic.com';

// 已备案合规提示：Agent Skills 走 Anthropic 海外端点，生成内容仍需过本项目合规检测；
// 面向中国公众的正式发布内容默认不用此通道（PRD §10.5）。仅企业版 + 出海/内部工具场景启用。

export type SkillRef =
  | { type: 'anthropic'; skill_id: 'pptx' | 'docx' | 'xlsx' | 'pdf' | string; version?: string }
  | { type: 'custom'; skill_id: string; version?: string };

export type SkillFile = { fileId: string; filename?: string };

export type SkillResult = {
  text: string;
  files: SkillFile[];
  raw: unknown;
};

// 取 Anthropic 官方 key：优先环境变量，其次可由上层传入（BYOK 里 vendor=claude 的 provider）
function resolveAnthropicKey(explicit?: string): string {
  const key = explicit || process.env.BEACON_ANTHROPIC_API_KEY || '';
  if (!key) throw new Error('缺少 Anthropic 官方 API Key（设置 BEACON_ANTHROPIC_API_KEY 或在 BYOK 中配置 vendor=claude）');
  return key;
}

/**
 * 调用一个 Agent Skill 完成任务，返回文本 + 生成的文件 ID（如 .pptx/.docx）。
 * 路径 A：Messages API + container.skills + code_execution。
 */
export async function runAnthropicSkill(params: {
  skill: SkillRef;
  prompt: string;
  apiKey?: string;
  model?: string;
  maxTokens?: number;
}): Promise<SkillResult> {
  const apiKey = resolveAnthropicKey(params.apiKey);
  const body = {
    model: params.model ?? 'claude-opus-4-8',
    max_tokens: params.maxTokens ?? 16000,
    // 挂载 skill 到执行容器
    container: { skills: [{ ...params.skill, version: params.skill.version ?? 'latest' }] },
    // skill 通过代码执行工具运行
    tools: [{ type: 'code_execution_20260521', name: 'code_execution' }],
    messages: [{ role: 'user', content: params.prompt }],
  };

  const res = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // 三个 beta：代码执行 + skills + 文件 API（下载产物）
      'anthropic-beta': 'code-execution-2025-08-25,skills-2025-10-02,files-api-2025-04-14',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000), // skill 生成文件可能较慢
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Skill 调用失败 ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = (await res.json()) as { content?: unknown[] };
  return { text: extractText(data.content), files: extractFiles(data.content), raw: data };
}

// 从 content blocks 里抽取正文文本
function extractText(content: unknown[] | undefined): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: string; text: string } => isBlock(b) && b.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('\n');
}

// 从代码执行结果里抽取生成的文件（skill 产物）
function extractFiles(content: unknown[] | undefined): SkillFile[] {
  if (!Array.isArray(content)) return [];
  const files: SkillFile[] = [];
  for (const block of content) {
    if (!isBlock(block)) continue;
    // bash_code_execution_tool_result -> content -> bash_code_execution_output.file_id
    const inner = (block as { content?: { content?: unknown[] } }).content;
    const list = inner?.content;
    if (Array.isArray(list)) {
      for (const item of list) {
        if (isBlock(item) && (item as { type?: string }).type === 'bash_code_execution_output') {
          const fid = (item as { file_id?: string }).file_id;
          if (fid) files.push({ fileId: fid });
        }
      }
    }
  }
  return files;
}

function isBlock(b: unknown): b is Record<string, unknown> {
  return typeof b === 'object' && b !== null;
}

/** 下载 skill 生成的文件（返回二进制 Buffer），用于让用户导出下载。 */
export async function downloadSkillFile(fileId: string, apiKey?: string): Promise<{ data: Buffer; filename?: string }> {
  const key = resolveAnthropicKey(apiKey);
  const headers = {
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'files-api-2025-04-14',
  };
  // 先取元数据拿文件名
  let filename: string | undefined;
  try {
    const meta = await fetch(`${ANTHROPIC_BASE}/v1/files/${fileId}`, { headers, signal: AbortSignal.timeout(30_000) });
    if (meta.ok) filename = ((await meta.json()) as { filename?: string }).filename;
  } catch {
    /* 元数据失败不阻断下载 */
  }
  const res = await fetch(`${ANTHROPIC_BASE}/v1/files/${fileId}/content`, { headers, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`文件下载失败 ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  return { data, filename };
}

/** 便捷封装：把一篇文案导出为演示文稿 / 文档。 */
export async function exportDeliverable(opts: {
  format: 'pptx' | 'docx' | 'pdf' | 'xlsx';
  title: string;
  content: string;
  apiKey?: string;
}): Promise<SkillResult> {
  const instruction: Record<string, string> = {
    pptx: `把下面的内容做成一份结构清晰的演示文稿（标题：${opts.title}）。要点分页、有封面和小结。`,
    docx: `把下面的内容整理成一份排版规范的 Word 文档（标题：${opts.title}），含标题层级与要点列表。`,
    pdf: `把下面的内容排成一份可读性好的 PDF（标题：${opts.title}）。`,
    xlsx: `把下面的内容中的结构化信息整理成一张表格（标题：${opts.title}）。`,
  };
  // AIGC 合规：导出内容强制内置「本内容由人工智能生成」显式标识（2025-09 标识办法）。
  // 注意：这里只是**把标识送进 prompt**，标识有没有真的进最终文件由 verifyAigcLabelInFile 校验，
  // 不能只靠模型听话——见下方「校验回环」。
  const labeled = ensureAigcLabel(opts.content);
  return runAnthropicSkill({
    skill: { type: 'anthropic', skill_id: opts.format },
    prompt: `${instruction[opts.format]}\n\n要求：必须在结尾原样保留「${AIGC_LABEL}」这句声明，一字不改，且作为独立一行/独立文本框。\n\n---\n${labeled}`,
    apiKey: opts.apiKey,
  });
}

// ── 导出件的 AIGC 标识校验回环（《标识办法》第四条：导出须确保**文件中**含显式标识）──
//
// 为什么必须有：此前标识能否进最终文件全靠模型「听话」，零校验。模型漏掉 → 无标识文件照样交付 → 违法。
//
// 各格式的**可校验性**（实测结论，用例见 tests/compliance/export-label.test.ts）：
// - docx/pptx/xlsx（OOXML）：zip + deflate + XML，Node 内置 zlib 就能解，正文在 <w:t>/<a:t>/<t> 里
//   → **可靠可校验**，无需引入依赖。
// - pdf：正文被编码成**子集字体的字形 ID**（`<010001000107…> Tj`，实测如此），要还原成 Unicode 必须
//   解析字体的 ToUnicode CMap —— 那是 pdf-parse / pdf.js 级别的工作量。本项目不引这个依赖
//   → **无法可靠校验**，只能如实标注「未校验」，绝不冒充已校验。
//
// 关键：朴素的 `buffer.includes(AIGC_LABEL)` 对上述**任何**格式都不成立（实测 docx/pptx/pdf 全 false），
// 千万别退化成那种写法。

export type LabelCheck = {
  verifiable: boolean; // 本格式能否自动校验
  found: boolean; // verifiable 时才有意义
  reason: string; // 中文可读结论，直接给用户看
};

// 能自动校验标识的格式（OOXML 系）
const OOXML_FORMATS = new Set(['docx', 'pptx', 'xlsx']);

/** 校验导出件里是否真的含 AIGC 显式标识。 */
export function verifyAigcLabelInFile(format: string, data: Buffer): LabelCheck {
  if (!OOXML_FORMATS.has(format)) {
    return {
      verifiable: false,
      found: false,
      reason: `${format.toUpperCase()} 格式的正文以子集字体的字形编码存储，无法自动校验标识是否落入文件`,
    };
  }
  try {
    const text = extractOoxmlText(data);
    const found = normalizeForMatch(text).includes(normalizeForMatch(AIGC_LABEL));
    return {
      verifiable: true,
      found,
      reason: found ? '已校验：文件中含 AIGC 显式标识' : '文件中未检出 AIGC 显式标识',
    };
  } catch (e) {
    // 解不开就是解不开，不能默认放行——第四条是硬要求，未知一律当未通过
    return { verifiable: true, found: false, reason: `标识校验失败（文件解析异常：${(e as Error).message}）` };
  }
}

// 匹配前归一化：模型可能把标识拆进多个 run，或插入空格/换行/全角空格，去掉所有空白再比。
function normalizeForMatch(s: string): string {
  return s.replace(/[\s　]+/g, '');
}

// 抽取 OOXML 文件里的全部可见文本。
// 文本可能被拆成多个 run（`<w:t>本内容由</w:t><w:t>人工智能生成</w:t>`，实测模型/渲染器都会这么干），
// 故拼接后再匹配，而不是逐个 run 比。
function extractOoxmlText(zip: Buffer): string {
  let out = '';
  for (const { name, data } of readZipEntries(zip)) {
    // 只看承载正文的部件，跳过主题/字体/图片等噪音
    if (!/^(word|ppt|xl)\/.*\.xml$/.test(name)) continue;
    const xml = data.toString('utf8');
    // w:t = Word，a:t = PPT/DrawingML，t = Excel sharedStrings
    for (const m of xml.matchAll(/<(?:w:t|a:t|t)(?:\s[^>]*)?>([^<]*)<\/(?:w:t|a:t|t)>/g)) {
      out += unescapeXml(m[1]);
    }
  }
  return out;
}

// ── AIGC 隐式标识注入（《标识办法》第五条：文件元数据中添加隐式标识）──
//
// OOXML 的自定义属性住在 docProps/custom.xml 里。这里把 AIGC 元数据写进去，
// 让 Word/PPT 的「属性 → 自定义」里能看到生成合成属性、服务提供者、内容编号。
// 不引入任何第三方 zip 库——直接在 Buffer 层追加条目+重建中央目录。

export function injectAigcDocProps(zip: Buffer, produceId: string): Buffer {
  const entries = readZipEntries(zip);
  if (entries.some(e => e.name === AIGC_PROPS_PART)) return zip;

  const raw = Buffer.from(aigcCustomPropsXml(produceId), 'utf8');
  const compressed = deflateRawSync(raw);
  let result = appendZipEntry(zip, AIGC_PROPS_PART, raw, compressed);
  result = patchContentTypes(result, `/${AIGC_PROPS_PART}`, AIGC_PROPS_CONTENT_TYPE);
  return result;
}

// ── 本地 DOCX 生成器（零依赖，不需任何大模型 Key）──
//
// 目的：让「标准版即开即用」和「导出」不再自相矛盾。此前导出唯一路径是 Anthropic Agent Skills，
// 硬依赖 Claude Key——没配 Claude 渠道的用户看到的是置灰按钮。这里用已有的 zip 原语（crc32/deflate/
// 中央目录）直接拼一个最小可用的 .docx，Word/WPS/Pages 都能打开，AIGC 显式标识作为真实 <w:t> 正文写入
// （故 verifyAigcLabelInFile 能真校验），隐式标识仍走 injectAigcDocProps。
//
// 分工：有 Claude Key → 走 Skills 路径（排版更丰富）；无 Key → 本地渲染（永远可用）。
// pptx 的本地渲染在 lib/deliverable/pptx.ts（含 slideMaster/layout/theme 骨架），
// 两者由 lib/deliverable/registry.ts 统一注册，导出动作不再按格式写分支。
//
// produceId 给定时，构建阶段就把隐式标识 docProps/custom.xml 一并打进包（连同 Content_Types 的 Override），
// 这样上层 injectAigcDocProps 会检测到已存在而原样返回——避免对已有 zip 做事后偏移修补。
export function buildDocxLocal(title: string, content: string, produceId?: string): Buffer {
  const paras: string[] = [];
  // 标题：加粗大字号（用 run 属性而非 pStyle，免去 styles.xml 依赖）
  if (title.trim()) {
    paras.push(
      `<w:p><w:pPr><w:spacing w:after="200"/></w:pPr>` +
        `<w:r><w:rPr><w:b/><w:sz w:val="36"/></w:rPr>` +
        `<w:t xml:space="preserve">${escapeXml(title)}</w:t></w:r></w:p>`,
    );
  }
  // 正文：按换行切段，空行也保留为空段落，维持原有排版节奏
  for (const line of content.split('\n')) {
    paras.push(
      `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`,
    );
  }

  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${paras.join('')}` +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>' +
    '</w:sectPr></w:body></w:document>';

  // 隐式标识（第五条）：给定 produceId 时构建阶段直接打进包
  const withDocProps = produceId != null;
  const customPropsOverride = withDocProps
    ? `<Override PartName="/${AIGC_PROPS_PART}" ContentType="${AIGC_PROPS_CONTENT_TYPE}"/>`
    : '';
  // 除了 Content_Types，还要挂一条包级关系——只声明内容类型而不挂关系，
  // Word 的「属性 → 自定义」里看不到这几个隐式标识属性（等于第五条白做）。
  const customPropsRel = withDocProps
    ? `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="${AIGC_PROPS_PART}"/>`
    : '';

  const contentTypesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    customPropsOverride +
    '</Types>';

  const relsXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    customPropsRel +
    '</Relationships>';

  const files = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypesXml, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(relsXml, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
  ];
  if (withDocProps) {
    files.push({ name: AIGC_PROPS_PART, data: Buffer.from(aigcCustomPropsXml(produceId!), 'utf8') });
  }
  return buildZip(files);
}
