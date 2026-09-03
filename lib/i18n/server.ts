import { cookies, headers } from 'next/headers';
import { Lang, DEFAULT_LANG, LANG_COOKIE_KEY, normalizeLang } from './types';
import { getDictionary } from './dict';

export async function getServerLang(): Promise<Lang> {
  try {
    const cookieStore = await cookies();
    const cookieVal = cookieStore.get(LANG_COOKIE_KEY)?.value;
    if (cookieVal) {
      return normalizeLang(cookieVal);
    }
  } catch {
    // 某些静态环境可能无法读取 cookies()
  }

  try {
    const headerStore = await headers();
    const acceptLanguage = headerStore.get('accept-language');
    if (acceptLanguage) {
      const first = acceptLanguage.split(',')[0] || '';
      if (first.toLowerCase().startsWith('en')) {
        return 'en';
      }
    }
  } catch {
    // 忽略
  }

  return DEFAULT_LANG;
}

export async function getServerDictionary() {
  const lang = await getServerLang();
  return { lang, dict: getDictionary(lang) };
}
