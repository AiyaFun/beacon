// 图片隐式 AIGC 标识的统一出口：按 mime 分发到 PNG（iTXt）或 JPEG（XMP APP1）。
// 出图字节进内存的**第一站**就在这里打标（见 lib/cover/run.ts），前端拿到的永远是已打标的字节——
// 预览、下载、右键另存三条出口同一份字节，不存在「预览挂直链、下载才注标识」那个绕过口子。

import { injectPngAigcMetadata, readPngAigcMetadata } from './png-meta';
import { injectJpegAigcMetadata, readJpegAigcMetadata } from './jpeg-meta';

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | string;

/** 打标。返回是否真的写进去了（不认识的格式如 webp 原样返回并 embedded=false，调用方要如实告知）。 */
export function injectImageAigcMetadata(
  bytes: Uint8Array,
  mime: ImageMime,
  metadataJson: string,
): { bytes: Uint8Array; embedded: boolean } {
  if (mime === 'image/png') {
    const out = injectPngAigcMetadata(bytes, metadataJson);
    return { bytes: out, embedded: out !== bytes };
  }
  if (mime === 'image/jpeg' || mime === 'image/jpg') {
    const out = injectJpegAigcMetadata(bytes, metadataJson);
    return { bytes: out, embedded: out !== bytes };
  }
  return { bytes, embedded: false };
}

/** 回读（自检 / 测试用）。 */
export function readImageAigcMetadata(bytes: Uint8Array, mime: ImageMime): string | null {
  if (mime === 'image/png') return readPngAigcMetadata(bytes);
  if (mime === 'image/jpeg' || mime === 'image/jpg') return readJpegAigcMetadata(bytes);
  return null;
}

/** 从字节魔数嗅探 mime（provider 返回 b64 时不一定告诉我们格式）。 */
export function sniffImageMime(bytes: Uint8Array): ImageMime | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length > 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image/webp';
  return null;
}
