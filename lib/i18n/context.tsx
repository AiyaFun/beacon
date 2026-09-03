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
  const [lang, setLangState] = useState<Lang>(initialLang || DEFAULT_LANG);

  useEffect(() => {
    // 客户端挂载后优先读 localStorage
    try {
      const stored = localStorage.getItem(LANG_STORAGE_KEY);
      if (stored) {
        const normalized = normalizeLang(stored);
        if (normalized !== lang) {
          setLangState(normalized);
        }
      }
    } catch {
      // 忽略 localStorage 不可用情况
    }
  }, []);

  const setLang = useCallback((nextLang: Lang) => {
    setLangState(nextLang);
    try {
      localStorage.setItem(LANG_STORAGE_KEY, nextLang);
      document.cookie = `${LANG_COOKIE_KEY}=${nextLang};path=/;max-age=31536000;SameSite=Lax`;
      if (typeof document !== 'undefined') {
        document.documentElement.lang = nextLang === 'en' ? 'en' : 'zh-CN';
      }
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

export function useTranslation() {
  const { lang, dict, setLang } = useI18n();
  return { lang, dict, setLang, t: dict };
}
