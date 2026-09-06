// 全站唯一的一句话定位（2026-09-05 增长缺口整改）。
//
// 【为什么要收成一处】此前四个入口四种说法：README 是 14 行功能表，登录页轮播说
// 「毫秒级感知竞对爆款」，X 文案说「先知道做什么，再谈怎么写」，/overview 首页标题在讲
// 「整机、Win、Mac」这些部署形态。陌生人 8 秒内拿不到一句能记住的话。
// 只有 X 那一版是从用户痛点出发的，所以全站统一到它：首页、登录页、总览页、README、
// 插件商店描述、桌面客户端启动页，改一处这里就够。
//
// ⚠️ 不许写「毫秒级」「实时监控」这类产品别处处处强调不编数据、却在这儿吹的词。

export const SLOGAN = '先知道做什么，再谈怎么写';
export const SLOGAN_EN = 'Know what to make before you write.';

/** 一句话副标题：说清给谁、每天拿到什么、覆盖哪里。 */
export const SUBLINE = '给持续更新的创作者：每天早上一份带理由的选题推荐，覆盖抖音、小红书、公众号、B 站、视频号。';
export const SUBLINE_EN =
  'For creators who publish every week: a daily topic brief with reasons, across Douyin, Xiaohongshu, WeChat, Bilibili and Channels.';

export const PRODUCT_NAME = '烽火台';
export const PRODUCT_NAME_EN = 'Beacon';
export const PRODUCT_TAGLINE = '跨平台内容作战室';
export const PRODUCT_TAGLINE_EN = 'Cross-platform content command center';

/** 站点根地址（与 robots / sitemap / llms.txt 同一来源）。 */
export function siteUrl(): string {
  return (process.env.BEACON_SITE_URL || process.env.BEACON_PUBLIC_URL || 'https://beacon.iyunci.cn').replace(/\/$/, '');
}
