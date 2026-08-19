import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SCHEDULES, SCHEDULE_TZ } from '@/lib/jobs/schedule-config';
import { JOB_TRACK } from '@/lib/jobs/types';
import { PUSH_TICK_MINUTES } from '@/lib/bot/push-window';

// 定时表此前在 tests/ 下**零引用**——而「cron 不带时区，容器里全体晚 8 小时」是 2026-07-28
// 的真实生产事故：`每日 05:00 生成推荐` 实际打在北京 13:00，用户中午才收到晨报。
// 修完之后一直没有回归守卫，等于同一个坑可以再踩一次。
//
// 这份用例钉四件事：① 时区口径不许丢；② 每个 JobName 都得有归宿（要么有 cron、要么明确记为事件驱动）；
// ③ cron 写法本身合法；④ 与它耦合的常量（PUSH_TICK_MINUTES）不许各改各的。

describe('定时表 · 时区口径', () => {
  it('🔒 SCHEDULE_TZ 必须是北京时间', () => {
    // 容器（node:20-slim）里没有 TZ，系统时间是 UTC。这个常量是唯一的纠偏点。
    expect(SCHEDULE_TZ).toBe('Asia/Shanghai');
  });

  it('🔒 注册 repeat 时真的把 tz 传下去了（漏传就是全体晚 8 小时）', () => {
    const queue = readFileSync(resolve(process.cwd(), 'lib/jobs/queue.ts'), 'utf8');
    // 判据是「repeat 里同时有 pattern 和 tz」——只有 pattern 正是事故当时的写法
    expect(queue).toMatch(/repeat:\s*\{[^}]*pattern:[^}]*tz:\s*SCHEDULE_TZ/);
  });

  it('🔒 worker 注册时用的就是这张表，不是另抄一份', () => {
    const worker = readFileSync(resolve(process.cwd(), 'worker.ts'), 'utf8');
    expect(worker).toMatch(/import \{ SCHEDULES, SCHEDULE_TZ \} from '\.\/lib\/jobs\/schedule-config'/);
    expect(worker).toMatch(/for \(const s of SCHEDULES\)/);
  });
});

describe('定时表 · 覆盖面与写法', () => {
  it('🔒 每个 JobName 要么在定时表里，要么明确是事件驱动', () => {
    const scheduled = new Set(SCHEDULES.map((s) => s.name));
    // 事件驱动的任务（由业务动作直接 enqueue，不挂 cron）。加新任务时必须二选一登记，
    // 漏登记 = 一个永远不会被触发的任务静静躺着，没有任何地方会提示。
    const EVENT_DRIVEN = new Set<string>([]);
    const orphans = Object.keys(JOB_TRACK).filter((n) => !scheduled.has(n as never) && !EVENT_DRIVEN.has(n));
    expect(
      orphans,
      `这些任务既没有 cron、也没登记成事件驱动——它们永远不会跑：${orphans.join(', ')}`,
    ).toEqual([]);
  });

  it('定时表里不许出现 JOB_TRACK 之外的任务名', () => {
    const known = new Set(Object.keys(JOB_TRACK));
    for (const s of SCHEDULES) {
      expect(known.has(s.name), `定时表里的 ${s.name} 不是已知任务`).toBe(true);
    }
  });

  it('🔒 每条 cron 都是合法的 5 段写法，且不重名', () => {
    const seen = new Set<string>();
    for (const s of SCHEDULES) {
      const parts = s.cron.trim().split(/\s+/);
      expect(parts, `${s.name} 的 cron「${s.cron}」不是 5 段`).toHaveLength(5);
      for (const p of parts) {
        expect(p, `${s.name} 的 cron 里有空段或非法字符：${p}`).toMatch(/^[\d*\/,\-]+$/);
      }
      expect(seen.has(s.name), `${s.name} 在定时表里出现了两次`).toBe(false);
      seen.add(s.name);
      expect(s.note.trim(), `${s.name} 没写 note——这张表是给人读的`).not.toBe('');
    }
  });

  // push_daily_brief 的间隔与 PUSH_TICK_MINUTES 是同一件事：cron 扫描间隔比推送窗口宽，
  // 就会有机器人整批错过自己的推送时刻；比它窄则会重复推。
  it('🔒 晨报扫描间隔与 PUSH_TICK_MINUTES 一致', () => {
    const push = SCHEDULES.find((s) => s.name === 'push_daily_brief');
    expect(push, '晨报任务不在定时表里了？').toBeTruthy();
    expect(push!.cron).toBe(`*/${PUSH_TICK_MINUTES} * * * *`);
  });

  // 这条不是「代码规范」，是隐私政策写死的承诺：三份政策都说「满 90 天自动物理删除」，
  // 而各处的到期清理原先只挂在写入路径上——停止使用的工作区反而永久留着第三方数据。
  it('🔒 保留期兑现闸必须在定时表里（三份隐私政策依赖它）', () => {
    expect(SCHEDULES.some((s) => s.name === 'purge_retention')).toBe(true);
  });
});
