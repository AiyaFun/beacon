import { getReporter, setReporter, log } from '../logger';
import { opsAlertConfigured } from './alert';
import { installOpsBotSender } from './bot-target';
import { OpsWebhookReporter } from './reporter';

/**
 * 错误上报的装配（**node 侧专用**，别从 edge 可达的地方引用）。
 * 顺序：
 *   1. Sentry（配了 DSN，initObservability 里已装）——有就不动它；
 *   2. 否则接运维告警出口：显式 `BEACON_OPS_WEBHOOK`，或**用户已配好的机器人集成**
 *      （产品口径：配了就用现有机器人推，没配就不推，不再要求另建 webhook）；
 *   3. 两者都没有 → 只落服务器日志（启动横幅里 reporter 显示 none）。
 *
 * web 与 worker 共用一份：worker 更需要这条腿——它没有页面，
 * 任务失败以前只在容器日志里，除非有人主动去看，否则永远不知道。
 */
export async function installOpsAlerting(): Promise<void> {
  const target = await installOpsBotSender().catch((e) => {
    log.warn('运维告警出口装配失败', { err: e });
    return null;
  });
  if (getReporter()) return; // Sentry 已就位
  if (!opsAlertConfigured()) return;
  setReporter(new OpsWebhookReporter());
  // 日志要说清**现在有没有人收得到**。之前这里恒打「已接到运维告警出口」，
  // 而一个机器人都没配时其实谁也收不到——排查时会被这句话带偏。
  log.info('错误上报已接出口', {
    reporter: 'ops-webhook',
    delivery: process.env.BEACON_OPS_WEBHOOK ? 'webhook' : target ? `bot:${target.why}` : 'pending',
    note: process.env.BEACON_OPS_WEBHOOK || target ? undefined : '当前没有可用机器人，配好后立即生效（不用重启）',
  });
}
