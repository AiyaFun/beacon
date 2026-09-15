import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { HOT_SOURCES, HOT_INGEST_INTERVAL_MINUTES } from '@/lib/constants';
import { APP_VERSION } from '@/lib/market/version';
import { generateKnowledgeGraphJsonLd } from '@/lib/geo/json-ld';
import { SCHEDULES } from '@/lib/jobs/schedule-config';
import { PUBLIC_PAGES } from '@/lib/geo/public-surface';
import { intelDict } from '@/lib/i18n/dict/intel';

const read = (p: string) => readFileSync(p, 'utf8');
// 去掉注释行再比：注释里可以写「此前写死 9 大平台」讲缘由，代码/文案里不能再出现
const codeOnly = (src: string) =>
  src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

// 所有对外宣称热榜「几个平台 / 多久更新」的地方。新加一处宣称就加进来。
const CLAIM_FILES = [
  'app/(public)/hotlists/page.tsx',
  'app/(public)/hotlists/HotFitAnalyzer.tsx',
  'app/layout.tsx',
  'lib/geo/json-ld.ts',
  'lib/geo/public-surface.ts',
  'lib/i18n/dict/intel.ts',
  'lib/jobs/schedule-config.ts',
  'components/GlobalAIAssistant.tsx',
];
// 中文「9 大平台 / 九个平台 / 9 源」+ 英文「8 platforms」+ 更新频率「60 秒更新」
const HARDCODED_CLAIM = /([0-9一二三四五六七八九十]+\s*(大|个)?\s*(平台|源)(热榜|实时热榜)?|\b\d+\s+platforms\b|60\s*秒更新)/;

// 2026-09-10 两轮审查：热榜页/帮助页/JSON-LD/站点关键词里的「承诺」与真实产品状态对不上。
// 这些都是文案层的漂移，tsc 和现有单测抓不住，靠源码守卫钉住。
describe('热榜页 · 文案与产品状态一致性守卫', () => {
  it('JSON-LD 的 softwareVersion 跟 APP_VERSION 走，不再手写', () => {
    const graph = generateKnowledgeGraphJsonLd('https://example.com') as { '@graph': Array<Record<string, unknown>> };
    const software = graph['@graph'].find((n) => n['@type'] === 'SoftwareApplication');
    expect(software?.softwareVersion).toBe(APP_VERSION);
    expect(read('lib/geo/json-ld.ts')).not.toMatch(/softwareVersion:\s*'\d/);
  });

  it('「N 大平台 / N platforms / 60 秒更新」不再写死在任何一处宣称里', () => {
    for (const f of CLAIM_FILES) {
      const hit = codeOnly(read(f)).match(HARDCODED_CLAIM);
      expect(hit, `${f} 仍写死了：${hit?.[0]}`).toBeNull();
    }
    // 守卫自身不能空转：正则得真能抓到这几种写法
    for (const bad of ['9 大平台实时热榜', '九个平台的', 'across 8 platforms', '采集 9 源热榜', '公开榜单 60 秒更新', '9大平台实时热榜']) {
      expect(bad, bad).toMatch(HARDCODED_CLAIM);
    }
    // 派生后的写法不能被误伤
    for (const ok of ['${HOT_SOURCES.length} 大平台', '${HOT_SOURCE_COUNT} 个平台', '多平台热榜']) {
      expect(ok, ok).not.toMatch(HARDCODED_CLAIM);
    }
  });

  it('对外宣称的平台数、平台名与更新频率都等于真实配置', () => {
    // 小红书已从 HOT_SOURCES 移除（lib/constants.ts 注释写明无公开热榜），任何宣称都不能再点名它
    expect((HOT_SOURCES as readonly { key: string }[]).some((s) => s.key === 'xiaohongshu')).toBe(false);
    const hot = PUBLIC_PAGES.find((p) => p.path === '/hotlists');
    expect(hot?.desc).toContain(`${HOT_SOURCES.length} 个平台`);
    expect(hot?.desc).toContain(`每 ${HOT_INGEST_INTERVAL_MINUTES} 分钟`);
    expect(hot?.desc).not.toContain('小红书');
    expect(hot?.desc).not.toContain('快手');
    expect(intelDict.zh.pageHint).toContain(`每 ${HOT_INGEST_INTERVAL_MINUTES} 分钟`);
    // worker 的采集 cron 与文案同源
    const ingest = SCHEDULES.find((j) => j.name === 'ingest_hot');
    expect(ingest?.cron).toBe(`*/${HOT_INGEST_INTERVAL_MINUTES} * * * *`);
    expect(ingest?.note).toContain(`${HOT_SOURCES.length} 源`);
    // 只查热榜页：站点级关键词（layout.tsx）里的「小红书运营」说的是发布平台，那是真的
    expect(codeOnly(read('app/(public)/hotlists/page.tsx'))).not.toContain('小红书');
  });

  it('「最近更新」取全表最大 fetchedAt，而不是排序最前那条的时间', () => {
    const page = read('app/(public)/hotlists/page.tsx');
    expect(page).not.toContain('items[0]?.fetchedAt');
    expect(page).toMatch(/it\.fetchedAt > max/);
  });

  it('/genes 已并入 /data?view=genes：站内不再出现指向 /genes 的链接，旧地址有 redirect 兜底', () => {
    expect(read('app/(app)/help/page.tsx')).not.toContain('href="/genes"');
    expect(read('e2e/smoke.spec.ts')).not.toContain("goto('/genes')");
    expect(read('next.config.mjs')).toMatch(/source:\s*'\/genes',\s*destination:\s*'\/data\?view=genes'/);
  });
});
