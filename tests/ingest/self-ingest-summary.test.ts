import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

// sw.js 的 selfIngestSummary：三个入口（popup / SidePanel / 页内侧栏）唯一的措辞来源。
//
// 它存在的理由是一个静默失败：后端对「一个指标都没读到」的作品**直接跳过**
// （lib/ingest/own-post.ts：不建空记录污染基线），于是
//   HTTP 200 + { updated: 0, created: 0, skipped: 9 }
// 是一个完全正常的成功响应。三个入口此前都只看 updated+created，0 条时统一报
// 「✓ 已回填到数据看板」——用户看到勾，去数据看板一看什么都没有，还以为是看板坏了。
// 采到 0 条不是错误，但绝不能报成成功。

const SRC = readFileSync(resolve(process.cwd(), 'extension/sw.js'), 'utf8');

type Summary = { ok: boolean; text: string };

// sw.js 顶层只是一串 addListener，给足桩就能在 vm 里跑起来并取出函数
function loadSummary(): (d: Record<string, unknown>) => Summary {
  const noop = () => {};
  const listener = { addListener: noop };
  const context = vm.createContext({
    chrome: {
      runtime: { onInstalled: listener, onStartup: listener, onMessage: listener, getPlatformInfo: noop },
      storage: { sync: { get: () => Promise.resolve({}) }, local: { get: () => Promise.resolve({}) }, onChanged: listener },
      alarms: { onAlarm: listener, create: noop, get: noop, clear: noop },
      tabs: { onRemoved: listener, onUpdated: listener, create: noop, remove: noop, sendMessage: noop },
      action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
      notifications: { create: noop, onClicked: listener },
      contextMenus: { removeAll: noop, create: noop, onClicked: listener },
      sidePanel: { open: noop },
    },
    console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: noop, Date, URL,
  });
  vm.runInContext(SRC, context);
  return context.selfIngestSummary as (d: Record<string, unknown>) => Summary;
}

const summary = loadSummary();

describe('🔒 selfIngestSummary · 一条都没入库时绝不报成功', () => {
  it('全部被跳过（认出作品但没读到指标）→ ok=false，并说清是「没读到指标」', () => {
    const s = summary({ updated: 0, created: 0, skipped: 9 });
    expect(s.ok).toBe(false);
    expect(s.text).toContain('9 条');
    expect(s.text).toContain('一个指标都没读到');
    expect(s.text).not.toContain('✓');
  });

  it('什么都没有 → ok=false，且不能与「跳过」混为一谈（两种故障修法不同）', () => {
    const s = summary({ updated: 0, created: 0, skipped: 0 });
    expect(s.ok).toBe(false);
    expect(s.text).not.toContain('跳过');
  });

  it('确实入了库 → ok=true 并报条数', () => {
    const s = summary({ updated: 3, created: 2, skipped: 0 });
    expect(s.ok).toBe(true);
    expect(s.text).toContain('5 条作品');
  });

  it('部分入库、部分跳过 → 报成功，但把跳过的条数一并说出来（别让人以为全采到了）', () => {
    const s = summary({ updated: 2, created: 0, skipped: 7 });
    expect(s.ok).toBe(true);
    expect(s.text).toContain('2 条作品');
    expect(s.text).toContain('7 条');
  });

  it('只有账号级数据（停在粉丝/受众分析页）也算有收获', () => {
    const s = summary({ updated: 0, created: 0, skipped: 0, account: { dailyStats: 1, audience: true } });
    expect(s.ok).toBe(true);
    expect(s.text).toContain('粉丝数据');
    expect(s.text).toContain('受众画像');
  });

  it('字段缺失（老版本后端）不炸，按「没读到」处理', () => {
    expect(summary({}).ok).toBe(false);
  });
});
