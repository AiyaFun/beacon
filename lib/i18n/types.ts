export type Lang = 'zh' | 'en';

export const SUPPORTED_LANGS: Lang[] = ['zh', 'en'];
export const DEFAULT_LANG: Lang = 'zh';

export const LANG_STORAGE_KEY = 'beacon.lang';
export const LANG_COOKIE_KEY = 'beacon_lang';

export function normalizeLang(raw?: string | null): Lang {
  if (!raw) return DEFAULT_LANG;
  const lower = raw.trim().toLowerCase();
  if (lower.startsWith('en')) return 'en';
  return 'zh';
}
