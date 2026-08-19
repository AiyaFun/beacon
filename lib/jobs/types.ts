// 任务编排契约（PRD §6 AI 管线三轨：广播型 / 批租户型 / 事件驱动）。
// 开发态用进程内队列（点按钮即时同步执行）；生产态用 BullMQ + Redis。

export type JobTrack = 'broadcast' | 'batch_tenant' | 'event';

export type JobName =
  | 'ingest_hot' // 广播：采集热榜
  | 'cluster_topics' // 广播：跨源聚类
  | 'crawl_competitors' // 广播：采集竞对（全局共享）
  | 'daily_recommend' // 批租户：生成今日推荐
  | 'push_daily_brief' // 批租户：按各机器人配置的时刻推送今日选题晨报
  | 'replenish_evergreen' // 批租户：常青储备按水位线补货
  | 'backfill_metrics' // 事件：发布回流
  | 'optimize_memory' // 批租户：记忆持续学习优化
  | 'generate_reviews' // 批租户：发布满 7 天自动生成 AI 复盘
  | 'weekly_review' // 批租户：每周运营复盘
  | 'plan_expiry_notice' // 批租户：套餐/试用到期前后的续费提醒
  | 'purge_retention'; // 广播：全库到期数据清理（保留期承诺的兑现闸，见 lib/legal/retention.ts）

export type JobPayload = Record<string, unknown>;

export type JobHandler = (payload: JobPayload) => Promise<{ detail?: string }>;

export interface JobQueue {
  readonly kind: 'inprocess' | 'bullmq';
  // 立即入队执行（dev 同步 await；prod 投递到 Redis 由 worker 消费）
  enqueue(name: JobName, payload?: JobPayload): Promise<void>;
  // 注册处理器（worker 侧）
  register(name: JobName, handler: JobHandler): void;
  // 注册定时任务（cron）
  schedule(name: JobName, cron: string, payload?: JobPayload): Promise<void>;
  // 清空已注册的定时任务，返回清掉的条数（worker 启动时先清后注册，见 resetSchedules 的实现注释）
  resetSchedules(): Promise<number>;
  close(): Promise<void>;
}

// 三轨归属
export const JOB_TRACK: Record<JobName, JobTrack> = {
  ingest_hot: 'broadcast',
  cluster_topics: 'broadcast',
  crawl_competitors: 'broadcast',
  daily_recommend: 'batch_tenant',
  push_daily_brief: 'batch_tenant',
  replenish_evergreen: 'batch_tenant',
  backfill_metrics: 'event',
  optimize_memory: 'batch_tenant',
  generate_reviews: 'batch_tenant',
  weekly_review: 'batch_tenant',
  plan_expiry_notice: 'batch_tenant',
  // 广播而非批租户：它扫的正是「已经没人再写入」的工作区，按活跃租户遍历会漏掉的恰好是最该清的那些。
  purge_retention: 'broadcast',
};
