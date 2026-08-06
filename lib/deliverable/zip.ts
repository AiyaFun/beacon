// 零依赖 zip / XML 原语 —— OOXML 交付物（docx / pptx / xlsx）的公共底座。
//
// 出处：这些函数原本长在 lib/llm/skills.ts 里（当时只有「读 Anthropic 产物 + 拼本地 docx」两个用途）。
// 本地 pptx 渲染器出现后它们要被第二个模块用，故原样搬到这里，行为一字未改：
// skills.ts 继续 import 使用，导出的公共 API（verifyAigcLabelInFile / buildDocxLocal /
// injectAigcDocProps）签名与语义完全不变。
//
// 为什么不引 jszip/pptxgenjs：OOXML 只用到 deflate + 中央目录这一小撮能力，Node 内置 zlib 就够；
// 这条链路上跑的是合规校验（标识有没有真进文件），依赖越少、可审计性越高。

import { inflateRawSync, deflateRawSync } from 'node:zlib';
import { crc32 } from './crc32';

export { crc32 };

// ── zip 读 ──
// 走中央目录而非逐个本地头：本地头在流式写出的 zip 里 size 字段为 0（真值在数据描述符里），
// 中央目录的 size 永远是真值。
export function readZipEntries(buf: Buffer): { name: string; data: Buffer }[] {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是合法的 zip（找不到中央目录）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: { name: string; data: Buffer }[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break; // 中央目录项签名
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (compSize !== 0xffffffff && buf.readUInt32LE(localOff) === 0x04034b50) {
      // 本地头长度可变，必须现读现算数据起点
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compSize);
      try {
        if (method === 0) entries.push({ name, data: raw }); // stored
        else if (method === 8) entries.push({ name, data: inflateRawSync(raw) }); // deflate
        // 其余压缩法（bzip2/lzma）OOXML 不用，忽略
      } catch {
        /* 单个部件解压失败不拖垮整体：正文通常只在其中一两个部件里 */
      }
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// 从尾部回扫 EOCD 签名（zip 注释最长 64KB，故最多回扫 64KB + 22）
export function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 0x10016);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

// ── zip 写 ──
// 从零拼一个 zip（本地头 + 中央目录 + EOCD），deflate 压缩，与 readZipEntries/appendZipEntry 同规格。
export function buildZip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const compressed = deflateRawSync(f.data);

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method = deflate
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date（固定 1980-01-01，保证可复现）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0); // 中央目录项签名
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(8, 10); // method
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0x21, 14); // mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42); // 本地头偏移
    nameBytes.copy(central, 46);
    centrals.push(central);

    offset += local.length + compressed.length;
  }

  const cdir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdir.length, 12);
  eocd.writeUInt32LE(offset, 16); // 中央目录起始偏移
  return Buffer.concat([...locals, cdir, eocd]);
}

/** 往 [Content_Types].xml 里补一条 Override（已存在则原样返回）。 */
export function patchContentTypes(zip: Buffer, partName: string, contentType: string): Buffer {
  const entries = readZipEntries(zip);
  const ct = entries.find(e => e.name === '[Content_Types].xml');
  if (!ct) return zip;
  let xml = ct.data.toString('utf8');
  if (xml.includes(partName)) return zip;
  const override = `<Override PartName="${partName}" ContentType="${contentType}"/>`;
  xml = xml.replace('</Types>', `${override}</Types>`);
  const raw = Buffer.from(xml, 'utf8');
  const compressed = deflateRawSync(raw);
  return replaceZipEntry(zip, '[Content_Types].xml', raw, compressed);
}

export function replaceZipEntry(zip: Buffer, name: string, rawData: Buffer, compressed: Buffer): Buffer {
  const eocd = findEocd(zip);
  if (eocd < 0) return zip;
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const entryName = zip.toString('utf8', p + 46, p + 46 + nameLen);
    if (entryName === name) {
      const localOff = zip.readUInt32LE(p + 42);
      const lNameLen = zip.readUInt16LE(localOff + 26);
      const lExtraLen = zip.readUInt16LE(localOff + 28);
      const oldCompSize = zip.readUInt32LE(localOff + 18);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const crc = crc32(rawData);
      const before = zip.subarray(0, dataStart);
      const after = zip.subarray(dataStart + oldCompSize);
      const sizeDiff = compressed.length - oldCompSize;
      before.writeUInt32LE(crc, localOff + 14);
      before.writeUInt32LE(compressed.length, localOff + 18);
      before.writeUInt32LE(rawData.length, localOff + 22);
      const result = Buffer.concat([before, compressed, after]);
      const newEocd = findEocd(result);
      if (newEocd < 0) return result;
      let cp = result.readUInt32LE(newEocd + 16);
      for (let j = 0; j < count; j++) {
        if (result.readUInt32LE(cp) !== 0x02014b50) break;
        const cn = result.readUInt16LE(cp + 28);
        const ce = result.readUInt16LE(cp + 30);
        const cc = result.readUInt16LE(cp + 32);
        const cName = result.toString('utf8', cp + 46, cp + 46 + cn);
        if (cName === name) {
          result.writeUInt32LE(crc, cp + 16);
          result.writeUInt32LE(compressed.length, cp + 20);
          result.writeUInt32LE(rawData.length, cp + 24);
        } else {
          const off = result.readUInt32LE(cp + 42);
          if (off > localOff) result.writeUInt32LE(off + sizeDiff, cp + 42);
        }
        cp += 46 + cn + ce + cc;
      }
      return result;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return zip;
}

export function appendZipEntry(zip: Buffer, name: string, rawData: Buffer, compressed: Buffer): Buffer {
  const eocdPos = findEocd(zip);
  if (eocdPos < 0) return zip;

  const existingCount = zip.readUInt16LE(eocdPos + 10);
  const existingCdirOff = zip.readUInt32LE(eocdPos + 16);
  const existingCdirSize = zip.readUInt32LE(eocdPos + 12);

  const nameBytes = Buffer.from(name, 'utf8');
  const crc = crc32(rawData);

  const localOff = existingCdirOff;
  const localHeader = Buffer.alloc(30 + nameBytes.length);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(rawData.length, 22);
  localHeader.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(localHeader, 30);

  const oldCdir = zip.subarray(existingCdirOff, existingCdirOff + existingCdirSize);

  const newCdir = Buffer.alloc(46 + nameBytes.length);
  newCdir.writeUInt32LE(0x02014b50, 0);
  newCdir.writeUInt16LE(20, 4);
  newCdir.writeUInt16LE(20, 6);
  newCdir.writeUInt16LE(0, 8);
  newCdir.writeUInt16LE(8, 10);
  newCdir.writeUInt32LE(crc, 16);
  newCdir.writeUInt32LE(compressed.length, 20);
  newCdir.writeUInt32LE(rawData.length, 24);
  newCdir.writeUInt16LE(nameBytes.length, 28);
  newCdir.writeUInt32LE(localOff, 42);
  nameBytes.copy(newCdir, 46);

  const newCdirOff = localOff + localHeader.length + compressed.length;

  const newEocd = Buffer.alloc(22);
  newEocd.writeUInt32LE(0x06054b50, 0);
  newEocd.writeUInt16LE(existingCount + 1, 8);
  newEocd.writeUInt16LE(existingCount + 1, 10);
  newEocd.writeUInt32LE(existingCdirSize + newCdir.length, 12);
  newEocd.writeUInt32LE(newCdirOff, 16);

  return Buffer.concat([
    zip.subarray(0, existingCdirOff),
    localHeader,
    compressed,
    oldCdir,
    newCdir,
    newEocd,
  ]);
}

// ── XML 转义 ──

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function unescapeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
