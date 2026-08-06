import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { verifyAigcLabelInFile, buildDocxLocal, injectAigcDocProps } from '@/lib/llm/skills';
import { AIGC_LABEL, ensureAigcLabel } from '@/lib/compliance/aigc';

// 导出件的 AIGC 标识校验回环（《标识办法》第四条：导出须确保**文件中**含显式标识）。
//
// 修复前：标识只是被写进 prompt「要求模型保留」，产物零校验 —— 模型不听话就交付无标识文件，
// 而 UI 还把「文件内置标识」当既成事实告诉用户。
//
// 本文件锁住三件事：
// 1. 朴素的 buffer.includes(标识) 对**任何**导出格式都不成立（别有人「优化」成那种写法）。
// 2. OOXML（docx/pptx）能真校验，且未检出时必须 fail closed。
// 3. PDF 校验不了这件事是**显式声明**的（verifiable:false），不能假装校验过。

// ── 真实 fixture：macOS textutil（真 Word writer，非本仓库自造）产出的 .docx ──
// 正文为「三种做图方式对比 / AI 生成成本低、速度快，手绘慢但有温度。/ ——本内容由人工智能生成」。
// 用真实 writer 的产物而非自造 zip，是为了连同真实 writer 的 zip 标志位/压缩方式一起锁住。
const REAL_DOCX_B64 = [
  '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',
].join('');
const REAL_DOCX = Buffer.from(REAL_DOCX_B64, 'base64');

// ── 极简 zip writer：造 OOXML 用。刻意与被测的 reader 独立实现，构成真正的往返测试 ──
function zip(files: { name: string; body: string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.from(f.body, 'utf8');
    const comp = deflateRawSync(raw);
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8); // deflate
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

// 造一份 pptx：runs 为 <a:t> 文本数组，模拟模型/渲染器把一句话拆进多个 run
function pptx(runs: string[]): Buffer {
  const body = runs.map((t) => `<a:r><a:t>${t}</a:t></a:r>`).join('');
  return zip([
    { name: '[Content_Types].xml', body: '<?xml version="1.0"?><Types/>' },
    { name: 'ppt/slides/slide1.xml', body: `<?xml version="1.0"?><p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p>${body}</a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>` },
  ]);
}

describe('export-label · 朴素 includes 检不出标识（这就是要写校验器的原因）', () => {
  it('真实 docx：标识明明在文档里，buffer.includes 却是 false', () => {
    // OOXML 是 zip+deflate，正文压缩后不存在明文 —— 谁把校验退化成 includes，这条会红
    expect(REAL_DOCX.includes(Buffer.from(AIGC_LABEL, 'utf8'))).toBe(false);
    expect(verifyAigcLabelInFile('docx', REAL_DOCX).found).toBe(true);
  });

  it('pptx 同理', () => {
    const f = pptx(['三种做图方式对比', AIGC_LABEL]);
    expect(f.includes(Buffer.from(AIGC_LABEL, 'utf8'))).toBe(false);
    expect(verifyAigcLabelInFile('pptx', f).found).toBe(true);
  });
});

describe('export-label · OOXML 可校验（docx/pptx/xlsx）', () => {
  it('真实 Word writer 的产物：解出标识', () => {
    const r = verifyAigcLabelInFile('docx', REAL_DOCX);
    expect(r.verifiable).toBe(true);
    expect(r.found).toBe(true);
  });

  it('标识被拆进多个 run 也能检出（模型/渲染器常这么拆）', () => {
    const r = verifyAigcLabelInFile('pptx', pptx(['——本内容由', '人工智能', '生成']));
    expect(r.found).toBe(true);
  });

  it('标识中间被插入空白/换行也能检出', () => {
    expect(verifyAigcLabelInFile('pptx', pptx(['本内容由 人工智能\n生成'])).found).toBe(true);
  });

  it('XML 转义实体能还原', () => {
    expect(verifyAigcLabelInFile('pptx', pptx(['本内容由人工智能生&#x6210;'])).found).toBe(true);
  });

  // ⬇︎ 核心：模型没保留标识 → 必须检出「没有」，让上层 fail closed
  it('模型漏掉标识 → found=false（原缺陷：这种文件会被照常交付）', () => {
    const r = verifyAigcLabelInFile('pptx', pptx(['三种做图方式对比', 'AI 生成成本低、速度快。']));
    expect(r.verifiable).toBe(true);
    expect(r.found).toBe(false);
  });

  it('正文只是「提到」AI 生成，不算标识', () => {
    expect(verifyAigcLabelInFile('pptx', pptx(['本页讲 AI 生成的图片为什么便宜'])).found).toBe(false);
  });

  it('xlsx 的 sharedStrings（<t> 标签）也覆盖', () => {
    const f = zip([
      { name: '[Content_Types].xml', body: '<?xml version="1.0"?><Types/>' },
      { name: 'xl/sharedStrings.xml', body: `<?xml version="1.0"?><sst><si><t>${AIGC_LABEL}</t></si></sst>` },
    ]);
    expect(verifyAigcLabelInFile('xlsx', f).found).toBe(true);
  });
});

describe('export-label · 解不开的文件一律当未通过（fail closed）', () => {
  it('损坏的 zip → verifiable=true 但 found=false，绝不默认放行', () => {
    const r = verifyAigcLabelInFile('docx', Buffer.from('这根本不是 zip'));
    expect(r.verifiable).toBe(true);
    expect(r.found).toBe(false);
    expect(r.reason).toContain('校验失败');
  });

  it('空文件 → 未通过', () => {
    expect(verifyAigcLabelInFile('docx', Buffer.alloc(0)).found).toBe(false);
  });

  it('截断的 docx（中央目录还在但数据没了）→ 未通过', () => {
    expect(verifyAigcLabelInFile('docx', REAL_DOCX.subarray(0, 500)).found).toBe(false);
  });
});

// PDF：正文被编码成**子集字体的字形 ID**（实测：`<010001000107…> Tj`），还原 Unicode 需要解析
// 字体的 ToUnicode CMap —— pdf-parse / pdf.js 级别的工作量，本项目不引这个依赖。
// 所以 PDF **只能如实声明校验不了**，由 UI 提示用户自查，绝不冒充「已校验」。
describe('export-label · PDF 明确声明「校验不了」，不冒充已校验', () => {
  it('verifiable=false，且 found 不得为 true（不许假阳性）', () => {
    const r = verifyAigcLabelInFile('pdf', Buffer.from('%PDF-1.7 ...'));
    expect(r.verifiable).toBe(false);
    expect(r.found).toBe(false);
  });

  it('reason 说清为什么校验不了（这句会经 warning 透给用户）', () => {
    expect(verifyAigcLabelInFile('pdf', Buffer.alloc(0)).reason).toContain('无法自动校验');
  });
});

// 本地零依赖 docx 生成器（标准版即开即用导出，不需任何大模型 Key）。
// 关键约束：产物必须是**能被同一 verifyAigcLabelInFile 真校验**的合法 OOXML，
// 且 AIGC 显式标识作为真实正文写入（不是靠 buffer.includes 蒙混）。
describe('buildDocxLocal · 本地生成的 docx 必须能通过 AIGC 校验回环', () => {
  const content = ensureAigcLabel('三种做图方式对比\n\nAI 生成成本低、速度快，手绘慢但有温度。');

  it('生成的 docx 能被 verifyAigcLabelInFile 校验到标识（verifiable=true, found=true）', () => {
    const buf = buildDocxLocal('我的标题', content);
    const r = verifyAigcLabelInFile('docx', buf);
    expect(r.verifiable).toBe(true);
    expect(r.found).toBe(true);
  });

  it('标识是压进 zip 的真实正文，不是明文——朴素 buffer.includes 必须为 false', () => {
    const buf = buildDocxLocal('标题', content);
    expect(buf.includes(AIGC_LABEL)).toBe(false); // 被 deflate 压缩，明文搜不到
    expect(verifyAigcLabelInFile('docx', buf).found).toBe(true); // 解压后能校验到
  });

  it('构建时打入隐式标识 docProps 后仍是合法 docx，且显式标识校验照旧通过', () => {
    const buf = buildDocxLocal('标题', content, 'tenant-x-draft-y');
    expect(verifyAigcLabelInFile('docx', buf).found).toBe(true);
    // injectAigcDocProps 应检测到已存在 → 原样返回，不重复注入、不破坏结构
    expect(verifyAigcLabelInFile('docx', injectAigcDocProps(buf, 'tenant-x-draft-y')).found).toBe(true);
  });

  it('内容里没有标识时，校验必须 found=false（不放行无标识文件）', () => {
    const buf = buildDocxLocal('标题', '一段没有任何 AIGC 标识的正文');
    expect(verifyAigcLabelInFile('docx', buf).found).toBe(false);
  });

  it('标题/正文里的 XML 特殊字符被正确转义，不破坏文件结构', () => {
    const buf = buildDocxLocal('<script>&"标题"', ensureAigcLabel('正文含 <标签> & "引号"'));
    // 能被校验（说明 zip/XML 结构没被特殊字符破坏）
    expect(verifyAigcLabelInFile('docx', buf).verifiable).toBe(true);
    expect(verifyAigcLabelInFile('docx', buf).found).toBe(true);
  });
});
