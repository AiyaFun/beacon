import type { BotImage } from './image';

// data:image URL → Buffer（**纯函数、零依赖**）。
//
// 执行器是把截图当 data URL 传上来的（与解析失效上报同一种形状，闸门也共用
// lib/ingest/parser-learn 的 vetScreenshot）。发给机器人要的是二进制，
// 这一步就是中间那层转换——单独成文件是为了能被测到，也免得两处各写一遍 base64 解码。
export function decodeDataUrl(raw: string | null | undefined): BotImage | null {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(raw ?? '');
  if (!m) return null;
  try {
    const data = Buffer.from(m[2], 'base64');
    if (data.length === 0) return null;
    return { data, mime: m[1] };
  } catch {
    return null;
  }
}
