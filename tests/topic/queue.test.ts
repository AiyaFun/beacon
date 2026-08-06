import { describe, it, expect } from 'vitest';
import { resolveQueue, queueQuota, allocateByQueue } from '@/lib/topic/queue';
import type { Candidate } from '@/lib/topic/scoring';

// 三队列时间结构（lib/topic/queue.ts）。
// 这里锁的核心性质只有一条：**配额只改变「选谁」，绝不减少产出**。
// 某一队没货时名额必须回流——否则「今天没有紧急热点」会表现成「今天推荐变少了」，
// 用户看到的是产品坏了，不是市场没货。

const NOW = new Date('2026-07-22T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

function cand(over: Partial<Candidate> = {}): Candidate {
  return { title: 't', heat: 0.5, sourceType: 'douyin', ...over };
}

describe('resolveQueue 归队', () => {
  it('候选源显式声明的队列优先于一切推断', () => {
    // 抢跑候选即便看起来像降温热点，也由源自己说了算
    expect(resolveQueue(cand({ queue: 'today', lifecycle: 'cooling', firstSeenAt: hoursAgo(100) }), NOW)).toBe('today');
    expect(resolveQueue(cand({ queue: 'week', lifecycle: 'rising', firstSeenAt: NOW }), NOW)).toBe('week');
  });

  it('升温中且未过平台窗口一半 → 今日突击', () => {
    // 抖音窗口 36h，一半是 18h
    expect(resolveQueue(cand({ lifecycle: 'rising', firstSeenAt: hoursAgo(2) }), NOW)).toBe('today');
    expect(resolveQueue(cand({ lifecycle: 'peak', firstSeenAt: hoursAgo(17) }), NOW)).toBe('today');
  });

  it('过了窗口一半 → 掉到本周（抢跑价值主要在前半程）', () => {
    expect(resolveQueue(cand({ lifecycle: 'rising', firstSeenAt: hoursAgo(19) }), NOW)).toBe('week');
  });

  it('平台窗口差异被尊重：同样 100 小时，B站还算今日、抖音早就不是', () => {
    // bilibili 窗口 240h（一半 120h）；douyin 36h
    expect(resolveQueue(cand({ sourceType: 'bilibili', lifecycle: 'rising', firstSeenAt: hoursAgo(100) }), NOW)).toBe('today');
    expect(resolveQueue(cand({ sourceType: 'douyin', lifecycle: 'rising', firstSeenAt: hoursAgo(100) }), NOW)).toBe('week');
  });

  it('降温/已凉 → 本周', () => {
    expect(resolveQueue(cand({ lifecycle: 'cooling', firstSeenAt: hoursAgo(1) }), NOW)).toBe('week');
    expect(resolveQueue(cand({ lifecycle: 'faded', firstSeenAt: hoursAgo(1) }), NOW)).toBe('week');
  });

  it('竞对爆款没有硬窗口 → 本周', () => {
    expect(resolveQueue(cand({ sourceType: 'competitor' }), NOW)).toBe('week');
  });

  it('缺生命周期信息 → 本周，绝不贴「今天不做就没了」的假紧迫标', () => {
    expect(resolveQueue(cand({ lifecycle: 'rising' }), NOW)).toBe('week'); // 缺 firstSeenAt
    expect(resolveQueue(cand({ firstSeenAt: NOW }), NOW)).toBe('week'); // 缺 lifecycle
    expect(resolveQueue(cand(), NOW)).toBe('week');
  });
});

describe('queueQuota 名额分配', () => {
  it('今日占多数但不独占——只会追热点的引擎在没热点的日子等于停摆', () => {
    expect(queueQuota(6)).toEqual({ today: 4, week: 2, evergreen: 0 });
    expect(queueQuota(3)).toEqual({ today: 2, week: 1, evergreen: 0 });
  });

  it('topN=1 时把唯一名额给今日突击（有窗口的优先）', () => {
    expect(queueQuota(1)).toEqual({ today: 1, week: 0, evergreen: 0 });
  });

  it('topN=0 不分配', () => {
    expect(queueQuota(0)).toEqual({ today: 0, week: 0, evergreen: 0 });
  });
});

describe('allocateByQueue 选取', () => {
  const today = (i: number) => cand({ title: `today-${i}`, lifecycle: 'rising', firstSeenAt: hoursAgo(1) });
  const week = (i: number) => cand({ title: `week-${i}`, sourceType: 'competitor' });

  it('两队都有货 → 按配额切，本周队不会被今日队全吃掉', () => {
    const ranked = [...Array.from({ length: 10 }, (_, i) => today(i)), ...Array.from({ length: 10 }, (_, i) => week(i))];
    const picked = allocateByQueue(ranked, 6, NOW);
    expect(picked).toHaveLength(6);
    expect(picked.filter((c) => c.title.startsWith('today-'))).toHaveLength(4);
    expect(picked.filter((c) => c.title.startsWith('week-'))).toHaveLength(2);
  });

  it('本周队空 → 名额全部回流今日队，产出条数一条不少', () => {
    const ranked = Array.from({ length: 10 }, (_, i) => today(i));
    const picked = allocateByQueue(ranked, 6, NOW);
    expect(picked).toHaveLength(6); // 不是 4——回流生效
    expect(picked.every((c) => c.title.startsWith('today-'))).toBe(true);
  });

  it('今日队空 → 名额全部回流本周队', () => {
    const ranked = Array.from({ length: 10 }, (_, i) => week(i));
    const picked = allocateByQueue(ranked, 6, NOW);
    expect(picked).toHaveLength(6);
    expect(picked.every((c) => c.title.startsWith('week-'))).toBe(true);
  });

  it('候选不够填满 topN → 全要（配额在这种情况下毫无意义）', () => {
    const ranked = [today(0), week(0)];
    expect(allocateByQueue(ranked, 6, NOW)).toHaveLength(2);
  });

  it('队内按粗排原序取，不打乱顺序', () => {
    const ranked = [...Array.from({ length: 5 }, (_, i) => today(i)), ...Array.from({ length: 5 }, (_, i) => week(i))];
    const picked = allocateByQueue(ranked, 6, NOW);
    // 今日取前 4 条（today-0..3）、本周取前 2 条（week-0..1），且整体保持原序
    expect(picked.map((c) => c.title)).toEqual(['today-0', 'today-1', 'today-2', 'today-3', 'week-0', 'week-1']);
  });

  it('常青候选混进池子也不会挤掉热点名额（它只拿别人没用完的）', () => {
    const ever = Array.from({ length: 5 }, (_, i) => cand({ title: `ever-${i}`, queue: 'evergreen', heat: 0 }));
    const ranked = [...Array.from({ length: 5 }, (_, i) => today(i)), ...ever];
    const picked = allocateByQueue(ranked, 4, NOW);
    expect(picked).toHaveLength(4);
    expect(picked.every((c) => c.title.startsWith('today-'))).toBe(true);
  });

  it('topN 大于全部候选 → 一条不落', () => {
    const ranked = [today(0), today(1), week(0)];
    expect(allocateByQueue(ranked, 99, NOW)).toHaveLength(3);
  });
});
