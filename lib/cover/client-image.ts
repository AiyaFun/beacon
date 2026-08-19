// 浏览器侧的参考图预处理：EXIF 转正 + 缩到长边 ≤ REFERENCE_MAX_EDGE + 压到 ≤ MAX_REFERENCE_BYTES 的 JPEG data URL。
//
// 为什么在浏览器做而不是服务端：项目服务端零图像库（不引 sharp 是既定取向），而手机直出的照片
// 动辄 3–8MB、还带 EXIF 方向——不转正的话竖着拍的自拍会以横躺姿势送进模型。
// 对应外部工具「读 EXIF 旋转 → >4MB 压缩」那两步，只是搬到了上传之前。
// 只在 'use client' 组件里调用；这里没有任何 DOM 之外的依赖。

import { MAX_REFERENCE_BYTES, REFERENCE_MAX_EDGE } from './rules';

export type PreparedImage = { dataUrl: string; bytes: number; width: number; height: number };

function dataUrlBytes(dataUrl: string): number {
  const i = dataUrl.indexOf(',');
  const b64 = i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  // createImageBitmap 的 imageOrientation:'from-image' 会按 EXIF 转正（现代浏览器都支持）；
  // 不支持时退回 <img>（浏览器对 <img> 的默认 image-orientation 也是 from-image）。
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
    } catch {
      /* fall through */
    }
  }
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片读取失败'));
    };
    img.src = url;
  });
}

/**
 * 把用户选的图片处理成可以直接放进请求体的 data URL。
 * 失败（不是图片 / 解码失败）抛错，调用方给用户看一句话。
 */
export async function prepareReferenceImage(file: File): Promise<PreparedImage> {
  if (!file.type.startsWith('image/')) throw new Error('只支持图片文件');
  const src = await loadBitmap(file);
  const sw = 'width' in src ? src.width : (src as HTMLImageElement).naturalWidth;
  const sh = 'height' in src ? src.height : (src as HTMLImageElement).naturalHeight;
  if (!sw || !sh) throw new Error('图片尺寸读不出来，换一张试试');

  const scale = Math.min(1, REFERENCE_MAX_EDGE / Math.max(sw, sh));
  let w = Math.max(1, Math.round(sw * scale));
  let h = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement('canvas');
  const draw = (cw: number, ch: number) => {
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('浏览器不支持 canvas');
    ctx.fillStyle = '#fff'; // JPEG 没有透明通道：透明 PNG 的底填白，别变成黑
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(src as CanvasImageSource, 0, 0, cw, ch);
  };

  draw(w, h);
  let quality = 0.86;
  let out = canvas.toDataURL('image/jpeg', quality);
  // 先降质量，再降尺寸，直到 ≤ 上限
  for (let i = 0; i < 8 && dataUrlBytes(out) > MAX_REFERENCE_BYTES; i++) {
    if (quality > 0.6) {
      quality -= 0.1;
    } else {
      w = Math.max(320, Math.round(w * 0.8));
      h = Math.max(320, Math.round(h * 0.8));
      draw(w, h);
    }
    out = canvas.toDataURL('image/jpeg', quality);
  }
  if ('close' in src && typeof (src as ImageBitmap).close === 'function') (src as ImageBitmap).close();
  const bytes = dataUrlBytes(out);
  if (bytes > MAX_REFERENCE_BYTES) throw new Error('这张图压不到 1MB 以内，换张小点的');
  return { dataUrl: out, bytes, width: w, height: h };
}

/**
 * 触发下载。两种来源都吃：data URL（没落库时）与 /api/media/<id>（落库后的鉴权路由）。
 * 后者必须 fetch 成 blob 再存——直接 <a download href="/api/media/x"> 在同源下虽然能下，
 * 但文件名会被响应头左右，而我们要按平台给它起名（「小红书封面.jpg」）。
 */
export async function downloadImage(url: string, filename: string): Promise<void> {
  let blob: Blob;
  if (url.startsWith('data:')) {
    const i = url.indexOf(',');
    const mime = /data:([^;]+)/.exec(url.slice(0, i))?.[1] ?? 'application/octet-stream';
    const bin = atob(url.slice(i + 1));
    const arr = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
    blob = new Blob([arr], { type: mime });
  } else {
    const res = await fetch(url);
    if (!res.ok) throw new Error('图片取不回来了，刷新页面再试');
    blob = await res.blob();
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
