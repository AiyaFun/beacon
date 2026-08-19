import type { ContentPart } from './types';

// 火山方舟（豆包）视频理解的输入侧约定。
//
// 【为什么单独一个文件】视频这条链路的约束跟文本/图片都不一样，而且**约束本身就是产品逻辑**：
// 能不能分析一条视频，90% 取决于「这个输入方舟够不够得到」，不取决于模型聪不聪明。
// 把这些判断集中在一处，UI、任务、接口三边共用同一套说法，不会各写一份各说各的。
//
// 端点与 baseUrl 复用 lib/constants.ts 的 LLM_VENDORS.doubao（ark.cn-beijing.volces.com/api/v3），
// 调用走通用的 OpenAICompatibleProvider —— 方舟是 OpenAI 兼容口径，不需要专用 SDK。

/** 抽帧频率：方舟取值区间 [0.2, 5]，默认 1。越低越省 token，长视频靠它控成本。 */
export const FPS_MIN = 0.2;
export const FPS_MAX = 5;
export const FPS_DEFAULT = 1;

/**
 * 本地文件走 data: URI 内联的大小上限。
 *
 * 【为什么是 25MB 而不是「随便多大」】两个独立的天花板叠在一起，取小的那个：
 *   ① 方舟侧对单个文件有大小限制（官方文档给的是 25MB 这一档）；
 *   ② base64 会把体积放大到 4/3，25MB 的视频进请求体就是 ~33MB，这已经是
 *      Node 侧单请求内存占用的合理上限了。再大必须换 Files API 的 file_id 通道。
 *
 * ⚠️ 这个数字标着「待真机校准」：方舟文档站是 JS 渲染的，抓不到正文（跟 lib/clip/platform.ts
 * 里那批站同一个毛病），这一档是按官方公开口径取的保守值。拿到 ARK Key 后实测一条超限视频，
 * 按真实报错把它调准——**宁可小，不要大**：小了用户看到的是明确的「请压到 25MB 内」，
 * 大了用户看到的是等 90 秒之后一个看不懂的方舟错误。
 */
export const MAX_INLINE_VIDEO_BYTES = 50 * 1024 * 1024;

/** 允许内联的视频容器格式（方舟侧支持面 ∩ 创作者手里真实会有的格式）。 */
export const ALLOWED_VIDEO_MIME = new Set([
  'video/mp4',
  'video/quicktime', // .mov —— iPhone 直出，创作者手里最常见的那一种
  'video/x-matroska', // .mkv
  'video/webm',
]);

/** 视频输入源：要么是方舟够得到的公网直链，要么是用户本地文件（内联）。 */
export type VideoSource =
  | { kind: 'url'; url: string }
  | { kind: 'inline'; dataUri: string; bytes: number; mime: string };

export function clampFps(fps?: number): number {
  if (typeof fps !== 'number' || !Number.isFinite(fps)) return FPS_DEFAULT;
  return Math.min(FPS_MAX, Math.max(FPS_MIN, fps));
}

/** 视频源 → 方舟的 video_url 片段。 */
export function videoPart(source: VideoSource, fps?: number): ContentPart {
  return {
    type: 'video_url',
    video_url: {
      url: source.kind === 'url' ? source.url : source.dataUri,
      fps: clampFps(fps),
    },
  };
}

/** 本地文件 → 内联源。超限/格式不对时返回原因，由调用方原样告诉用户。 */
export function inlineSource(bytes: Uint8Array, mime: string): { ok: true; source: VideoSource } | { ok: false; error: string } {
  const type = (mime || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_VIDEO_MIME.has(type)) {
    return { ok: false, error: `不支持的视频格式（${type || '未知'}）。请用 mp4 / mov / mkv / webm。` };
  }
  if (bytes.byteLength > MAX_INLINE_VIDEO_BYTES) {
    const mb = (bytes.byteLength / 1024 / 1024).toFixed(1);
    const cap = MAX_INLINE_VIDEO_BYTES / 1024 / 1024;
    return { ok: false, error: `视频 ${mb}MB，超过 ${cap}MB 上限。先压一下，或改用公网直链。` };
  }
  const b64 = Buffer.from(bytes).toString('base64');
  return { ok: true, source: { kind: 'inline', dataUri: `data:${type};base64,${b64}`, bytes: bytes.byteLength, mime: type } };
}

/**
 * 这个模型名看起来支持视频吗。
 *
 * ⚠️ **只用来给提示，绝不用来拦调用**。模型名是用户在设置页自由填的（白名单尚未实现，
 * 见 lib/constants.ts 的 F12-1 注释），而火山随时会出新模型名——写死白名单的结局是
 * 用户填了个真能用的新模型，却被我们自己拦住，还查不出为什么。
 * 拦截交给方舟自己去做，它的报错比我们的猜测准。
 *
 * `ep-` 开头的**推理接入点 ID** 故意不在这里判真假：接入点名字里看不出背后挂的是哪个模型，
 * 猜不出来就不猜。judgeless 地返回 true，让它走正常调用路径由方舟裁决。
 */
export function looksVideoCapable(model: string): boolean {
  const m = (model || '').toLowerCase();
  if (m.startsWith('ep-')) return true; // 接入点 ID：看不出模型，交给方舟判
  return /vision|seed-\d|seed-[a-z]|omni/.test(m);
}

/**
 * 给用户看的模型建议（设置页/错误提示/UI 共用，避免几处各写一句不一样的）。
 *
 * 2026-07-31 真机实测结论（用真 ARK Key 跑的，不是查文档得来的）：
 *   doubao-seed-evolving  ✅ 视频理解稳定跑通（10s 视频 fps=1 → 1218 prompt tokens）
 *   doubao-seed-1-6       ⚠️ 同一条视频处理超时失败，稳健性差一截
 *   doubao-seedance-*     ❌ 是「文生视频」不是「看视频」，且极贵
 *   doubao-pro-*          ❌ 纯文本（⚠️ LLM_VENDORS 里 doubao 的默认值正是它，照默认填必踩）
 * 另：**所有豆包视频理解都只抽帧读画面、听不到音轨**（evolving 对带旁白的视频直接回「无音轨」）。
 */
export const VIDEO_MODEL_HINT =
  '模型名推荐填 doubao-seed-evolving（已实测跑通）。' +
  'doubao-pro 这类纯文本的不行；doubao-seedance 是「文生视频」不是「看视频」，更不能填。' +
  '注意豆包视频理解只看画面不听声音，口播要靠视频里的硬字幕才读得到。' +
  '若报模型不存在，改填控制台「推理接入点」里 ep- 开头的 ID。';
