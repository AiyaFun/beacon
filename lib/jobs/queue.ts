import type { JobQueue, JobName, JobHandler, JobPayload } from './types';
import { HANDLERS } from './handlers';
import { SCHEDULE_TZ } from './schedule-config';

// 进程内队列（开发态）：enqueue 即时同步执行，零基础设施。
class InProcessQueue implements JobQueue {
  readonly kind = 'inprocess' as const;
  private handlers = new Map<JobName, JobHandler>();

  constructor() {
    // dev 下同进程直接注册全部处理器
    for (const [name, h] of Object.entries(HANDLERS)) this.register(name as JobName, h);
  }
  register(name: JobName, handler: JobHandler) {
    this.handlers.set(name, handler);
  }
  async enqueue(name: JobName, payload: JobPayload = {}) {
    const h = this.handlers.get(name);
    if (!h) throw new Error(`未注册的任务：${name}`);
    await h(payload); // 同步执行
  }
  async schedule() {
    // 开发态不自动定时；由页面按钮手动触发。生产态见 BullMQQueue。
  }
  async resetSchedules() {
    return 0;
  }
  async close() {}
}

/**
 * AI 执行循环走**自己的队列**，与其它任务分开。
 *
 * 【为什么必须分开】原来所有任务共用一个队列、一个 worker、4 个并发槽。而一次 AI 执行
 * 的 loop 会占住一个槽**几十分钟**（十几轮模型调用，中间还夹着 8 分钟的出图、20 分钟的
 * 智能体）。四个用户同时派活，热榜采集、定时智能体、清理、发布回流就全部排在它们后面——
 * 一个人用 AI 助手，整个平台的定时任务停摆。
 *
 * 分成两个队列之后，长任务只会饿死别的长任务，那是它们该有的样子。
 */
export const AGENT_QUEUE_NAME = 'beacon-agent';
export const MAIN_QUEUE_NAME = 'beacon-jobs';

/** 哪些任务走 AI 执行专用队列。 */
function queueNameFor(name: JobName): string {
  return name === 'run_agent_loop' ? AGENT_QUEUE_NAME : MAIN_QUEUE_NAME;
}

// BullMQ 队列（生产态）：投递到 Redis，由独立 worker 进程消费；支持 cron 定时。
class BullMqQueue implements JobQueue {
  readonly kind = 'bullmq' as const;
  // 延迟加载 bullmq/ioredis，避免 dev 无 Redis 时初始化
  private _queues = new Map<string, import('bullmq').Queue>();
  private handlers = new Map<JobName, JobHandler>();

  private connection() {
    const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    return { url } as { url: string };
  }

  private async queue(queueName: string = MAIN_QUEUE_NAME) {
    const hit = this._queues.get(queueName);
    if (hit) return hit;
    const { Queue } = await import('bullmq');
    const IORedis = (await import('ioredis')).default;
    const q = new Queue(queueName, { connection: new IORedis(this.connection().url, { maxRetriesPerRequest: null }) });
    this._queues.set(queueName, q);
    return q;
  }

  register(name: JobName, handler: JobHandler) {
    this.handlers.set(name, handler);
  }

  async enqueue(name: JobName, payload: JobPayload = {}) {
    const q = await this.queue(queueNameFor(name));
    await q.add(name, payload, { removeOnComplete: 200, removeOnFail: 500 });
  }

  async schedule(name: JobName, cron: string, payload: JobPayload = {}) {
    // 定时任务一律进主队列（run_agent_loop 是事件型的，从来不挂 cron）
    const q = await this.queue();
    // tz 不能省：容器系统时间是 UTC，不传就等于把「北京 05:00」写成「北京 13:00」（见 SCHEDULE_TZ）。
    await q.add(name, payload, { repeat: { pattern: cron, tz: SCHEDULE_TZ }, removeOnComplete: 50 });
  }

  // 清空 Redis 里已注册的全部定时任务，返回清掉的条数。
  // 【为什么必须先清】BullMQ 的 repeat key 是 (任务名 + pattern + tz) 的哈希：改了 cron 或时区
  // 就变成**另一条**定时任务，旧的那条不会被覆盖，会带着旧时间继续跑——
  // 表现为「代码改了时间，线上还按老时间推，而且新老各推一次」。worker 每次启动先清后注册即可根治。
  async resetSchedules() {
    const q = await this.queue();
    const existing = await q.getRepeatableJobs();
    for (const r of existing) await q.removeRepeatableByKey(r.key);
    return existing.length;
  }

  /**
   * worker 进程调用：起消费者，dispatch 到 HANDLERS。
   *
   * 队列名要显式传：AI 执行那条队列的并发是**单独调**的——它的任务一个能跑几十分钟，
   * 用主队列那个数会让少数几个用户把槽位占满。
   */
  async startWorker(queueName: string = MAIN_QUEUE_NAME, concurrency?: number) {
    const { Worker } = await import('bullmq');
    const IORedis = (await import('ioredis')).default;
    const connection = new IORedis(this.connection().url, { maxRetriesPerRequest: null });
    return new Worker(
      queueName,
      async (job) => {
        const h = HANDLERS[job.name as JobName];
        if (!h) throw new Error(`未知任务：${job.name}`);
        return h(job.data as JobPayload);
      },
      { connection, concurrency: concurrency ?? Number(process.env.BEACON_WORKER_CONCURRENCY || 4) },
    );
  }

  async close() {
    for (const q of this._queues.values()) await q.close();
    this._queues.clear();
  }
}

let cached: JobQueue | null = null;

/**
 * 后台定时**真的会到点自己跑**吗。
 *
 * 只有 BullMQ 那条路才有 cron：InProcessQueue 的 schedule() 是空实现
 *（开发态由页面按钮手动触发）。整机版只启一个 `next start`
 *（deploy/appliance/install.sh），走的正是进程内队列。
 *
 * 【为什么不做成 lib/edition 的 Capability】那张矩阵是**产品能力面**的定义，
 * 而且钉死了「appliance 与 private 能力面必须一致，差别只在基础设施」。
 * 定时跑不跑恰恰是基础设施差异（有没有独立 worker 进程），放进能力矩阵会让
 * 两个企业版分叉，破坏那条原则。判队列类型既准确又自动跟着环境走：
 * 本机 dev 同样不会跑定时，界面上也该照实说。
 *
 * 只读 env、不实例化队列：给页面渲染用，不该顺带连一次 Redis。
 */
export function backgroundSchedulerRuns(): boolean {
  // 两种形态都会到点自己跑：
  //   bullmq —— 独立 worker 进程注册 cron（SaaS / 私有化）
  //   local  —— web 进程内的调度器（整机版：单文件 SQLite，不能再起第二个写进程）
  // 其余（不设或 inprocess）= 本机开发：不跑定时，界面上也要照实说。
  const mode = process.env.BEACON_QUEUE;
  return mode === 'bullmq' || mode === 'local';
}

/** 定时是**谁**在跑。给 /api/health 与运维台看，判「配了却不跑」时一眼能定位。 */
export function schedulerKind(): 'bullmq' | 'local' | 'none' {
  const mode = process.env.BEACON_QUEUE;
  if (mode === 'bullmq') return 'bullmq';
  if (mode === 'local') return 'local';
  return 'none';
}

// 工厂：BEACON_QUEUE=bullmq 且有 REDIS_URL 时走 BullMQ，否则进程内。
//
// 【为什么 local 走的也是 InProcessQueue】它与 inprocess 的差别只有一处：
// **有没有人到点来敲门**（lib/jobs/local-scheduler.ts）。enqueue 的行为是一样的，
// 没必要再造一个队列实现——那会多出一份要同步维护的分支。
export function getQueue(): JobQueue {
  if (cached) return cached;
  if (process.env.BEACON_QUEUE === 'bullmq') {
    cached = new BullMqQueue();
  } else {
    cached = new InProcessQueue();
  }
  return cached;
}

export { BullMqQueue };
