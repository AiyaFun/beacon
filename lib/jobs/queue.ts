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

// BullMQ 队列（生产态）：投递到 Redis，由独立 worker 进程消费；支持 cron 定时。
class BullMqQueue implements JobQueue {
  readonly kind = 'bullmq' as const;
  private queueName = 'beacon-jobs';
  // 延迟加载 bullmq/ioredis，避免 dev 无 Redis 时初始化
  private _queue: import('bullmq').Queue | null = null;
  private handlers = new Map<JobName, JobHandler>();

  private connection() {
    const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    return { url } as { url: string };
  }

  private async queue() {
    if (this._queue) return this._queue;
    const { Queue } = await import('bullmq');
    const IORedis = (await import('ioredis')).default;
    this._queue = new Queue(this.queueName, { connection: new IORedis(this.connection().url, { maxRetriesPerRequest: null }) });
    return this._queue;
  }

  register(name: JobName, handler: JobHandler) {
    this.handlers.set(name, handler);
  }

  async enqueue(name: JobName, payload: JobPayload = {}) {
    const q = await this.queue();
    await q.add(name, payload, { removeOnComplete: 200, removeOnFail: 500 });
  }

  async schedule(name: JobName, cron: string, payload: JobPayload = {}) {
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

  // worker 进程调用：起消费者，dispatch 到 HANDLERS
  async startWorker() {
    const { Worker } = await import('bullmq');
    const IORedis = (await import('ioredis')).default;
    const connection = new IORedis(this.connection().url, { maxRetriesPerRequest: null });
    return new Worker(
      this.queueName,
      async (job) => {
        const h = HANDLERS[job.name as JobName];
        if (!h) throw new Error(`未知任务：${job.name}`);
        return h(job.data as JobPayload);
      },
      { connection, concurrency: Number(process.env.BEACON_WORKER_CONCURRENCY || 4) },
    );
  }

  async close() {
    if (this._queue) await this._queue.close();
  }
}

let cached: JobQueue | null = null;

// 工厂：BEACON_QUEUE=bullmq 且有 REDIS_URL 时走 BullMQ，否则进程内
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
