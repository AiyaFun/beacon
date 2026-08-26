import { SCHEDULES, SCHEDULE_TZ } from './schedule-config';
import { HANDLERS } from './handlers';
import { beijingMinuteOfDay, beijingDayKey, beijingWeekday } from '../beijing';
import { createLogger } from '../logger';
import type { JobName } from './types';

const log = createLogger({ module: 'local-scheduler' });

// ── 整机版的定时：跑在 web 进程里 ────────────────────────────────────────────
//
// 【为什么整机版以前没有定时】定时只有 BullMQ 那条路有（cron 由独立 worker 进程注册），
// 而整机版只起一个 `next start`、没有 Redis 也没有 worker。于是「每天自动跑一遍」
// 这件事在整机版上**整个不存在**——界面直接不给配，服务端也拒绝建。
// 那不是降级，是一整块能力缺席，而 appliance 与 private 的能力面本该一致。
//
// 【为什么不在整机版上另起一个 worker 进程】整机版的库是**单文件 SQLite**。
// 两个 Node 进程同时写同一个文件会撞锁（SQLITE_BUSY），而那种失败是间歇性的、
// 只在两边恰好同时写时出现——最难查的一类。所以调度放进 web 进程自己：
// 一个进程、一份连接、没有锁竞争。
//
// 【代价，说清楚】web 进程重启（改配置、升级、崩溃）期间不跑定时；
// 错过的那一轮**不补跑**——与定时智能体「过窗不补」是同一条口径
//（补跑意味着用户开机时突然被扣掉昨天那几笔额度）。
//
// 【为什么是「每分钟醒一次自己判」而不是 setTimeout 排到点】排到点要处理
// 系统休眠、时钟调整、夏令时；每分钟判一次是最笨也最稳的做法，
// 一天 1440 次判断的开销可以忽略。

/** 上一次跑过的那一分钟，防止同一分钟内被叫醒两次跑两遍。 */
const lastRunMinute = new Map<JobName, string>();

let timer: ReturnType<typeof setInterval> | null = null;

// 把 cron 解析成「这一分钟该不该跑」。
//
// **只支持项目里实际用到的写法**：星号、步进（星号斜杠 n）、逗号列表、单个数字。
// 支持不了的写法一律返回 null（**不跑并告警**）——悄悄跑成「每分钟一次」比不跑坏得多：
// 一条本该每天一次的任务变成一分钟一次，用户一天被扣 1440 次额度。
//
// 【为什么要支持星期】第一版只解析「分 时」两段、日月周非星号就整条不认，
// 结果是周报（`0 8 * * 1`，每周一）在整机版上**永远不跑**——而它不会报错，
// 只是那份周报从来不来。测试当场把这条抓出来了。
// 日与月仍然不支持：SCHEDULES 里没有用到，加了就是没人验证过的代码。
export function cronDueAt(cron: string, minuteOfDay: number, weekday?: number): boolean | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  // 日/月不是 * 的，这个简易解析器不认——宁可不跑也不能跑错
  if (dom !== '*' || mon !== '*') return null;

  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  const match = (field: string, value: number, max: number): boolean | null => {
    if (field === '*') return true;
    if (field.startsWith('*/')) {
      const step = Number(field.slice(2));
      if (!Number.isInteger(step) || step <= 0 || step > max) return null;
      return value % step === 0;
    }
    if (/^\d+$/.test(field)) return Number(field) === value;
    if (/^[\d,]+$/.test(field)) return field.split(',').map(Number).includes(value);
    return null;
  };
  const mOk = match(min, m, 60);
  const hOk = match(hour, h, 24);
  if (mOk === null || hOk === null) return null;

  if (dow !== '*') {
    // 要按星期判却没告诉我今天星期几 = 调用方漏传，别猜
    if (weekday === undefined) return null;
    const dOk = match(dow, weekday, 7);
    if (dOk === null) return null;
    if (!dOk) return false;
  }
  return mOk && hOk;
}

async function tick(now = new Date()): Promise<void> {
  // 与 BullMQ 那条路同一个时区口径：容器/本机时区是什么都不影响，一律按北京时间判
  const minuteOfDay = beijingMinuteOfDay(now);
  const dayKey = beijingDayKey(now);
  const stamp = `${dayKey}:${minuteOfDay}`;
  // 星期几也要按**北京时间**算：容器/本机时区是 UTC 时，北京周一早上八点在 UTC 还是周日
  const weekday = beijingWeekday(now);

  for (const s of SCHEDULES) {
    const due = cronDueAt(s.cron, minuteOfDay, weekday);
    if (due === null) {
      log.warn('这条 cron 本地调度器解析不了，本机上不会跑', { jobName: s.name, cron: s.cron });
      continue;
    }
    if (!due) continue;
    // 同一分钟只跑一次：定时器有抖动，一分钟内可能醒两次
    if (lastRunMinute.get(s.name) === stamp) continue;
    lastRunMinute.set(s.name, stamp);

    const handler = HANDLERS[s.name];
    if (!handler) continue;
    // 逐个 await：整机版是用户自己那台机器，几个任务并发跑会让他在用的时候明显卡一下。
    // 慢一点没关系，反正没人在等这一轮
    try {
      await handler({});
    } catch (err) {
      // 一个任务炸了不能把整轮带走——它们之间没有依赖
      log.error('本地定时任务失败', { jobName: s.name, error: (err as Error).message });
    }
  }
}

/**
 * 起本地调度器。**只在整机版这种「没有独立 worker」的形态下调**。
 *
 * 幂等：重复调用只会有一个定时器（Next 的开发热重载会把模块重新求值好几次）。
 */
export function startLocalScheduler(): void {
  if (timer) return;
  log.info('本地定时调度器已启动（web 进程内）', { jobs: SCHEDULES.length, tz: SCHEDULE_TZ });
  // 立刻不跑一轮：进程刚起来时数据库连接、迁移都还没稳，而错过一分钟没有任何代价
  timer = setInterval(() => {
    void tick().catch((err) => log.error('本地调度器 tick 失败', { error: (err as Error).message }));
  }, 60_000);
  // 别让这个定时器把进程钉住不退出（优雅停机时要能走完）
  if (typeof timer.unref === 'function') timer.unref();
}

/** 测试与优雅停机用。 */
export function stopLocalScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  lastRunMinute.clear();
}

/** 测试用：手动推一次 tick。 */
export const __tickForTest = tick;
