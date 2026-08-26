// 生产任务 worker 进程入口：注册三轨 cron + 起 BullMQ 消费者。
// 运行：BEACON_QUEUE=bullmq REDIS_URL=redis://... npx tsx worker.ts
// （dev 不需要此进程——进程内队列在按钮点击时同步执行）

import { getQueue, BullMqQueue, MAIN_QUEUE_NAME, AGENT_QUEUE_NAME } from './lib/jobs/queue';
import { SCHEDULES, SCHEDULE_TZ } from './lib/jobs/schedule-config';
import { initObservability, log, flushReports } from './lib/logger';

async function main() {
  initObservability('worker');
  // 没配 Sentry 时把错误上报接到运维告警出口（显式 webhook，或用户已配的机器人集成）。
  // worker 尤其需要：它没有页面，任务失败以前只在容器日志里，除非有人主动去看，否则永远不知道。
  await (await import('./lib/ops/install')).installOpsAlerting();

  if (process.env.BEACON_QUEUE !== 'bullmq') {
    log.error(
      'worker 需要 BEACON_QUEUE=bullmq（SaaS / 私有化）。'
      + '整机版用 BEACON_QUEUE=local——定时跑在 web 进程里（单文件 SQLite 不能有第二个写进程），不要起本进程。'
      + '本机开发不设这个变量，不跑定时。',
    );
    await flushReports();
    process.exit(1);
  }
  const q = getQueue() as BullMqQueue;

  // 先清后注册：旧的 repeat key（改了 cron 或时区之前留下的那条）不会被覆盖，
  // 不清就会新老两条并存，各按各的时间跑。见 resetSchedules 的注释。
  const removed = await q.resetSchedules();
  if (removed) log.info('已清理旧定时任务', { removed });

  // 注册三轨定时任务（时间口径为北京时间，见 SCHEDULE_TZ）
  for (const s of SCHEDULES) {
    await q.schedule(s.name, s.cron);
    log.info('已注册定时任务', { jobName: s.name, cron: s.cron, tz: SCHEDULE_TZ, note: s.note });
  }

  // 起消费者。**两条队列各一个**：
  // AI 执行的 loop 一跑就是几十分钟，与它共用槽位的话，热榜采集、定时智能体、
  // 清理、发布回流会全部排在几个用户的 AI 任务后面——一个人用助手，全平台定时停摆。
  const mainConcurrency = Number(process.env.BEACON_WORKER_CONCURRENCY || 4);
  const agentConcurrency = Number(process.env.BEACON_AGENT_CONCURRENCY || 4);
  const workers = [
    { name: MAIN_QUEUE_NAME, w: await q.startWorker(MAIN_QUEUE_NAME, mainConcurrency), concurrency: mainConcurrency },
    { name: AGENT_QUEUE_NAME, w: await q.startWorker(AGENT_QUEUE_NAME, agentConcurrency), concurrency: agentConcurrency },
  ];
  for (const { name, w } of workers) {
    w.on('completed', (job) => {
      log.info('任务完成', { queue: name, jobName: job.name, jobId: job.id, durationMs: job.finishedOn ? job.finishedOn - job.processedOn! : undefined });
    });
    w.on('failed', (job, err) => {
      // 任务失败是要被看见的：error 级 + 自动上报
      log.error('任务失败', { queue: name, jobName: job?.name, jobId: job?.id, attempts: job?.attemptsMade, err });
    });
    w.on('error', (err) => {
      log.error('worker 内部错误', { queue: name, err });
    });
  }
  log.info('beacon worker 已启动', {
    queues: workers.map((x) => `${x.name}(并发 ${x.concurrency})`).join(' + '),
  });

  const shutdown = async (signal: string) => {
    log.info('收到退出信号，关闭 worker…', { signal });
    await Promise.all(workers.map(({ w }) => w.close()));
    await q.close();
    await flushReports();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // 兜底：未捕获异常必须留痕再退出，让编排器重启（不要吞掉继续裸跑）
  process.on('uncaughtException', async (err) => {
    log.error('未捕获异常，进程退出', { err });
    await flushReports();
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('未处理的 Promise 拒绝', { err: reason });
  });
}

main().catch(async (e) => {
  log.error('worker 启动失败', { err: e, phase: 'startup' });
  await flushReports();
  process.exit(1);
});
