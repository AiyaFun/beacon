import { platformName } from '../constants';

// 技能目标平台名（**客户端安全**：只依赖纯数据 constants，不引 prisma）。
// 内置多平台走 constants.platformName，技能特有的三个（视频号/知乎/通用）在此补名。
// SkillCenter（client）与 lib/skills/index（server）共用同一份，杜绝各写一份映射。
const EXTRA_PLATFORM_NAMES_ZH: Record<string, string> = { shipinhao: '视频号', zhihu: '知乎', generic: '通用' };
const EXTRA_PLATFORM_NAMES_EN: Record<string, string> = {
  shipinhao: 'Channels',
  zhihu: 'Zhihu',
  generic: 'General',
  wechat: 'WeChat',
  xiaohongshu: 'RED',
  douyin: 'Douyin',
  bilibili: 'Bilibili',
  x: 'X',
  youtube: 'YouTube',
  tiktok: 'TikTok',
};

export function skillPlatformName(key: string, lang: string = 'zh'): string {
  if (lang === 'en') {
    return EXTRA_PLATFORM_NAMES_EN[key] ?? platformName(key);
  }
  return EXTRA_PLATFORM_NAMES_ZH[key] ?? platformName(key);
}

// 创建自定义技能时可选的目标平台（含「不限平台」）。顺序即下拉展示顺序。
export const SKILL_PLATFORM_OPTIONS: { key: string; name: string }[] = [
  { key: 'generic', name: '通用（不限平台）' },
  { key: 'wechat', name: '公众号' },
  { key: 'xiaohongshu', name: '小红书' },
  { key: 'douyin', name: '抖音' },
  { key: 'shipinhao', name: '视频号' },
  { key: 'zhihu', name: '知乎' },
  { key: 'bilibili', name: 'B站' },
  { key: 'x', name: 'X' },
  { key: 'youtube', name: 'YouTube' },
  { key: 'tiktok', name: 'TikTok' },
];
