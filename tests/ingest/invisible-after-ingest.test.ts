import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { prisma } from '@/lib/db';
import { ingestOwnPostData } from '@/lib/ingest/own-post';
import { parseRange, filterRecordsByRange } from '@/lib/insight/dashboard-filter';

// 「插件说回填成功了，可数据看板上什么都没有。」——2026-07-25、07-27 两次真机事故。
//
// 数据看板有两道**完全静默**的过滤，任一命中都是这个现象，而用户看到的只有
// 一句「✓ 已回填 N 条」和一个空页面，没有任何线索区分是哪一种：
//   ① accountId —— 每个查询都是 where accountId = 顶栏当前选中的账号。
//      数据挂在别的账号名下就永远看不见（插件在工作区没有对应平台账号时会自动建号，
//      新数据自然落在那个新号名下，而网页顶栏选的还是老号）。
//   ② 时间范围 —— 默认只看近 30 天。插件现在能读到作品的**真实发表时间**，
//      回填一批老作品，条条都在窗口外，表格就是空的。
//
// 这个文件锁两件事：回填结果必须**说清数据记在谁名下**；上面两种情况都要能被识别出来。

describe('🔒 回填结果必须说清「记在谁名下」', () => {
  let wsId = '';
  let dyId = '';
  let xId = '';

  beforeEach(async () => {
    await prisma.performanceSnapshot.deleteMany();
    await prisma.publishRecord.deleteMany();
    await prisma.creatorAccount.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.tenant.deleteMany();
    const tenant = await prisma.tenant.create({ data: { name: 't' } });
    const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
    wsId = ws.id;
    dyId = (await prisma.creatorAccount.create({ data: { workspaceId: wsId, name: '抖音老号', platform: 'douyin' } })).id;
    xId = (await prisma.creatorAccount.create({ data: { workspaceId: wsId, name: 'Aiya哎呀', platform: 'x' } })).id;
  });

  it('回填结果带上目标账号——只报「已回填 N 条」的话，用户在看板上找不到时无从判断', async () => {
    const r = await ingestOwnPostData(wsId, {
      platform: 'x',
      posts: [{ platformItemId: '111', title: '推文', metrics: { views: 100 } }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.targetAccount).toEqual({ id: xId, name: 'Aiya哎呀' });
    expect(r.targetAccount!.id).not.toBe(dyId); // 顶栏当前多半还停在这个老号上
  });

  it('sw.js 把它写进给用户看的那句话里', () => {
    const noop = () => {};
    const listener = { addListener: noop };
    const context = vm.createContext({
      chrome: {
        runtime: { onInstalled: listener, onStartup: listener, onMessage: listener, getPlatformInfo: noop },
        storage: { sync: { get: () => Promise.resolve({}) }, local: { get: () => Promise.resolve({}) }, onChanged: listener },
        alarms: { onAlarm: listener, create: noop, get: noop, clear: noop },
        tabs: { onRemoved: listener, create: noop, remove: noop, sendMessage: noop },
        action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
        notifications: { create: noop, onClicked: listener },
        contextMenus: { removeAll: noop, create: noop, onClicked: listener },
        sidePanel: { open: noop },
      },
      console, setTimeout, clearTimeout, setInterval, clearInterval, fetch: noop, Date, URL, AbortController,
    });
    vm.runInContext(readFileSync(resolve(process.cwd(), 'extension/sw.js'), 'utf8'), context);
    const summary = context.selfIngestSummary as (d: Record<string, unknown>, p?: string) => { ok: boolean; text: string };

    const s = summary({ created: 6, updated: 0, skipped: 0, targetAccount: { id: 'a', name: 'Aiya哎呀' } }, 'x');
    expect(s.ok).toBe(true);
    expect(s.text).toContain('6 条作品');
    expect(s.text).toContain('Aiya哎呀'); // ← 少了这句，用户就只能对着空看板猜

    // 老版本服务端不回这个字段时不能崩，也不该硬造一个名字
    const old = summary({ created: 6, updated: 0, skipped: 0 }, 'x');
    expect(old.ok).toBe(true);
    expect(old.text).toContain('6 条作品');
    expect(old.text).not.toContain('记在');
  });
});

// ── 看板那两道静默过滤 ──
describe('🔒 数据看板：数据在库里，却不在视图里', () => {
  const DAY = 86_400_000;
  const now = Date.parse('2026-07-27T00:00:00Z');
  const rec = (daysAgo: number) => ({ publishedAt: new Date(now - daysAgo * DAY), platform: 'x' });

  it('默认只看近 30 天：回填的老作品会整批消失（插件现在带的是真实发表时间）', () => {
    const records = [rec(2), rec(60), rec(120), rec(200)];
    expect(parseRange(undefined)).toBe('30d'); // 默认窗口
    expect(filterRecordsByRange(records, '30d', now)).toHaveLength(1);
    // 「有数据但一条都显示不出来」正是要提示用户的那种状态
    expect(filterRecordsByRange([rec(60), rec(120)], '30d', now)).toHaveLength(0);
    expect(filterRecordsByRange([rec(60), rec(120)], 'all', now)).toHaveLength(2);
  });

  it('账号维度：本账号 0 条、别的账号有 —— 这就是「回填成功却看不到」最常见的一种', async () => {
    await prisma.performanceSnapshot.deleteMany();
    await prisma.publishRecord.deleteMany();
    await prisma.creatorAccount.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.tenant.deleteMany();
    const tenant = await prisma.tenant.create({ data: { name: 't' } });
    const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
    const oldAcc = await prisma.creatorAccount.create({ data: { workspaceId: ws.id, name: '抖音老号', platform: 'douyin' } });
    const newAcc = await prisma.creatorAccount.create({ data: { workspaceId: ws.id, name: 'Aiya哎呀', platform: 'x' } });

    await ingestOwnPostData(ws.id, {
      platform: 'x',
      posts: [{ platformItemId: '1', metrics: { views: 1 } }, { platformItemId: '2', metrics: { views: 2 } }],
    });

    // 顶栏停在老号上 → 这一页查出来是 0 条
    expect(await prisma.publishRecord.count({ where: { accountId: oldAcc.id } })).toBe(0);

    // 而页面用来提示「另有数据记在别的账号名下」的那个查询查得到
    const elsewhere = await prisma.publishRecord.groupBy({
      by: ['accountId'],
      where: { accountId: { not: oldAcc.id }, account: { workspaceId: ws.id } },
      _count: { _all: true },
    });
    expect(elsewhere).toHaveLength(1);
    expect(elsewhere[0].accountId).toBe(newAcc.id);
    expect(elsewhere[0]._count._all).toBe(2);
  });
});
