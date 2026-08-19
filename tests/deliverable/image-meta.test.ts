import { describe, it, expect } from 'vitest';
import { injectJpegAigcMetadata, readJpegAigcMetadata } from '@/lib/deliverable/jpeg-meta';
import { injectPngAigcMetadata, readPngAigcMetadata } from '@/lib/deliverable/png-meta';
import { injectImageAigcMetadata, readImageAigcMetadata, sniffImageMime } from '@/lib/deliverable/image-meta';
import { aigcMetadataJson } from '@/lib/compliance/aigc';

// JPEG 隐式标识：零依赖手写字节段，必须有回读测试 + 「去掉注入真会红」的守卫。
// 即梦 Seedream 4.x 只出 JPEG，这条链不通 = 封面只有水印没有元数据标识。

/** 最小合法 JPEG 骨架：SOI + APP0(JFIF) + SOS(空) + EOI。看图软件不一定能解，但段结构完整。 */
function minimalJpeg(withApp0 = true): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  if (withApp0) {
    const jfif = [0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
    parts.push(0xff, 0xe0, 0x00, jfif.length + 2, ...jfif);
  }
  parts.push(0xff, 0xda, 0x00, 0x02); // SOS，长度 2（无内容）
  parts.push(0x12, 0x34); // 假的熵编码数据
  parts.push(0xff, 0xd9); // EOI
  return new Uint8Array(parts);
}

const META = aigcMetadataJson('tenant-cover-1');

describe('jpeg-meta：XMP APP1 注入与回读', () => {
  it('注入后能读回同一份 JSON；未注入读到 null', () => {
    const src = minimalJpeg();
    expect(readJpegAigcMetadata(src)).toBeNull();
    const out = injectJpegAigcMetadata(src, META);
    expect(out.length).toBeGreaterThan(src.length);
    expect(readJpegAigcMetadata(out)).toBe(META);
  });

  it('插在 APP0 之后（JFIF 规定 APP0 紧跟 SOI），原有段字节不动，SOI/EOI 仍在两端', () => {
    const src = minimalJpeg();
    const out = injectJpegAigcMetadata(src, META);
    expect([out[0], out[1]]).toEqual([0xff, 0xd8]);
    expect([out[out.length - 2], out[out.length - 1]]).toEqual([0xff, 0xd9]);
    // APP0 原封不动地在偏移 2
    const app0Len = (src[4] << 8) | src[5];
    expect(Array.from(out.subarray(2, 4 + app0Len))).toEqual(Array.from(src.subarray(2, 4 + app0Len)));
    // 紧接着就是我们的 APP1
    expect([out[4 + app0Len], out[5 + app0Len]]).toEqual([0xff, 0xe1]);
  });

  it('没有 APP0 时插在 SOI 之后', () => {
    const out = injectJpegAigcMetadata(minimalJpeg(false), META);
    expect([out[2], out[3]]).toEqual([0xff, 0xe1]);
    expect(readJpegAigcMetadata(out)).toBe(META);
  });

  it('中文 / 特殊字符载荷（& < >）也能安全往返', () => {
    const json = JSON.stringify({ AIGC: { Label: '1', ContentProducer: '烽火台 <a> & b', ProduceID: 'x' } });
    const out = injectJpegAigcMetadata(minimalJpeg(), json);
    expect(readJpegAigcMetadata(out)).toBe(json);
  });

  it('不是 JPEG → 原样返回、读为 null（不因元数据失败中止出图）', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(injectJpegAigcMetadata(png, META)).toBe(png);
    expect(readJpegAigcMetadata(png)).toBeNull();
  });
});

describe('image-meta 分发', () => {
  it('按 mime 分发到 JPEG / PNG；未知格式 embedded=false 且字节原样', () => {
    const jpg = injectImageAigcMetadata(minimalJpeg(), 'image/jpeg', META);
    expect(jpg.embedded).toBe(true);
    expect(readImageAigcMetadata(jpg.bytes, 'image/jpeg')).toBe(META);

    // 最小 PNG：签名 + IHDR（长度 13）+ IEND
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89,
      0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const p = injectImageAigcMetadata(png, 'image/png', META);
    expect(p.embedded).toBe(true);
    expect(readPngAigcMetadata(p.bytes)).toBe(META);
    // 与直接调 png-meta 等价
    expect(Array.from(p.bytes)).toEqual(Array.from(injectPngAigcMetadata(png, META)));

    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0]);
    const w = injectImageAigcMetadata(webp, 'image/webp', META);
    expect(w.embedded).toBe(false);
    expect(w.bytes).toBe(webp);
  });

  it('sniffImageMime 按魔数认 png / jpeg / webp，认不出返回 null', () => {
    expect(sniffImageMime(minimalJpeg())).toBe('image/jpeg');
    expect(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0]))).toBe('image/webp');
    expect(sniffImageMime(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]))).toBeNull();
  });
});
