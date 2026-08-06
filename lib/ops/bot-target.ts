import { prisma } from '../db';
import { readBotSecrets, sendVia } from '../bot';
import { log } from '../logger';
import { setOpsBotSender } from './alert';

// 运维告警的**默认出口：复用用户自己配好的机器人集成**（设置页 → 机器人集成）。
// 产品口径（2026-07-30 用户拍板）：配了就用现有机器人推给他；没配就不推——
// 不再要求另外去建一个 webhook、也不加新的必填 env。
//
// ⚠️ 只能从 node 侧引用（worker.ts / instrumentation 的 nodejs 分支）：
// 它查库、解密密钥，链路上有 `node:crypto`，被 edge 打包会直接构建失败（真踩过）。
//
// 选谁的机器人（顺序固定，绝不猜）：
//   1. `BEACON_OPS_WORKSPACE_ID` 指定的工作区 —— 多租户下唯一稳妥的答案；
//   2. 没指定时：全库**有且只有一个**启用中的机器人集成，才用它。
//      多于一个就放弃并打日志——生产 500 的内容是内部信息，
//      宁可不发，也不能发进某个客户的群（挑错群没有撤回键）。
export async function resolveOpsBotTarget(): Promise<{ workspaceId: string; why: string } | null> {
  const pinned = process.env.BEACON_OPS_WORKSPACE_ID?.trim();
  if (pinned) return { workspaceId: pinned, why: 'BEACON_OPS_WORKSPACE_ID' };

  const active = await prisma.botIntegration.findMany({
    where: { enabled: true },
    select: { workspaceId: true },
    take: 2, // 只需要知道「是不是恰好一个」
  });
  if (active.length === 1) return { workspaceId: active[0].workspaceId, why: '全库唯一的机器人集成' };
  return null;
}

/** 真发一条文本到目标工作区的机器人（沿用 pushEvent 的同一套选路：自建应用优先，其次 webhook）。 */
export async function sendOpsViaBot(text: string): Promise<boolean> {
  const target = await resolveOpsBotTarget();
  if (!target) return false;

  const integrations = await prisma.botIntegration.findMany({
    where: { workspaceId: target.workspaceId, enabled: true },
  });
  let ok = false;
  for (const it of integrations) {
    if (!it.webhookUrl && !it.inboundKey) continue;
    try {
      const r = await sendVia(it.provider, it.webhookUrl, readBotSecrets(it.secretsEnc), { kind: 'text', text });
      if (r.ok) ok = true;
    } catch {
      // 一个集成挂了不影响其余；告警本身出错不许往上抛
    }
  }
  return ok;
}

/**
 * 启动时装配：把「复用机器人」这条出口注册给 lib/ops/alert。只在 node 侧调用。
 * 返回此刻解析到的目标（可能为 null）——注册本身照做：
 * 用户**启动之后**才去设置页配机器人时，下一条告警就能发出去，不需要重启容器。
 */
export async function installOpsBotSender(): Promise<{ workspaceId: string; why: string } | null> {
  setOpsBotSender(async (text) => sendOpsViaBot(text));
  const target = await resolveOpsBotTarget().catch(() => null);
  log.info('运维告警出口已就绪', {
    channel: process.env.BEACON_OPS_WEBHOOK ? 'webhook' : target ? 'bot' : 'none（配好机器人即生效）',
    target: target?.why,
  });
  return target;
}
