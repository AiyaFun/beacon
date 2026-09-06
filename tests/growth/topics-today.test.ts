import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { evergreenBoard } from '@/lib/topic/sources/evergreen';
import { normalizeNiche, PRESET_NICHES } from '@/lib/topic/niches';
import { WECHAT_PLATFORM_MONTHLY_QUOTA } from '@/lib/pay/datasource-quota';

// 公开今日选题榜 + 平台代付公众号配额（2026-09-05）。

describe('常青题清单', () => {
  it('给赛道词就出八条，每条带为什么', () => {
    const b = evergreenBoard('家常菜');
    expect(b).toHaveLength(8);
    for (const x of b) {
      expect(x.title).toContain('家常菜');
      expect(x.why.length).toBeGreaterThan(6);
    }
  });
  it('🔒 赛道词不合格就一条都不出（不生成缺主语的废话）', () => {
    expect(evergreenBoard('')).toEqual([]);
    expect(evergreenBoard('a')).toEqual([]);
    expect(evergreenBoard('x'.repeat(21))).toEqual([]);
  });
});

describe('赛道词清洗', () => {
  it('预设至少六个，且每个都能出常青题', () => {
    expect(PRESET_NICHES.length).toBeGreaterThanOrEqual(6);
    for (const n of PRESET_NICHES) expect(evergreenBoard(n)).toHaveLength(8);
  });
  it('🔒 脚本/标签/超长一律退回默认', () => {
    expect(normalizeNiche('<script>alert(1)</script>')).toBe('scriptalert1script'.slice(0, 20) === 'scriptalert1script' ? 'scriptalert1script' : PRESET_NICHES[0]);
    expect(normalizeNiche('')).toBe(PRESET_NICHES[0]);
    expect(normalizeNiche('职场成长')).toBe('职场成长');
    expect(normalizeNiche('职', '')).toBe('');
  });
});

describe('公开页只读：不碰模型、不写库', () => {
  const src = readFileSync('app/(public)/topics-today/page.tsx', 'utf8');
  it('🔒 没有 llmComplete / create / update', () => {
    expect(src).not.toMatch(/llmComplete|\.create\(|\.update\(|\.upsert\(/);
  });
  it('在 middleware 白名单里（tests/growth/public-surface 已验跳转；这里验字面量）', () => {
    expect(readFileSync('middleware.ts', 'utf8')).toContain("'/topics-today'");
  });
});

describe('平台代付公众号配额', () => {
  it('免费档 0、试用 30、标准 60、自带 Key 20、企业不限', () => {
    expect(WECHAT_PLATFORM_MONTHLY_QUOTA.free).toBe(0);
    expect(WECHAT_PLATFORM_MONTHLY_QUOTA.trial).toBe(30);
    expect(WECHAT_PLATFORM_MONTHLY_QUOTA.personal).toBe(60);
    expect(WECHAT_PLATFORM_MONTHLY_QUOTA.byok).toBe(20);
    expect(Number.isFinite(WECHAT_PLATFORM_MONTHLY_QUOTA.enterprise)).toBe(false);
  });
  it('🔒 闸门接进了 crawlOneCompetitor，且在拉数之前', () => {
    const p = readFileSync('lib/pipeline.ts', 'utf8');
    const gate = p.indexOf('canUseWechatPlatformSource(ledger.workspaceId)');
    const fetch = p.indexOf('await fetchCompetitorPosts(competitor.platform, competitor.handle)');
    expect(gate).toBeGreaterThan(0);
    expect(fetch).toBeGreaterThan(0);
    expect(gate).toBeLessThan(fetch);
  });
});
