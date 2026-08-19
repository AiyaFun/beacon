// JPEG 元数据段读写 —— AI 封面的 AIGC 隐式标识载体（《标识办法》第五条 / GB 45438-2025 文件元数据）。
//
// PNG 的对应物是 iTXt（png-meta.ts）；JPEG 没有文本分块，惯例是 **APP1 段里的 XMP 包**
// （exiftool / Photoshop / 各看图工具都认）。即梦 Seedream 4.x 只出 JPEG，所以没有这一份，
// 封面就只有画在图上的显式水印、没有可字节级校验的隐式标识——此前正是这个状态，只回一条 warning。
//
// 与 png-meta.ts 同一姿态：零依赖、Uint8Array + 纯 JS，服务端与浏览器都能跑；不是合法 JPEG 就原样返回。
// 只写不改：已有的 APP0/APP1/EXIF 一律不动，我们的 XMP 段插在 SOI（与紧随其后的 APP0，若有）之后。
//
// ⚠️ 能力边界：显式标识（图上的「AI生成」角标）是像素，无法从字节里校验；能校验的只有这里的隐式标识。

const SOI = [0xff, 0xd8];
const XMP_NS = 'http://ns.adobe.com/xap/1.0/';
/** 我们自己的 XMP 命名空间：字段名与 GB 45438 的元数据字段一致。 */
const AIGC_XMLNS = 'https://beacon.aigc/ns/1.0/';

function isJpeg(data: Uint8Array): boolean {
  return data.length > 4 && data[0] === SOI[0] && data[1] === SOI[1];
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** 组 XMP 包：标准 xpacket 头尾 + rdf:Description 里放结构化字段与整段 JSON。 */
function xmpPacket(metadataJson: string): string {
  let label = '1';
  let producer = '';
  let produceId = '';
  try {
    const parsed = JSON.parse(metadataJson) as { AIGC?: { Label?: string; ContentProducer?: string; ProduceID?: string } };
    label = parsed.AIGC?.Label ?? label;
    producer = parsed.AIGC?.ContentProducer ?? '';
    produceId = parsed.AIGC?.ProduceID ?? '';
  } catch {
    /* 载荷不是 JSON 也照写进 Metadata 元素 */
  }
  return [
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    `<rdf:Description rdf:about="" xmlns:aigc="${AIGC_XMLNS}">`,
    `<aigc:Label>${escapeXml(label)}</aigc:Label>`,
    `<aigc:ContentProducer>${escapeXml(producer)}</aigc:ContentProducer>`,
    `<aigc:ProduceID>${escapeXml(produceId)}</aigc:ProduceID>`,
    `<aigc:Metadata>${escapeXml(metadataJson)}</aigc:Metadata>`,
    '</rdf:Description>',
    '</rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
  ].join('\n');
}

/** APP1 段：FF E1 + 长度(2, 含自身) + "http://ns.adobe.com/xap/1.0/\0" + XMP。长度上限 65533。 */
function makeXmpSegment(metadataJson: string): Uint8Array | null {
  const enc = new TextEncoder();
  const ns = enc.encode(XMP_NS + '\0');
  const body = enc.encode(xmpPacket(metadataJson));
  const payloadLen = ns.length + body.length;
  if (payloadLen + 2 > 0xffff) return null; // 单段放不下（我们的载荷远小于此，防御性判断）
  const seg = new Uint8Array(4 + payloadLen);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  seg[2] = ((payloadLen + 2) >>> 8) & 0xff;
  seg[3] = (payloadLen + 2) & 0xff;
  seg.set(ns, 4);
  seg.set(body, 4 + ns.length);
  return seg;
}

/** 插入点：SOI 之后；若紧接着是 APP0（JFIF），插在 APP0 之后（JFIF 规定 APP0 必须紧跟 SOI）。 */
function insertOffset(jpeg: Uint8Array): number {
  let p = 2;
  if (jpeg[p] === 0xff && jpeg[p + 1] === 0xe0 && p + 4 <= jpeg.length) {
    const len = (jpeg[p + 2] << 8) | jpeg[p + 3];
    if (p + 2 + len <= jpeg.length) p += 2 + len;
  }
  return p;
}

/**
 * 把 AIGC 元数据写进 JPEG（XMP APP1 段）。不是合法 JPEG、或段放不下 → 原样返回
 * （调用方另有显式水印兜底，不因元数据失败而中止出图；但要如实告知，见 run.ts）。
 */
export function injectJpegAigcMetadata(jpeg: Uint8Array, metadataJson: string): Uint8Array {
  if (!isJpeg(jpeg)) return jpeg;
  const seg = makeXmpSegment(metadataJson);
  if (!seg) return jpeg;
  const at = insertOffset(jpeg);
  const out = new Uint8Array(jpeg.length + seg.length);
  out.set(jpeg.subarray(0, at), 0);
  out.set(seg, at);
  out.set(jpeg.subarray(at), at + seg.length);
  return out;
}

/** 读回隐式标识（自检与测试用）；没有则返回 null。遍历段直到 SOS（之后是熵编码数据，不再有段）。 */
export function readJpegAigcMetadata(jpeg: Uint8Array): string | null {
  if (!isJpeg(jpeg)) return null;
  const dec = new TextDecoder();
  const nsBytes = new TextEncoder().encode(XMP_NS + '\0');
  let p = 2;
  while (p + 4 <= jpeg.length) {
    if (jpeg[p] !== 0xff) return null; // 段同步丢失
    const marker = jpeg[p + 1];
    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS
    if (marker === 0xff) { p++; continue; } // 填充
    const len = (jpeg[p + 2] << 8) | jpeg[p + 3];
    if (len < 2 || p + 2 + len > jpeg.length) return null;
    if (marker === 0xe1) {
      const payload = jpeg.subarray(p + 4, p + 2 + len);
      const isXmp = nsBytes.every((b, i) => payload[i] === b);
      if (isXmp) {
        const xml = dec.decode(payload.subarray(nsBytes.length));
        const m = xml.match(/<aigc:Metadata>([\s\S]*?)<\/aigc:Metadata>/);
        if (m) return unescapeXml(m[1]);
      }
    }
    p += 2 + len;
  }
  return null;
}
