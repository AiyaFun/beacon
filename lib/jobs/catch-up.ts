import parser from 'cron-parser';
import { prisma } from '../db';
import { createLogger } from '../logger';
import { SCHEDULES, SCHEDULE_TZ } from './schedule-config';
import type { JobName, JobQueue } from './types';

const log = createLogger({ module: 'job-catch-up' });

// ── worker 停机期间错过的定时任务，补跑一次（2026-09-02，学自 Hermes cron/jobs.py 的漏跑策略）──
//
// 【原来是怎么丢的】BullMQ 的 repeat 任务由上一次执行完成时排下一次；worker 在到点那一刻
// 没活着，那次就留在 delayed 里等。**但 worker 每次启动先清后注册**（见 worker.ts，
// 那是为了修「改了 cron 新老双跑」）——清的时候把那条还没跑的 delayed 一并清掉了，
// 于是「05:00 生成今日推荐」在 04:50 部署、05:10 起来的这一天**整天没有推荐**，
// 晨报 09:00 照常推出去，是空的。没有任何报错：JobRun 里只是少了一行。
//
// 【补什么、不补什么】
//   · 只补**周期 ≥ 6 小时**的：每日/每周/每 6 小时那几条。半小时一跑的热榜采集下一跳马上就来，
//     补它只是多跑一次。
//   · 只补**宽限窗内**的：错过那次的时刻距现在不超过「半个周期、最多 6 小时」。
//     周报周一 08:00 没跑、周三才发现，补出来的已经不是「上周」那份了；宁可不补。
//   · **补一次，不补积压**：停机三天，每日任务也只补最近那次。三份积压一起跑是对昨天的
//     数据重复算三遍，还会把队列堵住。
//   · 一次性 / 事件型任务（run_agent_loop）根本不在 SCHEDULES 里，与这里无关。
//
// 【整机版刻意不做】lib/jobs/local-scheduler.ts 写明「错过的那一轮不补跑」，理由是
// 整机版跑的是用户自己的额度（BYOK），开机突然被扣掉昨天那几笔他会莫名其妙。
// 这里只在 BullMQ（SaaS/私有化）这条路上补：批任务由系统买单，用户看到的只是「晨报有内容」。
//
// 【判「跑没跑过」的依据】JobRun 表：每条定时任务经 withRun 记一行，status=ok 的最近一次
// startedAt ≥ 那个应跑时刻，就是跑过了。批租户型任务每个租户记一行，取最大值同样成立。

/** 周期短于这个数的不补（下一跳很快就来）。 */
export const CATCH_UP_MIN_PERIOD_MS = 6 * 3_600_000;
/** 宽限窗上限：错过太久的那一次就让它过去。 */
export const CATCH_UP_MAX_GRACE_MS = 6 * 3_600_000;

export type CatchUpPlan = { name: JobName; missedAt: Date; periodMs: number };

/** 纯函数：给定「上次成功时刻」表，算出这一刻该补哪些。 */
export function planCatchUps(
  schedules: readonly { name: JobName; cron: string }[],
  lastOk: ReadonlyMap<JobName, Date | null>,
  now: Date = new Date(),
  tz: string = SCHEDULE_TZ,
): CatchUpPlan[] {
  const out: CatchUpPlan[] = [];
  for (const s of schedules) {
    let prev: Date; let prev2: Date;
    try {
      const it = parser.parseExpression(s.cron, { currentDate: now, tz });
      prev = it.prev().toDate();
      prev2 = it.prev().toDate();
    } catch {
      continue; // 解析不了的表达式不猜；注册那边会另外报
    }
    const periodMs = prev.getTime() - prev2.getTime();
    if (periodMs < CATCH_UP_MIN_PERIOD_MS) continue;
    const grace = Math.min(periodMs / 2, CATCH_UP_MAX_GRACE_MS);
    if (now.getTime() - prev.getTime() > grace) continue; // 错过太久，让它过去
    const last = lastOk.get(s.name) ?? null;
    if (last && last.getTime() >= prev.getTime()) continue; // 那次跑过了
    out.push({ name: s.name, missedAt: prev, periodMs });
  }
  return out;
}

/** 查 JobRun 得到每条任务最近一次成功的开始时刻。 */
export async function lastSuccessfulRuns(names: readonly JobName[]): Promise<Map<JobName, Date | null>> {
  const rows = await prisma.jobRun.groupBy({
    by: ['name'],
    where: { name: { in: [...names] }, status: 'ok' },
    _max: { startedAt: true },
  });
  const m = new Map<JobName, Date | null>();
  for (const n of names) m.set(n, null);
  for (const r of rows) m.set(r.name as JobName, r._max.startedAt);
  return m;
}

/** worker 启动、注册完定时之后调：把停机期间错过的那几条各补跑一次。返回补了哪些。 */
export async function runCatchUps(queue: JobQueue, now: Date = new Date()): Promise<JobName[]> {
  const names = SCHEDULES.map((s) => s.name);
  const lastOk = await lastSuccessfulRuns(names);
  const plans = planCatchUps(SCHEDULES, lastOk, now);
  const done: JobName[] = [];
  for (const p of plans) {
    try {
      await queue.enqueue(p.name, {});
      done.push(p.name);
      log.info('补跑停机期间错过的定时任务', { jobName: p.name, missedAt: p.missedAt.toISOString() });
    } catch (e) {
      log.error('补跑入队失败', { jobName: p.name, err: e });
    }
  }
  return done;
}
