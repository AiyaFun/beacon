// 封面规格表：**比例是平台的属性，不是技能的属性**。
//
// 此前 3:4 / 1296x1728 写死在四处（image.ts 的尺寸常量、prompt.ts 的「比例 3:4」、
// SkillPanel 的 aspectRatio、下载文件名「小红书封面」）——加一个平台就要改四处，漏一处就是
// 「抖音稿出了张竖版小红书封面」这种不报错的错。现在这里是唯一一份：UI 的比例下拉、图像模型的
// size、提示词首行、结果图的 aspectRatio、下载文件名，都从这份表读。
//
// 尺寸取的是即梦 2K 档常见值（1728x2304 = 3:4 等），非预设比例（6:7 / 16:10 / 2.35:1）按同等面积推算。
//
// 2026-08-17 已对着方舟公开文档核过一遍：8 档全部落在合法区间内，其中 5 档（3:4 / 9:16 / 16:9 / 4:3 / 1:1）
// 正好是官方推荐档。**尺寸合法性不再是待办**；仍待真机的是出图观感（尤其中文上字），那个只有真出图才知道。
//
// 这份表是 client-safe 的纯数据（CoverStation 直接 import），不许引 prisma / node 内置模块。

// ── 方舟即梦对自定义「宽x高」的硬约束（官方文档口径）──
// 超出范围方舟直接 400，而且报错文本对用户毫无意义。所以：① 新增一档必须过下面这个校验
//（tests/cover/specs-styles.test.ts 会逐档跑）；② 真撞上了也要翻译成人话（见 lib/llm/image.ts）。
export const ARK_MIN_PIXELS = 3_686_400; // = 1920×1920
export const ARK_MAX_PIXELS = 16_777_216; // = 4096×4096
export const ARK_MIN_ASPECT = 1 / 16;
export const ARK_MAX_ASPECT = 16;

/** 这个「宽x高」方舟收不收。返回 null = 合法；否则返回一句能直接给用户看的原因。 */
export function checkArkSize(size: string): string | null {
  const m = /^(\d+)x(\d+)$/.exec(size);
  if (!m) return `尺寸格式必须是「宽x高」，收到的是「${size}」`;
  const w = Number(m[1]);
  const h = Number(m[2]);
  const px = w * h;
  if (px < ARK_MIN_PIXELS) return `${size} 太小了（${px.toLocaleString()} 像素，下限 ${ARK_MIN_PIXELS.toLocaleString()}）`;
  if (px > ARK_MAX_PIXELS) return `${size} 太大了（${px.toLocaleString()} 像素，上限 ${ARK_MAX_PIXELS.toLocaleString()}）`;
  const ar = w / h;
  if (ar < ARK_MIN_ASPECT || ar > ARK_MAX_ASPECT) return `${size} 的宽高比超出 1:16 ~ 16:1`;
  return null;
}

export type CoverSpec = {
  /** 比例 key，也是 UI/接口里传的值 */
  key: string;
  /** 给用户看的名字：「小红书 3:4」 */
  label: string;
  /** 比例文案，写进提示词首行 */
  ratio: string;
  /** CSS aspect-ratio 用的数值 */
  aspect: number;
  /** 送给图像模型的 size（宽x高） */
  size: string;
  /** 下载文件名的词干 */
  fileStem: string;
  /** 一句适用说明（UI 下拉的 title） */
  hint: string;
};

export const COVER_SPECS: CoverSpec[] = [
  { key: 'xhs-3-4', label: '小红书 3:4', ratio: '3:4', aspect: 3 / 4, size: '1728x2304', fileStem: '小红书封面', hint: '小红书笔记竖版封面' },
  { key: 'shipinhao-6-7', label: '视频号 6:7', ratio: '6:7', aspect: 6 / 7, size: '1920x2240', fileStem: '视频号封面', hint: '微信视频号竖版封面' },
  { key: 'douyin-9-16', label: '抖音 9:16', ratio: '9:16', aspect: 9 / 16, size: '1440x2560', fileStem: '抖音封面', hint: '抖音 / TikTok 竖版视频封面' },
  { key: 'bilibili-16-10', label: 'B站 16:10', ratio: '16:10', aspect: 16 / 10, size: '2560x1600', fileStem: 'B站封面', hint: 'B站横版视频封面' },
  { key: 'wechat-235-1', label: '公众号 2.35:1', ratio: '2.35:1', aspect: 2.35, size: '3008x1280', fileStem: '公众号封面', hint: '公众号头条横版封面' },
  { key: 'wide-16-9', label: '横版 16:9', ratio: '16:9', aspect: 16 / 9, size: '2560x1440', fileStem: '横版封面', hint: 'YouTube / X 等横版封面' },
  { key: 'landscape-4-3', label: '通用横版 4:3', ratio: '4:3', aspect: 4 / 3, size: '2304x1728', fileStem: '横版封面', hint: '通用横版' },
  { key: 'square-1-1', label: '正方形 1:1', ratio: '1:1', aspect: 1, size: '2048x2048', fileStem: '方形封面', hint: '通用正方形 / 公众号次图' },
];

/** 平台 → 默认比例。没列到的平台（或没有平台）回落到小红书 3:4。 */
const PLATFORM_DEFAULT_SPEC: Record<string, string> = {
  xiaohongshu: 'xhs-3-4',
  shipinhao: 'shipinhao-6-7',
  douyin: 'douyin-9-16',
  tiktok: 'douyin-9-16',
  bilibili: 'bilibili-16-10',
  wechat: 'wechat-235-1',
  youtube: 'wide-16-9',
  x: 'wide-16-9',
};

export const DEFAULT_COVER_SPEC = COVER_SPECS[0].key;

export function specForPlatform(platform: string | undefined | null): CoverSpec {
  const key = (platform && PLATFORM_DEFAULT_SPEC[platform]) || DEFAULT_COVER_SPEC;
  return coverSpec(key);
}

export function coverSpec(key: string | undefined | null): CoverSpec {
  return COVER_SPECS.find((s) => s.key === key) ?? COVER_SPECS[0];
}

/** 给 UI 下拉用的精简列表。 */
export const COVER_SPEC_OPTIONS = COVER_SPECS.map((s) => ({ key: s.key, label: s.label, hint: s.hint }));

// ── 这一次要出哪几张 ──────────────────────────────────────────────────────
//
// 三种来源合成一个 job 列表：① 多选风格 → 每个风格一张；② 变体 → 同风格多张；
// ③ 公众号成对 → 主图（2.35:1）之外再来一张 1:1 次图。总数封顶 MAX_COVER_IMAGES。
//
// 【为什么是一个共享的纯函数，而不是各算各的】此前服务端（lib/cover/run.ts）与工位
// （CoverStation.tsx 的 plannedImages）各写了一份计数，两份在**边界上不一致**：
// 选「出 3 张」再勾上「连 1:1 次图一起出」时，UI 说出 3 张、服务端先排满 3 张主图，
// 到成对那一步已经没有名额，`jobs.length < MAX` 不成立 —— 次图被**静默丢掉**。
// 张数对得上，所以既不报错也不进 warning，用户只会发现「勾了没用」。
//
// 现在成对是**先占位**的：勾了就先扣一格给次图，主图预算相应变成 MAX-1。
// 公众号要两张是硬约束（缺一张就得回头再出一次），而第 3 张同比例变体只是锦上添花。
export type CoverJob = { styleKey: string; specKey: string };

/** 公众号主图/次图的比例 key（成对出图的两端）。 */
export const WECHAT_MAIN_SPEC = 'wechat-235-1';
export const WECHAT_SQUARE_SPEC = 'square-1-1';

export function planCoverJobs(input: {
  /** 主比例 key（缺省按 DEFAULT_COVER_SPEC） */
  specKey?: string;
  /** 单选风格 */
  styleKey?: string;
  /** 多选风格：给了两个及以上就每个风格各一张，此时忽略 variants */
  styleKeys?: string[];
  /** 同一风格出几张变体（1..MAX_COVER_IMAGES） */
  variants?: number;
  /** 公众号：主图之外再出一张 1:1 次图。只有主比例是公众号时才生效。 */
  wechatSquareToo?: boolean;
  /** 总张数上限（= MAX_COVER_IMAGES，由调用方传入以免 specs.ts 反向依赖 rules.ts） */
  max: number;
}): CoverJob[] {
  const max = Math.max(1, Math.floor(input.max));
  const specKey = coverSpec(input.specKey).key;
  const pairing = input.wechatSquareToo === true && specKey === WECHAT_MAIN_SPEC;
  // 成对时先给次图留一格；只剩一格时优先保主图（没有主图的「一对」不成立）
  const mainBudget = pairing ? Math.max(1, max - 1) : max;

  const styleList = (input.styleKeys?.length ? input.styleKeys : [input.styleKey ?? '']).slice(0, mainBudget);
  const wanted = Math.max(1, Math.min(mainBudget, Math.floor(input.variants ?? 1) || 1));
  const jobs: CoverJob[] =
    styleList.length > 1
      ? styleList.map((k) => ({ styleKey: k, specKey }))
      : Array.from({ length: wanted }, () => ({ styleKey: styleList[0] ?? '', specKey }));

  if (pairing && jobs.length < max) jobs.push({ styleKey: styleList[0] ?? '', specKey: WECHAT_SQUARE_SPEC });
  return jobs.slice(0, max);
}
