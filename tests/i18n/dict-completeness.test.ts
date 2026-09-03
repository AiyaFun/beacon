import { describe, it, expect } from 'vitest';
import { dictionaries, getDictionary } from '@/lib/i18n/dict';
import { normalizeLang } from '@/lib/i18n/types';
import { NAV } from '@/lib/nav';

describe('i18n 词典完整性与规范', () => {
  it('normalizeLang 能够正确识别与标准化语言', () => {
    expect(normalizeLang('zh')).toBe('zh');
    expect(normalizeLang('zh-CN')).toBe('zh');
    expect(normalizeLang('en')).toBe('en');
    expect(normalizeLang('en-US')).toBe('en');
    expect(normalizeLang('EN_GB')).toBe('en');
    expect(normalizeLang(null)).toBe('zh');
    expect(normalizeLang(undefined)).toBe('zh');
    expect(normalizeLang('')).toBe('zh');
  });

  it('getDictionary 缺省回退到中文', () => {
    const d = getDictionary('zh');
    expect(d.common.save).toBe('保存');
    const en = getDictionary('en');
    expect(en.common.save).toBe('Save');
  });

  it('NAV 中每一个路由项都在 navDict 英文翻译表中存在且非空', () => {
    const enItems = dictionaries.en.nav.items as Record<string, { label: string; hint?: string }>;
    for (const group of NAV) {
      for (const item of group.items) {
        const trans = enItems[item.href];
        expect(trans, `导航项 ${item.href} (${item.label}) 缺失英文翻译`).toBeDefined();
        expect(trans.label.trim().length, `导航项 ${item.href} 英文 label 为空`).toBeGreaterThan(0);
      }
    }
  });

  it('navDict 分组英文翻译完整', () => {
    expect(dictionaries.en.nav.groups.today).toBe('Today');
    expect(dictionaries.en.nav.groups.content).toBe('Content Hub');
    expect(dictionaries.en.nav.groups.settings).toBe('Settings');
  });

  it('shell 核心文案英文翻译非空', () => {
    expect(dictionaries.en.shell.logout).toBe('Log Out');
    expect(dictionaries.en.shell.freePlan).toBe('Free Plan');
    expect(dictionaries.en.shell.recentTasks).toBe('Recent Tasks');
  });

  it('desktop 核心文案英文翻译非空', () => {
    expect(dictionaries.en.desktop.downloadTitle).toBe('Download Installers');
    expect(dictionaries.en.desktop.pageTitle).toBe('Desktop Client & Appliance');
  });
});
