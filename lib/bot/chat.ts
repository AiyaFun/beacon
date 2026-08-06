import { prisma } from '../db';
import { llmComplete } from '../llm/gateway';
import { buildAccountContext } from '../account-context';
import { log } from '../logger';
import type { ChatMessage } from '../llm/types';
import type { BotTurn } from './conversation';
import { beaconUrl } from './index';

// 群里 @机器人 的自由对话。
//
// 【和站内助手（/assistant）的区别，也是这个文件存在的理由】
//   · 站内是一个人对着一块屏幕，可以流式、可以长；群里是几个人瞄一眼手机通知，
//     长回答等于没人读。所以这里硬性要求短、纯文本、不用 Markdown 标题与表格
//     （飞书文本消息不渲染 Markdown，`**加粗**` 会原样露出星号）。
//   · 站内的账号来自登录态 session.accountId；群里没有登录态，账号由本群绑定
//     或工作区唯一账号决定（见 lib/bot/accounts.ts），并在回答里明示是哪个号。
//
// 【接的是同一套账号上下文】人设卡、风格指纹、真实数据基线、受众画像、长期记忆
// 都走 buildAccountContext——群里问「我这条为什么没火」和站内问，答案应当一致。

// 上下文预算：飞书群消息本身短，留给账号上下文 3000 字符足够，再多是烧 token。
const CONTEXT_CHARS = 3000;

export type BotChatResult = { text: string; mocked: boolean };

function groupStyleRules(accountName: string): string {
  return [
    '',
    '【回答要求（这条回复会直接发到群聊里）】',
    '- 250 字以内，能一句说完就别说三句；群里没人读长文。',
    '- 纯文本。不要 Markdown 标题、加粗、表格（群消息不渲染，星号会原样露出来）；要分条就用「1. 」或「- 」。',
    `- 你服务的是「${accountName}」这个账号，结论要贴它的人设与真实数据，不要给放之四海皆准的正确废话。`,
    '- 上下文里没有的数据不要编。不知道就说不知道，并说清楚缺哪份数据、去哪补。',
  ].join('\n');
}

/**
 * 群内对话。turns 为本会话历史（已按 TTL/长度裁剪）。
 * accountId 为空时仍然可聊（只是没有账号上下文），绝不因为没账号就拒答。
 */
export async function botChat(params: {
  workspaceId: string;
  accountId: string | null;
  accountName: string | null;
  question: string;
  turns: BotTurn[];
}): Promise<BotChatResult> {
  const { workspaceId, accountId, accountName, question } = params;
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { tenantId: true } });
  if (!ws) return { text: '找不到这个工作区，机器人配置可能已失效。', mocked: false };

  let contextText = '';
  if (accountId) {
    const ctx = await buildAccountContext({
      workspaceId,
      accountId,
      blocks: ['persona', 'fingerprint', 'baseline', 'audience', 'memory', 'material'],
      memoryQuery: question,
      maxChars: CONTEXT_CHARS,
    }).catch(() => null);
    contextText = ctx?.text ?? '';
  }

  const system = [
    '你是「烽火台」内容作战室的 AI 运营助手，正在一个内容团队的工作群里被 @ 到。',
    '你帮他们做选题、写文案、看数据、定运营策略。',
    contextText ? `\n${contextText}` : '',
    groupStyleRules(accountName ?? '当前账号'),
  ].join('\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...params.turns.map((t): ChatMessage => ({ role: t.role, content: t.content })),
    { role: 'user', content: question.slice(0, 2000) },
  ];

  try {
    const res = await llmComplete(ws.tenantId, 'chat', messages, { temperature: 0.7 });
    const text = res.text.trim();
    if (!text) return { text: 'AI 没给出内容，换个说法再问一次试试。', mocked: true };
    // 降级/Mock 必须说破：群里看不到站内那个「示例」徽标，不标注就会被当成真结论去执行
    const prefix = res.mocked || res.degraded ? '（AI 暂时不可用，以下为示例回答，不要当结论用）\n' : '';
    return { text: prefix + text, mocked: !!res.mocked };
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    // 配额超限与演示模式的文案本身就是给用户看的，原样透出比「出错了」有用得多
    if (/配额|quota|演示/.test(msg)) return { text: `${msg}\n用量与套餐 → ${beaconUrl('/settings')}`, mocked: false };
    log.warn('bot 对话失败', { workspaceId, err: e });
    return { text: 'AI 这会儿没答上来（服务异常），过一会儿再问一次。', mocked: false };
  }
}
