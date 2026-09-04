export const BUILTIN_SKILL_I18N: Record<string, { name: string; description: string }> = {
  'wechat-format': {
    name: 'WeChat Formatter',
    description: 'Format copy directly for WeChat editor: intro + subheaders, key takeaway cards, quotes, and clean lists.',
  },
  'xiaohongshu-card': {
    name: 'RED Card Formatter',
    description: 'Transform copy into RED posts: catchy hook, emoji formatting, interactive ending question, topic tags, and 3 title candidates.',
  },
  'douyin-spoken': {
    name: 'Douyin Spoken Script',
    description: 'Convert draft into a 60s spoken script: first 3s hook, one sentence per line, [pause]/[emphasis] markers for easy teleprompting.',
  },
  'shipinhao-script': {
    name: 'Channels Video Script',
    description: 'Format draft into video script: opening hook, two-line visual/narration storyboard, section durations, and conversion call-to-action.',
  },
  'zhihu-format': {
    name: 'Zhihu Long-form Formatter',
    description: 'Format into Zhihu analytical articles: upfront conclusion, hierarchical headers, bold key phrases, evidence quotes, and summary.',
  },
  'cover-multi-ratio': {
    name: 'AI Multi-Ratio Cover',
    description: 'One-click cover generation in Studio: automatic aspect ratio per platform (RED 3:4, Douyin 9:16, WeChat 2.35:1), prominent typography.',
  },
};

export function getSkillDisplayName(skill: { slug: string; name: string }, lang: string): string {
  if (lang === 'en' && BUILTIN_SKILL_I18N[skill.slug]) {
    return BUILTIN_SKILL_I18N[skill.slug].name;
  }
  return skill.name;
}

export function getSkillDisplayDesc(skill: { slug: string; description: string }, lang: string): string {
  if (lang === 'en' && BUILTIN_SKILL_I18N[skill.slug]) {
    return BUILTIN_SKILL_I18N[skill.slug].description;
  }
  return skill.description;
}
