'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { Lang, DEFAULT_LANG, LANG_STORAGE_KEY, LANG_COOKIE_KEY, normalizeLang } from './types';
import { getDictionary, Dictionary } from './dict';

interface I18nContextValue {
  lang: Lang;
  dict: Dictionary;
  setLang: (lang: Lang) => void;
}

const I18nContext = createContext<I18nContextValue>({
  lang: DEFAULT_LANG,
  dict: getDictionary(DEFAULT_LANG),
  setLang: () => {},
});

export function I18nProvider({
  initialLang,
  children,
}: {
  initialLang?: Lang;
  children: React.ReactNode;
}) {
  // 服务端通过 cookie 提供 initialLang —— SSR 与客户端首帧使用同一个值，消除「先中文后英文」的闪烁。
  const [lang, setLangState] = useState<Lang>(initialLang || DEFAULT_LANG);

  useEffect(() => {
    if (initialLang) {
      // 服务端已经从 cookie 读到了语言，它是 source of truth。
      // 把 localStorage 同步过来，保证两边一致（避免下次有人直接读 localStorage 拿到旧值）。
      try {
        localStorage.setItem(LANG_STORAGE_KEY, initialLang);
      } catch {
        // 忽略
      }
    } else {
      // 没有从 cookie 拿到 initialLang（例如首次访问），才 fallback 读 localStorage
      try {
        const stored = localStorage.getItem(LANG_STORAGE_KEY);
        if (stored) {
          const normalized = normalizeLang(stored);
          if (normalized !== lang) {
            setLangState(normalized);
            // 同时写回 cookie，下次 SSR 就能直接拿到正确语言
            document.cookie = `${LANG_COOKIE_KEY}=${normalized};path=/;max-age=31536000;SameSite=Lax`;
          }
        }
      } catch {
        // 忽略 localStorage 不可用情况
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setLang = useCallback((nextLang: Lang) => {
    setLangState(nextLang);
    try {
      localStorage.setItem(LANG_STORAGE_KEY, nextLang);
      document.cookie = `${LANG_COOKIE_KEY}=${nextLang};path=/;max-age=31536000;SameSite=Lax`;
      document.documentElement.lang = nextLang === 'en' ? 'en' : 'zh-CN';
    } catch {
      // 忽略
    }
  }, []);

  const dict = getDictionary(lang);

  return (
    <I18nContext.Provider value={{ lang, dict, setLang }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}

export const useLanguage = useI18n;

export function useTranslation() {
  const { lang, dict, setLang } = useI18n();
  return { lang, dict, setLang, t: dict };
}
