import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { competitorSourceStatus } from '@/lib/adapters/registry';

// 「未配置时界面上会显示为数据源未启用」——这句话必须有代码兑现（2026-08-29）。
//
// 【它是怎么被发现的】隐私政策第六节写着这句话，而 `sourceHealthBoard()` 返回的
// competitor 那一半**一处都没渲染过**（设置页只渲染了 hot）。零代码兑现 = 空承诺。
//
// 【为什么它是最伤用户的一类】用户加了竞对、点进去空白，而界面上不说为什么。
// 没有这个功能他不会失望；有入口、点了没数据，他会认为**整个产品坏了**。

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('数据源状态：说了就要显示', () => {
  it('🔒 设置页真的渲染了 competitor 那一半（此前只渲染 hot）', () => {
    const page = read('app/(app)/settings/page.tsx');
    expect(page).toContain('board.competitor.map');
    expect(page).toContain('竞对数据源');
  });

  it('🔒 三态分开说，不合并成一个「未启用」', () => {
    // 「要装插件」他能自己解决，「真的没有」他做什么都没用——
    // 合并等于把能解决的问题说成解决不了的
    const page = read('app/(app)/settings/page.tsx');
    expect(page).toContain('服务端可取');
    expect(page).toContain('要装采集助手');
    expect(page).toContain('暂无数据源');
  });

  it('🔒 「暂无数据源」要说清后果（加了竞对也不会有数据）', () => {
    const page = read('app/(app)/settings/page.tsx');
    expect(page).toContain('加了竞对也不会有数据');
    // 且要说明这不是故障——否则用户会来报障
    expect(page).toContain('不是故障');
  });

  it('判据本身：没配 key 且插件也采不了 → none', () => {
    // 视频号/快手/知乎/头条号/百家号 都不在插件名单里，也没有服务端适配器
    for (const p of ['shipinhao', 'kuaishou', 'zhihu', 'toutiao', 'baijiahao']) {
      expect(competitorSourceStatus(p), `${p} 应该是 none`).toBe('none');
    }
  });

  it('判据本身：插件能采的 → plugin（不是 none）', () => {
    // 测试环境没有任何 key，所以这些落在 plugin 档而不是 server
    for (const p of ['douyin', 'xiaohongshu', 'wechat', 'tiktok']) {
      expect(competitorSourceStatus(p), `${p} 应该是 plugin`).toBe('plugin');
    }
  });

  it('🔒 配上 key 之后要变成 server（判据真的读环境，不是写死的）', () => {
    const prev = process.env.BEACON_TIKHUB_KEY;
    process.env.BEACON_TIKHUB_KEY = 'test-key';
    try {
      expect(competitorSourceStatus('douyin')).toBe('server');
    } finally {
      if (prev === undefined) delete process.env.BEACON_TIKHUB_KEY;
      else process.env.BEACON_TIKHUB_KEY = prev;
    }
  });

  it('🔒 插件名单只有一份（不靠守卫维持两份一致——那是下策）', () => {
    const reg = read('lib/adapters/registry.ts');
    expect(reg).toContain("import { PLUGIN_COLLECTABLE } from '../ingest/competitor'");
    expect(reg).toContain('PLUGIN_COLLECTABLE.has(platform)');
    // 【剥注释再断言】注释里正解释着「原来这里写了一个 PLUGIN_ONLY」——
    // 不剥的话这条被自己的说明绊倒。本会话第 N 次同一形状了。
    const code = reg.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('PLUGIN_ONLY');
  });
});

describe('提示要出现在他会痛的那一刻', () => {
  const form = read('app/(app)/competitors/AddCompetitorForm.tsx');
  const page = read('app/(app)/competitors/page.tsx');

  it('🔒 加竞对时就说清这个平台有没有数据源（不是加完才发现空白）', () => {
    expect(page).toContain('competitorSourceStatus');
    expect(form).toContain("sourceStatus[platform] === 'none'");
    expect(form).toContain('这个平台现在没有数据源');
  });

  it('🔒 但不拦着他加（他可能就是想先记着，等通道开了再采）', () => {
    // 只提示、不 disable 提交按钮、不在 action 里拒绝
    const code = form.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/disabled=\{[^}]*sourceStatus/);
    expect(read('app/(app)/competitors/actions.ts')).not.toContain('competitorSourceStatus');
  });

  it('🔒 「要装插件」与「没有通道」分开说（前者他能自己解决）', () => {
    expect(form).toContain("sourceStatus[platform] === 'plugin'");
    expect(form).toContain('采集助手');
  });

  it('说明这不是故障（否则他会来报障）', () => {
    expect(form).toContain('这不是故障');
  });
});
