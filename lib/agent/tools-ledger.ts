import type { AgentTool } from './tool-types';
import { str } from './tool-types';
import { ledgerList, ledgerSet, markSeen, ASSISTANT_SLUG, LEDGER_KEY_MAX, LEDGER_VALUE_MAX, LEDGER_KV_MAX, SEEN_BATCH_MAX } from './ledger';

// ── 台账工具（2026-09-05）────────────────────────────────────────────────────
//
// 三个动词，全部落在 ctx.botSlug 那个 bot 自己的格子里：
//   ledger_read  读整份 kv（不带参数——台账封顶 30 条，一次读完比让模型猜键名省一轮）
//   ledger_write 写/删一条（写空即删）
//   mark_seen    把一批条目标识过一遍，只把没见过的还回来（并记下）
//
// 【为什么不 contract、不 costly】它们改的是 bot 自己的工作状态，不是用户的内容、不花钱、
// 也不产生「以后一直生效」的承诺（那是 write_memory 的地界）。逐条确认只会让「汇报前先去重」
// 这件本该默默做的事每次都弹一下——用户会把它关掉，于是又回到重报。
// 【没有模板的运行】ctx.botSlug 为空时用 'assistant'：通用助手也能有自己的台账，
// 但它与任何职能 bot 都不共享。

const slugOf = (ctx: { botSlug?: string }) => ctx.botSlug || ASSISTANT_SLUG;

const ledgerRead: AgentTool = {
  name: 'ledger_read',
  label: '读自己的台账',
  action: 'content.view',
  write: false,
  def: {
    name: 'ledger_read',
    description:
      '读你这个 bot 自己的台账（盯单、上次做到哪、用户交代的长期安排）。'
      + '系统提示里已经注入过一份摘要；值被截断时、或想确认最新状态时再调。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  async run(ctx) {
    const rows = await ledgerList(ctx.workspaceId, slugOf(ctx));
    return {
      ok: true,
      data: rows.map((r) => ({ key: r.key, value: r.value, updatedAt: r.updatedAt })),
      summary: rows.length ? `台账 ${rows.length} 条` : '台账是空的',
    };
  },
};

const ledgerWrite: AgentTool = {
  name: 'ledger_write',
  label: '记进自己的台账',
  action: 'content.create',
  write: true,
  def: {
    name: 'ledger_write',
    description:
      `往你自己的台账写一条（键 ≤${LEDGER_KEY_MAX} 字，值 ≤${LEDGER_VALUE_MAX} 字，最多 ${LEDGER_KV_MAX} 条）。`
      + '用来记**你的工作状态**：盯单（盯哪些号/话题）、上次复盘到哪天、用户交代的例行安排。'
      + '值传空串 = 删掉这条。关于用户本人的长期事实不放这里，用 write_memory。',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '名字，如「盯单」「上次复盘到」' },
        value: { type: 'string', description: '内容；空串表示删除' },
      },
      required: ['key', 'value'],
    },
  },
  async run(ctx, args) {
    const key = str(args.key);
    const value = str(args.value);
    const r = await ledgerSet(ctx.workspaceId, slugOf(ctx), key, value);
    if (!r.ok) return { ok: false, error: r.error, summary: r.error };
    return { ok: true, data: { key, deleted: r.deleted }, summary: r.deleted ? `已删掉台账「${key}」` : `已记入台账「${key}」` };
  },
};

const markSeenTool: AgentTool = {
  name: 'mark_seen',
  label: '过一遍已见清单',
  action: 'content.create',
  write: true,
  def: {
    name: 'mark_seen',
    description:
      '汇报一批东西（帖子、热榜条目、评论）之前先把它们的标识（URL 或 id）传进来：'
      + '返回 fresh = 没报过的、seen = 已经报过的。**只汇报 fresh 里的**，同一条不报第二遍。'
      + `传进来的会被记下（90 天内算见过）。一次最多 ${SEEN_BATCH_MAX} 条。`,
    parameters: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: '条目标识：URL 或平台 id' },
        note: { type: 'string', description: '可选，一句话说明这批是什么（如「9-5 竞对新帖」）' },
      },
      required: ['ids'],
    },
  },
  async run(ctx, args) {
    const raw = Array.isArray(args.ids) ? args.ids : [];
    const ids = raw.filter((x): x is string => typeof x === 'string');
    if (ids.length === 0) return { ok: false, error: 'ids 为空', summary: '没传任何标识' };
    const r = await markSeen(ctx.workspaceId, slugOf(ctx), ids, str(args.note));
    return {
      ok: true,
      data: r,
      summary: `新的 ${r.fresh.length} 条，报过的 ${r.seen.length} 条`,
    };
  },
};

export const LEDGER_TOOLS: AgentTool[] = [ledgerRead, ledgerWrite, markSeenTool];
