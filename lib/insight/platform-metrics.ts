import type { MetricCountKey } from '@/lib/json';

// 「这个平台到底有没有这项数据」——各平台公开页面能给到什么，逐项列明。
//
// 【为什么需要它】各平台给的字段差别很大：B站 有播放/弹幕/投币，抖音公开页连播放量都没有，
// X 有书签没播放。此前 UI 只会「没值就不显示」，于是用户看到的是一堆参差不齐的行，
// 分不清「这条数据差」「这个平台没有」「我们没采到」——三件完全不同的事长得一模一样。
//
// 【三档，且必须诚实】
//   'yes'    真机确认该页面提供，且解析器已采
//   'no'     真机确认平台公开页**不提供**（如抖音的播放量，只有创作者后台有）
//   'detail' 只有作品详情页有；主页/列表页采不到（如抖音的评论/收藏/转发）
//   'unknown' **还没在真机上确认过**——不许拿它冒充 'no'
//
// ⚠️ 'unknown' 是这张表最重要的一档。把没验过的写成 'no'，就等于对用户断言
// 「这个平台没有这项」，而真相可能是「我们没采到」。宁可说不知道。
export type Availability = 'yes' | 'no' | 'detail' | 'unknown';

/** 各档对应的解释，直接用于 UI 的 title（鼠标悬停能看到为什么是「—」）。 */
export const AVAILABILITY_NOTE: Record<Exclude<Availability, 'yes'>, string> = {
  no: '该平台公开页面不提供这项（通常只有创作者后台才有）',
  detail: '这项只有作品详情页才有——在作品详情页采一次就能补上',
  unknown: '这一项还没在真机上确认过，可能是平台没有、也可能是没采到',
};

type Row = Partial<Record<MetricCountKey, Availability>>;

// 投币与弹幕是 **B站 独有的产品概念**，别的平台根本没有这种东西——
// 这属于「确定没有」而不是「没验过」，所以是 'no' 不是 'unknown'。
// （区别在于：unknown 是「这项可能有，我们没去确认」；这里是平台形态上就不存在。）
const NO_BILI_ONLY: Row = { coins: 'no', danmaku: 'no' };

// 真机校准结论（2026-08-08 ~ 08-11，见 extension/content/*.js 顶部注释与各次会话记录）。
// 改这张表前先去真机上看一眼，别照着印象改。
const MATRIX: Record<string, Row> = {
  // 主页角标是 ♡ 点赞不是 ▷ 播放；详情页给赞/评/藏/转。**播放量公开页从来没有**。
  douyin: { ...NO_BILI_ONLY, views: 'no', likes: 'yes', comments: 'detail', collects: 'detail', shares: 'detail' },
  // 详情页 engage-bar 给点赞/收藏/评论（真机 159/34/122）。没有播放量。
  // 转发：engage-bar 上的分享按钮没见到数字，但没能复验（站点反自动化），先记 unknown。
  // ⚠️ 2026-08-13 更正：评论/收藏此前标成 'yes'，与上面这行注释自相矛盾——它们**只有详情页有**
  //    （extension/content/xhs-note.js:44-46），主页解析器 xhs.js:63 只产 likes。
  //    按本文件开头的图例，这就是 'detail' 的定义。两档的悬停文案都会指向详情页，
  //    所以后果不严重；但 'yes' 那句是「这项该平台有，但**这次没采到**」——它把
  //    「这一页本来就没有」说成了「本该采到却没采到」，对着主页采完的用户是句假话。
  xiaohongshu: { ...NO_BILI_ONLY, views: 'no', likes: 'yes', comments: 'detail', collects: 'detail', shares: 'unknown' },
  // 详情页六项齐全且已真机核对；评论数在 shadow DOM 里懒加载，取到算赚到。
  bilibili: { views: 'yes', likes: 'yes', comments: 'detail', collects: 'yes', shares: 'yes', danmaku: 'yes', coins: 'yes' },
  // 操作栏 aria-label 给精确的回复/转帖/喜欢/书签；浏览量那条 /analytics 链接详情页已经没有了。
  x: { ...NO_BILI_ONLY, views: 'no', likes: 'yes', comments: 'yes', shares: 'yes', collects: 'yes' },
  // 观看数与点赞都能从内联脚本拿到精确值；评论数懒加载，自动化环境里没能确认，best-effort。
  // 收藏/转发 YouTube 不公开计数。
  // ⚠️ 2026-08-13 更正：点赞标 'detail'——它读的是 watch 页 like 按钮的 aria-label
  //    （extension/content/youtube.js:63-71），而频道列表解析器 youtube.js:176 只产 views。
  //    理由同小红书那两项。
  youtube: { ...NO_BILI_ONLY, views: 'yes', likes: 'detail', comments: 'unknown', collects: 'no', shares: 'no' },
  // 公众号走导出导入通道，只带阅读量；在看/点赞等要看导出内容，未逐项核实。
  wechat: { ...NO_BILI_ONLY, views: 'yes', likes: 'unknown', comments: 'unknown', collects: 'no', shares: 'unknown' },
  // 视频号与 TikTok 都还没做过真机校准 —— 整行 unknown，一项都不许断言。
  shipinhao: { ...NO_BILI_ONLY },
  tiktok: { ...NO_BILI_ONLY },
};

/**
 * 这个平台的这项指标是什么状态。表里没写的一律 'unknown'——
 * **缺省不是 'no'**：没列到只说明没人验过，不说明平台没有。
 */
export function availabilityOf(platform: string, key: MetricCountKey): Availability {
  return MATRIX[platform]?.[key] ?? 'unknown';
}

/**
 * 某项拿不到时，给用户看的原因。已经有值时返回 null（不需要解释）。
 * UI 统一用它渲染「—」的 title，三种缺席在鼠标悬停时能被区分开。
 */
export function absenceNote(platform: string, key: MetricCountKey): string {
  const a = availabilityOf(platform, key);
  return a === 'yes' ? '这项该平台有，但这次没采到——去作品详情页重采一次' : AVAILABILITY_NOTE[a];
}

/**
 * 这个平台**值得展示**的指标列表：'no' 的项连位置都不占（抖音永远不会有播放量，
 * 给它留一列「—」只是每行都多一个没用的破折号）。
 * 其余（yes / detail / unknown）都留位，没值就画「—」并说明原因。
 */
export function displayKeys<K extends MetricCountKey>(platform: string, all: readonly K[]): K[] {
  // 泛型是为了把调用方那份更窄的键集合原样带回去（否则会被放宽成 MetricCountKey，
  // 调用方拿它索引自己的行对象就会因为多出 impressions 之类的键而报错）
  return all.filter((k) => availabilityOf(platform, k) !== 'no');
}
