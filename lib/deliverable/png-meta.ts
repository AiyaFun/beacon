// PNG 元数据分块读写 —— 图文卡的 AIGC 隐式标识载体（《标识办法》第五条）。
//
// OOXML 的隐式标识住在 docProps/custom.xml，图片没有这个位置；PNG 的对应物是 **iTXt 分块**。
// 用 iTXt 而不是 tEXt：tEXt 规定只能存 Latin-1，而服务提供者名称是中文（「烽火台」），
// 塞进 tEXt 是坏数据；iTXt 明确是 UTF-8。
//
// 这里刻意不依赖 node:zlib / Buffer：图文卡的 PNG 是浏览器 canvas 出的，注入发生在客户端，
// 所以全程 Uint8Array + 纯 JS（crc32 见 ./crc32，服务端 zip 也用同一份）。
//
// ⚠️ 能力边界要说清楚：图片里的**显式**标识（画在图上的那行字）无法从 PNG 字节里校验——
// 那是像素，验它得上 OCR。所以显式标识靠「由排版代码强制画上」保证（见 card.ts），
// 可字节级校验的只有这里的隐式标识。别把两者混为一谈，也别声称图片导出做了显式标识校验。

import { crc32 } from './crc32';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** iTXt 分块的关键字。看图工具（如 exiftool）里会显示成 AIGC。 */
export const AIGC_PNG_KEYWORD = 'AIGC';

function isPng(data: Uint8Array): boolean {
  return PNG_SIGNATURE.every((b, i) => data[i] === b);
}

function readUint32(data: Uint8Array, at: number): number {
  return ((data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3]) >>> 0;
}

function writeUint32(target: Uint8Array, at: number, value: number): void {
  target[at] = (value >>> 24) & 0xff;
  target[at + 1] = (value >>> 16) & 0xff;
  target[at + 2] = (value >>> 8) & 0xff;
  target[at + 3] = value & 0xff;
}

/** 组一个 PNG 分块：长度(4) + 类型(4) + 数据 + CRC(4)，CRC 覆盖「类型+数据」。 */
function makeChunk(type: string, payload: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + payload.length);
  writeUint32(chunk, 0, payload.length);
  chunk.set(typeBytes, 4);
  chunk.set(payload, 8);
  // CRC 的输入是 type + data，不含长度字段 —— 算错了看图软件会直接判文件损坏
  const crcInput = new Uint8Array(4 + payload.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(payload, 4);
  writeUint32(chunk, 8 + payload.length, crc32(crcInput));
  return chunk;
}

// iTXt 载荷布局：关键字 \0 压缩标志(0) 压缩方法(0) 语言标签 \0 翻译后的关键字 \0 UTF-8 正文
function iTXtPayload(keyword: string, text: string): Uint8Array {
  const enc = new TextEncoder();
  const kw = enc.encode(keyword);
  const body = enc.encode(text);
  const payload = new Uint8Array(kw.length + 5 + body.length);
  let p = 0;
  payload.set(kw, p); p += kw.length;
  payload[p++] = 0; // 关键字结束
  payload[p++] = 0; // 不压缩
  payload[p++] = 0; // 压缩方法（不压缩时必须为 0）
  payload[p++] = 0; // 语言标签为空
  payload[p++] = 0; // 翻译关键字为空
  payload.set(body, p);
  return payload;
}

/**
 * 把 AIGC 元数据写进 PNG。插在 IHDR 之后——IHDR 必须是第一个分块，
 * 辅助分块插在它后面对所有解码器都安全。
 * 不是合法 PNG 就原样返回（调用方另有显式标识兜底，不因元数据失败而中止导出）。
 */
export function injectPngAigcMetadata(png: Uint8Array, metadataJson: string): Uint8Array {
  if (!isPng(png)) return png;
  const ihdrEnd = 8 + 8 + readUint32(png, 8) + 4; // 签名 + (长度+类型) + 数据 + CRC
  if (ihdrEnd > png.length) return png;

  const chunk = makeChunk('iTXt', iTXtPayload(AIGC_PNG_KEYWORD, metadataJson));
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, ihdrEnd), 0);
  out.set(chunk, ihdrEnd);
  out.set(png.subarray(ihdrEnd), ihdrEnd + chunk.length);
  return out;
}

/** 读回隐式标识（自检与测试用）；没有则返回 null。 */
export function readPngAigcMetadata(png: Uint8Array): string | null {
  if (!isPng(png)) return null;
  const dec = new TextDecoder();
  let p = 8;
  while (p + 8 <= png.length) {
    const len = readUint32(png, p);
    const type = dec.decode(png.subarray(p + 4, p + 8));
    const data = png.subarray(p + 8, p + 8 + len);
    if (type === 'iTXt') {
      const zero = data.indexOf(0);
      if (zero > 0 && dec.decode(data.subarray(0, zero)) === AIGC_PNG_KEYWORD) {
        // 跳过 关键字\0 + 压缩标志 + 压缩方法 + 语言\0 + 翻译关键字\0
        let q = zero + 3;
        for (let skipped = 0; skipped < 2 && q < data.length; q++) {
          if (data[q] === 0) skipped++;
        }
        return dec.decode(data.subarray(q));
      }
    }
    if (type === 'IEND') break;
    p += 12 + len;
  }
  return null;
}
