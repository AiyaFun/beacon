import { pushEvent, beaconUrl } from '../bot';
import { redlineReason, type WordHit } from './engine';

// 「合规拦截告警」推送（PUSH_EVENTS.compliance_alert）。
//
// 这个事件是新建机器人时**默认勾上**的三项之一（BotIntegrationCard DEFAULT_EVENTS），
// 但直到 2026-09-03 都没有任何发射点——用户以为开着的告警，从来没响过。
// 现在挂在各条红线硬闸的拒绝分支上：导出 / PDF / 标题采纳 / 技能输出 / 封面 / 配图。
//
// 旁路：永远不 throw、不 await 也行（调用方 void 掉）。拦截本身已经在调用方发生，
// 这里只是把「拦了什么」告诉群里——不影响拦截。
export async function notifyComplianceBlock(
  workspaceId: string | null | undefined,
  where: string,
  hits: WordHit[],
  excerpt?: string | null,
): Promise<void> {
  if (!workspaceId || hits.length === 0) return;
  try {
    const lines = [`拦在：${where}`, `命中：${redlineReason(hits).slice(0, 200)}`];
    if (excerpt) lines.push(`片段：${excerpt.replace(/\s+/g, ' ').slice(0, 80)}…`);
    await pushEvent(workspaceId, 'compliance_alert', {
      kind: 'card',
      title: '🚫 合规红线拦截',
      lines,
      link: { text: '去合规页看词库', url: beaconUrl('/compliance') },
    });
  } catch {
    /* 旁路，吞 */
  }
}
