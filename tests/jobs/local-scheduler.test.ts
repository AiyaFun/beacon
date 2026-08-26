import { describe, it, expect, vi, afterEach } from 'vitest';
import { cronDueAt } from '@/lib/jobs/local-scheduler';
import { SCHEDULES } from '@/lib/jobs/schedule-config';
import { backgroundSchedulerRuns, schedulerKind } from '@/lib/jobs/queue';

// 整机版的定时：跑在 web 进程里（BEACON_QUEUE=local）。
//
// 【它补的是什么】此前定时只有 BullMQ 那条路有，而整机版只起一个 next start、
// 没有 Redis 也没有 worker——「每天自动跑一遍」在整机版上**整个不存在**。
// 那不是降级，是一整块能力缺席，而 appliance 与 private 的能力面本该一致。
//
// 【这份用例守的两件事】
//   ① 那个简易 cron 解析器**认得项目里真实用到的每一条 cron**——认不得就该明确不跑，
//      而不是猜一个（悄悄跑成「每分钟一次」比不跑坏得多）；
//   ② 三档形态的判据不出错：local 与 bullmq 都算「会跑」，别的都算「不跑」。

afterEach(() => vi.unstubAllEnvs());

describe('cron 解析：认得项目里每一条真实 cron', () => {
  it('SCHEDULES 里的每一条都解析得了（解析不了 = 那条任务在整机版上永远不跑）', () => {
    // 这条第一次就抓到一个真缺口：周报是 `0 8 * * 1`（每周一），
    // 而第一版解析器压根不认星期——那份周报会永远不来，还不报错
    for (const s of SCHEDULES) {
      const r = cronDueAt(s.cron, 0, 1);
      expect(r, `本地调度器读不懂「${s.name}」的 cron：${s.cron}`).not.toBeNull();
    }
  });

  it('按星期跑的那条：只在指定那天为真', () => {
    const mondayEight = 8 * 60;
    expect(cronDueAt('0 8 * * 1', mondayEight, 1), '周一该跑').toBe(true);
    expect(cronDueAt('0 8 * * 1', mondayEight, 2), '周二不该跑').toBe(false);
    expect(cronDueAt('0 8 * * 1', mondayEight, 0), '周日不该跑').toBe(false);
    // 星期对了但时刻不对，同样不跑
    expect(cronDueAt('0 8 * * 1', mondayEight + 1, 1)).toBe(false);
  });

  it('要按星期判却没给星期 → null（不猜，宁可不跑）', () => {
    expect(cronDueAt('0 8 * * 1', 8 * 60)).toBeNull();
  });

  it('每 30 分钟：只在 0 分和 30 分为真', () => {
    expect(cronDueAt('*/30 * * * *', 0)).toBe(true);
    expect(cronDueAt('*/30 * * * *', 30)).toBe(true);
    expect(cronDueAt('*/30 * * * *', 29)).toBe(false);
    // 跨小时也要对：10:30 是第 630 分钟
    expect(cronDueAt('*/30 * * * *', 630)).toBe(true);
  });

  it('固定时刻：05:00 只在 05:00 那一分钟为真', () => {
    const at5 = 5 * 60;
    expect(cronDueAt('0 5 * * *', at5)).toBe(true);
    expect(cronDueAt('0 5 * * *', at5 + 1)).toBe(false);
    expect(cronDueAt('0 5 * * *', 0), '半夜零点不该跑 05:00 那条').toBe(false);
  });

  it('逗号列表：5,35 分', () => {
    expect(cronDueAt('5,35 * * * *', 5)).toBe(true);
    expect(cronDueAt('5,35 * * * *', 35)).toBe(true);
    expect(cronDueAt('5,35 * * * *', 6)).toBe(false);
  });

  it('每 2 小时：只在偶数小时的 0 分', () => {
    expect(cronDueAt('0 */2 * * *', 0)).toBe(true);
    expect(cronDueAt('0 */2 * * *', 2 * 60)).toBe(true);
    expect(cronDueAt('0 */2 * * *', 3 * 60), '奇数小时不该跑').toBe(false);
    expect(cronDueAt('0 */2 * * *', 2 * 60 + 1), '整点之外不该跑').toBe(false);
  });

  it('看不懂的写法返回 null（= 不跑并告警），绝不猜成「每分钟」', () => {
    // 猜错的代价：一条本该每天一次的任务变成一分钟一次，用户一天被扣 1440 次额度
    for (const weird of ['0 5 1 * *', '@daily', '0-30 * * * *', '', '0 5 * *']) {
      expect(cronDueAt(weird, 300, 1), `「${weird}」不该被猜成能跑`).toBeNull();
    }
  });
});

describe('三档形态的判据', () => {
  it('local 与 bullmq 都算「定时会跑」', () => {
    vi.stubEnv('BEACON_QUEUE', 'local');
    expect(backgroundSchedulerRuns()).toBe(true);
    expect(schedulerKind()).toBe('local');

    vi.stubEnv('BEACON_QUEUE', 'bullmq');
    expect(backgroundSchedulerRuns()).toBe(true);
    expect(schedulerKind()).toBe('bullmq');
  });

  it('不设 / inprocess 一律算「不跑」——界面要照实说', () => {
    vi.stubEnv('BEACON_QUEUE', '');
    expect(backgroundSchedulerRuns()).toBe(false);
    expect(schedulerKind()).toBe('none');

    vi.stubEnv('BEACON_QUEUE', 'inprocess');
    expect(backgroundSchedulerRuns()).toBe(false);
  });
});

describe('整机版装机脚本把这一档设上了', () => {
  it('两个平台的安装脚本都写了 BEACON_QUEUE=local', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    for (const p of ['deploy/appliance/install.sh', 'deploy/appliance/install.ps1']) {
      const src = fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
      expect(src, `${p} 没设 BEACON_QUEUE=local——装出来的机器仍然不跑定时`).toMatch(/BEACON_QUEUE=local/);
    }
  });

  it('web 启动钩子里只在 local 档起调度器（别的档会导致每条任务跑两遍）', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.resolve(process.cwd(), 'instrumentation.node.ts'), 'utf8');
    expect(src).toMatch(/schedulerKind\(\) === 'local'/);
    expect(src).toMatch(/startLocalScheduler/);
    // 判据要走 schedulerKind()，不许在这里另写一遍 env 比较——两处口径迟早分叉
    expect(src.replace(/\/\/.*$/gm, ''), '启动钩子里不该直接比 env').not.toMatch(/process\.env\.BEACON_QUEUE/);
  });
});
