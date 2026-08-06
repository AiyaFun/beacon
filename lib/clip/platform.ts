import { PLATFORMS } from '../constants';

// 资讯链接 → 平台，以及「服务器能不能直接抓到这条链接的正文」。
//
// 【为什么要把「能不能抓」写成常量表】
// 这不是可以试试看的事：小红书/抖音的正文是浏览器里跑 JS 渲染的、微信对机房 IP 返回验证页——
// 服务端去抓**必然**失败。与其每次都走一遍抓取、超时、解析空、再报错（慢且看起来像 bug），
// 不如一开始就告诉用户「这个平台得用插件/粘正文」，把 10 秒的等待和一次困惑省掉。
// 表里 canFetch=true 的也只是「通常可以」，抓不到照样有 detectWall 的兜底文案。

export type LinkPlatform = {
  /** 与 lib/constants.PLATFORMS 对齐的 key；认不出的站点为 null（仍可抓，只是不标平台） */
  key: string | null;
  name: string;
  /** 服务器直连能不能拿到正文 */
  canFetch: boolean;
  /** canFetch=false 时告诉用户该怎么办 */
  hint?: string;
};

const PLUGIN_HINT = '这个平台的正文服务器抓不到（登录态/JS 渲染/反爬）。用采集助手在浏览器里打开这条内容一键存入资讯库，或把正文直接粘给我。';

const RULES: { re: RegExp; platform: LinkPlatform }[] = [
  // ── 服务器抓不到的（国内平台基本都在这一档）──
  { re: /(^|\.)mp\.weixin\.qq\.com/i, platform: { key: 'wechat', name: '微信公众号', canFetch: false, hint: '微信对服务器直接访问返回验证页。把正文粘给我，或用采集助手在浏览器里存。' } },
  { re: /(^|\.)xiaohongshu\.com|xhslink\.com/i, platform: { key: 'xiaohongshu', name: '小红书', canFetch: false, hint: PLUGIN_HINT } },
  { re: /(^|\.)douyin\.com|iesdouyin\.com/i, platform: { key: 'douyin', name: '抖音', canFetch: false, hint: PLUGIN_HINT } },
  { re: /(^|\.)toutiao\.com|toutiaocdn\.com/i, platform: { key: null, name: '头条号', canFetch: false, hint: PLUGIN_HINT } },
  { re: /(^|\.)zhihu\.com/i, platform: { key: null, name: '知乎', canFetch: false, hint: PLUGIN_HINT } },
  { re: /(^|\.)(x|twitter)\.com/i, platform: { key: 'x', name: 'X', canFetch: false, hint: 'X 未登录看不到正文。用采集助手在浏览器里存，或把正文粘给我。' } },
  { re: /(^|\.)(youtube\.com|youtu\.be)/i, platform: { key: 'youtube', name: 'YouTube', canFetch: false, hint: '视频页正文是简介与字幕，服务器直连拿不全。用采集助手在浏览器里存最稳。' } },
  { re: /(^|\.)bilibili\.com|b23\.tv/i, platform: { key: 'bilibili', name: 'B站', canFetch: false, hint: '视频页正文是简介，服务器直连拿不全。用采集助手在浏览器里存，或把简介/文稿粘给我。' } },
  // TikTok：正文是 JS 渲染的，且境内服务器根本够不到（与 X/YouTube 同一档）。
  { re: /(^|\.)tiktok\.com/i, platform: { key: 'tiktok', name: 'TikTok', canFetch: false, hint: 'TikTok 正文是浏览器里渲染的，境内服务器也直连不到。用采集助手在浏览器里存，或把文案粘给我。' } },
  { re: /(^|\.)weibo\.(com|cn)/i, platform: { key: null, name: '微博', canFetch: false, hint: PLUGIN_HINT } },
  { re: /(^|\.)kuaishou\.com/i, platform: { key: null, name: '快手', canFetch: false, hint: PLUGIN_HINT } },

  // ── 服务器通常能抓的（普通网页/博客/新闻站/开发者站点）──
  { re: /(^|\.)(36kr|huxiu|geekpark|infoq|sspai|ifanr|leiphone)\.com/i, platform: { key: null, name: '资讯站', canFetch: true } },
  { re: /(^|\.)(github|medium|substack|notion|juejin|csdn|cnblogs|segmentfault)\.(com|io|site)/i, platform: { key: null, name: '技术站', canFetch: true } },
];

export function platformOfLink(url: string): LinkPlatform {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { key: null, name: '网页', canFetch: true };
  }
  for (const r of RULES) if (r.re.test(host)) return r.platform;
  return { key: null, name: '网页', canFetch: true };
}

/** 存进资讯库时用的 platform 值（必须是 PLATFORMS 里的 key，否则不存）。 */
export function storablePlatform(url: string): string | null {
  const p = platformOfLink(url).key;
  return p && p in PLATFORMS ? p : null;
}
