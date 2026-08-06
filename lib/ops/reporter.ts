import type { ErrorReporter, LogContext } from '../logger';
import { sendOpsAlert } from './alert';

// 把 log.error 接到运维告警群（`BEACON_OPS_WEBHOOK`）。
//
// 定位：**Sentry 的平替**，不是补充。没有 Sentry 账号时，生产报错以前只落在
// `docker compose logs`——「没人报错 ≠ 没出错」。这个 reporter 让错误主动找人。
//
// 为什么单独一个文件而不是塞进 lib/logger.ts：logger 是最底层模块，
// lib/bot/* 反过来要用它打日志。在 logger 里直接 import bot 会成环。
// 装配点放在 instrumentation.ts / worker.ts（logger 早就留好了 setReporter 这个口）。
export class OpsWebhookReporter implements ErrorReporter {
  readonly name = 'ops-webhook';
  private pending = new Set<Promise<unknown>>();

  capture(err: Error, ctx?: LogContext): void {
    // 指纹必须稳定：类型 + 消息前 120 字。带上 requestId/时间戳会让冷却永远命不中。
    const fingerprint = `${err.name}:${String(err.message).slice(0, 120)}`;
    const lines = [
      `${err.name}: ${String(err.message).slice(0, 300)}`,
      ...(ctx?.path ? [`路径 ${String(ctx.path)}`] : []),
      ...(ctx?.jobName ? [`任务 ${String(ctx.jobName)}`] : []),
      // 只给栈顶一行：群消息里贴整段栈没人看，真要查栈去服务器日志（那里是全的）
      ...(err.stack ? [String(err.stack).split('\n')[1]?.trim() ?? ''].filter(Boolean) : []),
    ];
    const p = sendOpsAlert({ level: 'error', title: '服务端异常', lines, fingerprint })
      .catch(() => {})
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  async flush(timeoutMs = 2000): Promise<void> {
    if (!this.pending.size) return;
    await Promise.race([Promise.allSettled([...this.pending]), new Promise((r) => setTimeout(r, timeoutMs))]);
  }
}
