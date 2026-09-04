import { commonDict } from './common';
import { navDict } from './nav';
import { shellDict } from './shell';
import { desktopDict } from './desktop';
import { runsDict } from './runs';
import { tabsDict } from './tabs';
import { intelDict } from './intel';
import { todayDict } from './today';
import { competitorsDict } from './competitors';
import { libraryDict } from './library';
import { topicsDict } from './topics';
import { studioDict } from './studio';
import { dataDict } from './data';
import { assetsDict } from './assets';
import { complianceDict } from './compliance';
import { assistantDict } from './assistant';
import { settingsDict } from './settings';
import type { Lang } from '../types';

export interface Dictionary {
  common: typeof commonDict.zh | typeof commonDict.en;
  nav: typeof navDict.zh | typeof navDict.en;
  shell: typeof shellDict.zh | typeof shellDict.en;
  desktop: typeof desktopDict.zh | typeof desktopDict.en;
  runs: typeof runsDict.zh | typeof runsDict.en;
  tabs: typeof tabsDict.zh | typeof tabsDict.en;
  intel: typeof intelDict.zh | typeof intelDict.en;
  today: typeof todayDict.zh | typeof todayDict.en;
  competitors: typeof competitorsDict.zh | typeof competitorsDict.en;
  library: typeof libraryDict.zh | typeof libraryDict.en;
  topics: typeof topicsDict.zh | typeof topicsDict.en;
  studio: typeof studioDict.zh | typeof studioDict.en;
  data: typeof dataDict.zh | typeof dataDict.en;
  assets: typeof assetsDict.zh | typeof assetsDict.en;
  compliance: typeof complianceDict.zh | typeof complianceDict.en;
  assistant: typeof assistantDict.zh | typeof assistantDict.en;
  settings: typeof settingsDict.zh | typeof settingsDict.en;
}

export const dictionaries = {
  zh: {
    common: commonDict.zh,
    nav: navDict.zh,
    shell: shellDict.zh,
    desktop: desktopDict.zh,
    runs: runsDict.zh,
    tabs: tabsDict.zh,
    intel: intelDict.zh,
    today: todayDict.zh,
    competitors: competitorsDict.zh,
    library: libraryDict.zh,
    topics: topicsDict.zh,
    studio: studioDict.zh,
    data: dataDict.zh,
    assets: assetsDict.zh,
    compliance: complianceDict.zh,
    assistant: assistantDict.zh,
    settings: settingsDict.zh,
  },
  en: {
    common: commonDict.en,
    nav: navDict.en,
    shell: shellDict.en,
    desktop: desktopDict.en,
    runs: runsDict.en,
    tabs: tabsDict.en,
    intel: intelDict.en,
    today: todayDict.en,
    competitors: competitorsDict.en,
    library: libraryDict.en,
    topics: topicsDict.en,
    studio: studioDict.en,
    data: dataDict.en,
    assets: assetsDict.en,
    compliance: complianceDict.en,
    assistant: assistantDict.en,
    settings: settingsDict.en,
  },
};

export function getDictionary(lang: Lang): Dictionary {
  return dictionaries[lang] || dictionaries.zh;
}
