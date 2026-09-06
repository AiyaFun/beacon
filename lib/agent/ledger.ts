import { prisma } from '../db';

// ── 智能体台账（2026-09-05）────────────────────────────────────────────────
//
// 学的是 Grok Bot 市场里那些 bot 的一条共同做法：**工作状态放文件，不放记忆**。
// 情报员要一份「已经报过哪些帖子」的清单，同一条才不会每天重报；
// 复盘官要记住「上次复盘到哪一天」；选题官要一份盯单（watch list）。
// 这些都不是「关于用户」的事实（那是 MemoryEntry），是**某个 bot 自己的工作进度**：
// 换一个 bot 就不该看见，也不该被当成用户偏好注进别的运行。
//
// 隔离键 = 工作区 × bot slug。通用助手（没有模板的运行）用 'assistant'。
//
// 【尺寸上限写死】台账每次运行都会整份注进系统提示（见 renderLedgerBlock），
// 不封顶的话一个勤快的 bot 半个月就能把上下文塞爆。kv 最多 30 条、每条 4000 字；
// 已见清单 90 天过期、每个 bot 最多 3000 条，超了删最老的。

export const ASSISTANT_SLUG = 'assistant';
export const LEDGER_KEY_MAX = 40;
export const LEDGER_VALUE_MAX = 4000;
export const LEDGER_KV_MAX = 30;
export const SEEN_TTL_DAYS = 90;
export const SEEN_MAX = 3000;
/** 一次 mark_seen 最多处理多少条——防模型把整本热榜的 URL 一次倒进来 */
export const SEEN_BATCH_MAX = 200;

export type LedgerEntry = { key: string; value: string; updatedAt: Date };

function cleanKey(key: string): string {
  return key.trim().slice(0, LEDGER_KEY_MAX);
}

export async function ledgerList(workspaceId: string, botSlug: string): Promise<LedgerEntry[]> {
  const rows = await prisma.agentLedger.findMany({
    where: { workspaceId, botSlug, kind: 'kv' },
    orderBy: { updatedAt: 'desc' },
    take: LEDGER_KV_MAX,
    select: { key: true, value: true, updatedAt: true },
  });
  return rows;
}

export async function ledgerGet(workspaceId: string, botSlug: string, key: string): Promise<string | null> {
  const k = cleanKey(key);
  if (!k) return null;
  const row = await prisma.agentLedger.findUnique({
    where: { workspaceId_botSlug_kind_key: { workspaceId, botSlug, kind: 'kv', key: k } },
    select: { value: true },
  });
  return row?.value ?? null;
}

/**
 * 写一条。空值 = 删掉这条（模型没有单独的「删」，写空就是删——少一个工具少一次选错）。
 * 满 30 条且是新键 → 拒绝并如实说，而不是悄悄挤掉最老的：台账是它自己的工作状态，
 * 悄悄丢一条等于让它下次「忘了自己盯着什么」。
 */
export async function ledgerSet(
  workspaceId: string,
  botSlug: string,
  key: string,
  value: string,
): Promise<{ ok: true; deleted: boolean } | { ok: false; error: string }> {
  const k = cleanKey(key);
  if (!k) return { ok: false, error: '键不能为空' };
  const v = value.trim().slice(0, LEDGER_VALUE_MAX);
  const where = { workspaceId_botSlug_kind_key: { workspaceId, botSlug, kind: 'kv', key: k } };
  if (!v) {
    await prisma.agentLedger.deleteMany({ where: { workspaceId, botSlug, kind: 'kv', key: k } });
    return { ok: true, deleted: true };
  }
  const exists = await prisma.agentLedger.findUnique({ where, select: { id: true } });
  if (!exists) {
    const n = await prisma.agentLedger.count({ where: { workspaceId, botSlug, kind: 'kv' } });
    if (n >= LEDGER_KV_MAX) return { ok: false, error: `台账最多 ${LEDGER_KV_MAX} 条，先把不用的写空删掉` };
  }
  await prisma.agentLedger.upsert({
    where,
    create: { workspaceId, botSlug, kind: 'kv', key: k, value: v },
    update: { value: v },
  });
  return { ok: true, deleted: false };
}

/**
 * 已见清单：传进来一批条目标识（帖子 URL、热榜条目 id 之类），
 * 返回哪些是**没见过的**，并把它们记下来。见过的原样列在 seen 里。
 *
 * 【为什么记在返回之前而不是之后】调用方拿到 fresh 之后会去汇报；汇报那一步失败了、
 * 或者运行被打断，下次再跑这批就成了「见过」——宁可少报一次也不重报：
 * 用户对「同一条报两遍」的容忍度远低于「漏了一条」（漏的下周复盘还能捞回来）。
 */
export async function markSeen(
  workspaceId: string,
  botSlug: string,
  ids: string[],
  note = '',
): Promise<{ fresh: string[]; seen: string[] }> {
  const uniq = [...new Set(ids.map((s) => String(s).trim().slice(0, 500)).filter(Boolean))].slice(0, SEEN_BATCH_MAX);
  if (uniq.length === 0) return { fresh: [], seen: [] };
  const existing = await prisma.agentLedger.findMany({
    where: { workspaceId, botSlug, kind: 'seen', key: { in: uniq } },
    select: { key: true },
  });
  const had = new Set(existing.map((r) => r.key));
  const fresh = uniq.filter((k) => !had.has(k));
  const seen = uniq.filter((k) => had.has(k));
  if (fresh.length) {
    const v = note.trim().slice(0, 200);
    // sqlite 不支持 createMany 的 skipDuplicates；上面刚查过不存在，逐条 create 也不会撞
    for (const key of fresh) {
      await prisma.agentLedger.create({ data: { workspaceId, botSlug, kind: 'seen', key, value: v } }).catch(() => {});
    }
    await pruneSeen(workspaceId, botSlug);
  }
  return { fresh, seen };
}

/** 过期与封顶：90 天前的删掉；仍超 3000 条就删最老的那些。 */
async function pruneSeen(workspaceId: string, botSlug: string): Promise<void> {
  const cutoff = new Date(Date.now() - SEEN_TTL_DAYS * 86_400_000);
  await prisma.agentLedger.deleteMany({ where: { workspaceId, botSlug, kind: 'seen', updatedAt: { lt: cutoff } } });
  const n = await prisma.agentLedger.count({ where: { workspaceId, botSlug, kind: 'seen' } });
  if (n <= SEEN_MAX) return;
  const oldest = await prisma.agentLedger.findMany({
    where: { workspaceId, botSlug, kind: 'seen' },
    orderBy: { updatedAt: 'asc' },
    take: n - SEEN_MAX,
    select: { id: true },
  });
  await prisma.agentLedger.deleteMany({ where: { id: { in: oldest.map((o) => o.id) } } });
}

export async function seenCount(workspaceId: string, botSlug: string): Promise<number> {
  return prisma.agentLedger.count({ where: { workspaceId, botSlug, kind: 'seen' } });
}

/**
 * 注进系统提示的那一段。空台账返回空串（不注一个空标题让模型以为有东西要读）。
 * 值截到 300 字：台账里放长文本的是模型自己，注入时按摘要给，要全文它可以 ledger_read。
 */
export async function renderLedgerBlock(workspaceId: string, botSlug: string): Promise<string> {
  const [kv, seen] = await Promise.all([ledgerList(workspaceId, botSlug), seenCount(workspaceId, botSlug)]);
  if (kv.length === 0 && seen === 0) return '';
  const lines = kv.map((e) => `- ${e.key}：${e.value.length > 300 ? `${e.value.slice(0, 300)}…` : e.value}`);
  const seenLine = seen > 0 ? `已见清单里有 ${seen} 条报过的条目——汇报前先用 mark_seen 过一遍，只报新的。` : '';
  return ['【你的台账】（只有你这个 bot 看得见；用 ledger_write 更新，写空即删）', ...lines, seenLine].filter(Boolean).join('\n');
}

/** 一次读多个 bot 的 kv 台账与已见条数（智能体页画卡用）。 */
export async function ledgersByBot(workspaceId: string, slugs: string[]): Promise<Record<string, { kv: LedgerEntry[]; seen: number }>> {
  if (slugs.length === 0) return {};
  const rows = await prisma.agentLedger.findMany({
    where: { workspaceId, botSlug: { in: slugs } },
    orderBy: { updatedAt: 'desc' },
    select: { botSlug: true, kind: true, key: true, value: true, updatedAt: true },
  });
  const out: Record<string, { kv: LedgerEntry[]; seen: number }> = {};
  for (const r of rows) {
    const b = (out[r.botSlug] ??= { kv: [], seen: 0 });
    if (r.kind === 'seen') b.seen += 1;
    else if (b.kv.length < LEDGER_KV_MAX) b.kv.push({ key: r.key, value: r.value, updatedAt: r.updatedAt });
  }
  return out;
}

/** 清空某个 bot 的已见清单（用户想让它「从头再报一遍」时）。返回删了几条。 */
export async function clearSeen(workspaceId: string, botSlug: string): Promise<number> {
  const r = await prisma.agentLedger.deleteMany({ where: { workspaceId, botSlug, kind: 'seen' } });
  return r.count;
}
