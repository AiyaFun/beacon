import { commonDict } from './common';
import { navDict } from './nav';
import { shellDict } from './shell';
import { desktopDict } from './desktop';
import { runsDict } from './runs';
import type { Lang } from '../types';

export interface Dictionary {
  common: typeof commonDict.zh | typeof commonDict.en;
  nav: typeof navDict.zh | typeof navDict.en;
  shell: typeof shellDict.zh | typeof shellDict.en;
  desktop: typeof desktopDict.zh | typeof desktopDict.en;
  runs: typeof runsDict.zh | typeof runsDict.en;
}

export const dictionaries = {
  zh: {
    common: commonDict.zh,
    nav: navDict.zh,
    shell: shellDict.zh,
    desktop: desktopDict.zh,
    runs: runsDict.zh,
  },
  en: {
    common: commonDict.en,
    nav: navDict.en,
    shell: shellDict.en,
    desktop: desktopDict.en,
    runs: runsDict.en,
  },
};

export function getDictionary(lang: Lang): Dictionary {
  return dictionaries[lang] || dictionaries.zh;
}
