import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { planCatchUps, runCatchUps, lastSuccessfulRuns, CATCH_UP_MIN_PERIOD_MS, CATCH_UP_MAX_GRACE_MS } from '@/lib/jobs/catch-up';
import { SCHEDULES } from '@/lib/jobs/schedule-config';
import type { JobName, JobQueue, JobPayload } from '@/lib/jobs/types';

// worker 停机期间错过的定时任务补跑一次（2026-09-02）。
// 时刻全用北京时间口径构造（SCHEDULE_TZ），now 用 UTC 写死，免得机器时区把断言带绿。

const daily = [{ name: 'daily_recommend' as JobName, cron: '0 5 * * *' }];
const halfHourly = [{ name: 'ingest_hot' as JobName, cron: '*/30 * * * *' }];
const weekly = [{ name: 'weekly_review' as JobName, cron: '0 8 * * 1' }];

/** 北京 2026-09-02 的某一时刻 → UTC Date */
const bj = (h: number, m = 0, day = 2) => new Date(Date.UTC(2026, 8, day, h - 8, m));

describe('planCatchUps', () => {
  it('05:00 没跑、05:10 起来：补', () => {
    const p = planCatchUps(daily, new Map([['daily_recommend', bj(5, 0, 1)]]), bj(5, 10));
    expect(p.map((x) => x.name)).toEqual(['daily_recommend']);
    expect(p[0].missedAt.getTime()).toBe(bj(5, 0).getTime());
  });

  it('那次已经跑过了（JobRun 的时刻 ≥ 应跑时刻）：不补', () => {
    expect(planCatchUps(daily, new Map([['daily_recommend', bj(5, 0)]]), bj(5, 10))).toEqual([]);
    expect(planCatchUps(daily, new Map([['daily_recommend', bj(5, 3)]]), bj(5, 10))).toEqual([]);
  });

  it('从来没跑过（新装）：在宽限窗内也补一次', () => {
    expect(planCatchUps(daily, new Map([['daily_recommend', null]]), bj(6, 0))).toHaveLength(1);
  });

  it(`错过太久（超过宽限窗 ${CATCH_UP_MAX_GRACE_MS / 3_600_000} 小时）：让它过去`, () => {
    expect(planCatchUps(daily, new Map([['daily_recommend', bj(5, 0, 1)]]), bj(11, 1))).toEqual([]);
    expect(planCatchUps(daily, new Map([['daily_recommend', bj(5, 0, 1)]]), bj(10, 59))).toHaveLength(1);
  });

  it(`周期短于 ${CATCH_UP_MIN_PERIOD_MS / 3_600_000} 小时的不补（下一跳马上就来）`, () => {
    expect(planCatchUps(halfHourly, new Map([['ingest_hot', null]]), bj(5, 5))).toEqual([]);
  });

  it('周任务：周一 08:00 没跑、周一 13:00 起来补；周二起来不补', () => {
    // 2026-09-07 是周一
    const monday13 = new Date(Date.UTC(2026, 8, 7, 13 - 8));
    const tuesday9 = new Date(Date.UTC(2026, 8, 8, 9 - 8));
    expect(planCatchUps(weekly, new Map([['weekly_review', null]]), monday13)).toHaveLength(1);
    expect(planCatchUps(weekly, new Map([['weekly_review', null]]), tuesday9)).toEqual([]);
  });

  it('只补最近那次，不补积压：停机三天的每日任务也只出一条', () => {
    const p = planCatchUps(daily, new Map([['daily_recommend', bj(5, 0, -1)]]), bj(5, 30));
    expect(p).toHaveLength(1);
  });

  it('真实的 SCHEDULES 全表都解析得了（解析不了会静默不补）', () => {
    const now = bj(5, 1);
    const lastOk = new Map<JobName, Date | null>(SCHEDULES.map((s) => [s.name, null]));
    const p = planCatchUps(SCHEDULES, lastOk, now);
    // 05:00 的 daily_recommend 与 04:00 的 purge_retention 都在宽限窗内；分钟级的都不在
    expect(p.map((x) => x.name)).toContain('daily_recommend');
    expect(p.map((x) => x.name)).toContain('purge_retention');
    expect(p.map((x) => x.name)).not.toContain('ingest_hot');
    expect(p.map((x) => x.name)).not.toContain('push_daily_brief');
  });
});

describe('runCatchUps 走真库、真入队', () => {
  beforeEach(async () => { await prisma.jobRun.deleteMany(); });

  function fakeQueue() {
    const enqueued: JobName[] = [];
    const q: JobQueue = {
      kind: 'inprocess',
      register() {},
      async enqueue(name: JobName, _payload?: JobPayload) { enqueued.push(name); },
      async schedule() {},
      async resetSchedules() { return 0; },
      async close() {},
    };
    return { q, enqueued };
  }

  it('JobRun 里最近一次 ok 的时刻决定补不补', async () => {
    const { q, enqueued } = fakeQueue();
    // 昨天 05:00 跑过，今天 05:00 没跑，05:20 起来
    await prisma.jobRun.create({ data: { name: 'daily_recommend', track: 'batch_tenant', status: 'ok', startedAt: bj(5, 0, 1) } });
    const done = await runCatchUps(q, bj(5, 20));
    expect(done).toContain('daily_recommend');
    expect(enqueued).toContain('daily_recommend');
  });

  it('今天 05:00 跑过就不补（失败的那次不算跑过）', async () => {
    const { q, enqueued } = fakeQueue();
    await prisma.jobRun.create({ data: { name: 'daily_recommend', track: 'batch_tenant', status: 'ok', startedAt: bj(5, 0) } });
    await prisma.jobRun.create({ data: { name: 'purge_retention', track: 'broadcast', status: 'failed', startedAt: bj(4, 0) } });
    await runCatchUps(q, bj(5, 20));
    expect(enqueued).not.toContain('daily_recommend');
    expect(enqueued).toContain('purge_retention'); // 04:00 那次失败了=没成功跑过，且在宽限窗内
  });

  it('lastSuccessfulRuns 取的是最大值（批租户型每个租户一行）', async () => {
    await prisma.jobRun.create({ data: { name: 'daily_recommend', track: 'batch_tenant', status: 'ok', startedAt: bj(5, 0, 1), tenantId: 'a' } });
    await prisma.jobRun.create({ data: { name: 'daily_recommend', track: 'batch_tenant', status: 'ok', startedAt: bj(5, 2), tenantId: 'b' } });
    const m = await lastSuccessfulRuns(['daily_recommend', 'weekly_review']);
    expect(m.get('daily_recommend')?.getTime()).toBe(bj(5, 2).getTime());
    expect(m.get('weekly_review')).toBeNull();
  });
});

describe('接进了 worker', () => {
  it('worker.ts 在注册定时之后调了 runCatchUps（写了没接=功能不存在）', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('worker.ts', 'utf8');
    const reg = src.indexOf('q.schedule(');
    const call = src.indexOf('runCatchUps(');
    expect(reg).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(reg);
  });
  it('cron-parser 是直接依赖，不是靠 bullmq 带进来的', async () => {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['cron-parser']).toBeTruthy();
  });
});
