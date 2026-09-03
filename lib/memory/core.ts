import { prisma } from '../db';
import { MEMORY_TYPES } from '../constants';
import { upsertMemoryEmbedding, searchMemories } from '../vector/store';
import { memoryThreat } from './guard';
import { createLogger } from '../logger';

const log = createLogger({ module: 'memory' });

// 长期记忆核心（PRD §8）。四类记忆：persona/preference/performance/fact。
// 置信度分级注入：单次行为推断 0.3 只存不用；同类累计 ≥2-3 次才 active 生效。
// 全程可见/可编辑/可删除（在记忆页操作），数据只提议、人设由用户定。

export type MemoryType = keyof typeof MEMORY_TYPES;

const ACTIVATION_HITS = 2; // 累计命中阈值
const ACTIVATION_CONFIDENCE = 0.5;
export const MAX_INJECT = 12; // 单次注入条数硬上限（记忆页显示「注入位」用它）
// DB 侧有界读上限：先按 confidence 降序取宽松前缀，再在 JS 里按「confidence × 时间衰减」重排。
// 因 recencyFactor 上限为 1（衰减只降权不升权），置信度低于当前第 MAX_INJECT 名衰减分的条目
// 不可能翻身进注入位，故取远大于 MAX_INJECT 的前缀即对正确性充分，同时给规模封顶（防全表载入）。
const RECALL_SCAN_LIMIT = 200;

// 遗忘衰减：老结论降权但不清零。半衰期 30 天——一条 60 天没被再次验证的记忆，
// 权重只剩 1/4；下限 0.2 保证老经验永远还有机会被召回（内容口味会回潮，作废等于失忆）。
const DECAY_HALF_LIFE_DAYS = 30;
const DECAY_FLOOR = 0.2;

function recencyFactor(updatedAt: Date, now: number): number {
  const ageDays = Math.max(0, (now - updatedAt.getTime()) / 86_400_000);
  return Math.max(DECAY_FLOOR, Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS));
}

export async function writeMemory(params: {
  workspaceId: string;
  accountId?: string;
  type: MemoryType;
  content: string;
  confidence?: number;
}) {
  // 【注入形状一律不落库】记忆会进以后每一次生成的系统提示，写进去的注入是持久的。
  // 抛错而不是静默跳过：静默跳过 = 调用方以为记住了（模型会对用户说「记住了」）。
  // 各条写入路径里模型那条（write_memory 工具）在调用前已用 guardModelMemory 判过并把
  // 理由回给模型；这里是给所有路径兜底的最后一道，包括系统自己生成的那些。
  const threat = memoryThreat(params.content);
  if (threat) throw new Error(`拒绝写入长期记忆：${threat}`);
  // 同类同内容去重累加（提升 hitCount 与置信度）
  const existing = await prisma.memoryEntry.findFirst({
    where: {
      workspaceId: params.workspaceId,
      accountId: params.accountId ?? null,
      type: params.type,
      content: params.content,
    },
  });
  if (existing) {
    // 原子自增，不是 read-modify-write。
    // 此前是「读到 1 → 写 2」：两个并发调用者（如 backfill_metrics 同一轮打两个里程碑，
    // 或手动回填与定时任务撞上，两条路都汇进 learnFromPerformance）会双双读到 1、双双写 2，
    // 少算一次。而激活阈值正是 hitCount >= 2 —— 少算一次就意味着「已被反复验证的结论」
    // 永远不激活、永远进不了 prompt，且不会有任何报错。
    await prisma.memoryEntry.updateMany({
      where: { id: existing.id },
      data: { hitCount: { increment: 1 }, confidence: { increment: 0.2 } },
    });
    // 自增后的真值只能回读；据此再定 active 并把 confidence 钳回 ≤1。
    // 并发的两个调用者回读后算出的结论一致（幂等），不会互相打架。
    const after = await prisma.memoryEntry.findUnique({ where: { id: existing.id } });
    if (!after) return existing; // 并发删除，放弃本次累加
    const confidence = Math.min(1, after.confidence);
    return prisma.memoryEntry.update({
      where: { id: after.id },
      data: { confidence, active: after.hitCount >= ACTIVATION_HITS || confidence >= 0.7 },
    });
  }
  const confidence = params.confidence ?? 0.3;
  const entry = await prisma.memoryEntry.create({
    data: {
      workspaceId: params.workspaceId,
      accountId: params.accountId,
      type: params.type,
      content: params.content,
      confidence,
      hitCount: 1,
      // persona 类由用户显式确认，默认生效；推断类需累计
      active: params.type === 'persona' ? true : confidence >= ACTIVATION_CONFIDENCE,
    },
  });
  // 计算并存储向量（语义召回用）；失败不阻断
  await upsertMemoryEmbedding(entry.id, params.content).catch(() => {});
  return entry;
}

/**
 * 注入进提示之前再扫一遍。
 *
 * 【为什么写入口拦了还要在这里拦】这道闸是 2026-09-02 才加的，之前写进去的存量记忆
 * 没有经过它；而且记忆页允许用户手改内容，那条路不该拦人（他自己的账号），
 * 但改出来的东西照样会进系统提示。两个入口只拦一个等于没拦。
 * 命中的条目不删（那是用户的数据，删要他自己删），只是不注入，并留一条日志。
 */
function dropThreats<T extends { id: string; content: string }>(rows: T[]): T[] {
  return partitionThreats(rows).kept;
}
function partitionThreats<T extends { id: string; content: string }>(rows: T[]): { kept: T[]; skipped: { id: string; reason: string }[] } {
  const kept: T[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const r of rows) {
    const t = memoryThreat(r.content);
    if (t) {
      log.warn('一条记忆长得像注入，未注入提示', { id: r.id, reason: t });
      skipped.push({ id: r.id, reason: t });
    } else kept.push(r);
  }
  return { kept, skipped };
}

/**
 * 注入明细：哪些条目**真的**会带进提示、哪些被守卫跳过。记忆页用它把「已生效」和「在用」分开——
 * active 超过 MAX_INJECT 条时，第 13 条起根本没进提示，页面上一律标「已生效·正注入」就是假话。
 * 排序与 recallForInjection 完全同一份（后者就是它的包装）。
 */
export async function recallForInjectionDetailed(workspaceId: string, accountId?: string): Promise<{
  injected: { id: string; type: string; content: string; updatedAt: Date; hitCount: number }[];
  skipped: { id: string; reason: string }[];
  limit: number;
}> {
  const entries = await prisma.memoryEntry.findMany({
    where: {
      workspaceId,
      OR: [{ accountId: accountId ?? null }, { accountId: null }],
      active: true,
    },
    orderBy: [{ confidence: 'desc' }, { updatedAt: 'desc' }],
    take: RECALL_SCAN_LIMIT,
  });
  const now = Date.now();
  const { kept, skipped } = partitionThreats(entries);
  const injected = kept
    .map((e) => ({ e, score: e.confidence * recencyFactor(e.updatedAt, now) }))
    .sort((a, b) => b.score - a.score || b.e.hitCount - a.e.hitCount)
    .slice(0, MAX_INJECT)
    .map(({ e }) => ({ id: e.id, type: e.type, content: e.content, updatedAt: e.updatedAt, hitCount: e.hitCount }));
  return { injected, skipped, limit: MAX_INJECT };
}

// 读取生效记忆用于注入 prompt（限量）。
// 排序分 = confidence × 时间衰减：纯按置信度排会让攒了几个月 hitCount 的老结论
// 永远霸占 12 个注入位，新学到的东西挤不进去。衰减在 JS 里算（SQLite 排序算不了幂），
// 但 DB 侧仍按 confidence 降序有界读（RECALL_SCAN_LIMIT）——衰减只降权不升权，宽松前缀对 top-N 充分，
// 不必把整库 active 记忆全量载进 JS。同分再按 updatedAt 新→旧，让前缀更贴近衰减后的真实排序。
export async function recallForInjection(workspaceId: string, accountId?: string): Promise<string[]> {
  const { injected } = await recallForInjectionDetailed(workspaceId, accountId);
  return injected.map((e) => memoryLine(e.type, e.content, e.updatedAt, e.hitCount));
}

// R7 记忆可见化：注入行带上「什么时候学到的 / 被验证过几次」。
// 没有这两个信息，模型只能说「根据你的偏好」这种谁都会说的空话；有了才能说出
// 「因为你上月那条清单体跑赢了基线，这次也建议走清单体」——用户据此能判断这条建议
// 是不是真的基于自己的历史，而不是模型顺口编的。
export function relativeAge(updatedAt: Date, now: number = Date.now()): string {
  const days = Math.floor((now - updatedAt.getTime()) / 86_400_000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days}天前`;
  if (days < 14) return '上周';
  if (days < 35) return '上月';
  if (days < 90) return `${Math.round(days / 30)}个月前`;
  return '更早';
}

export function memoryLine(type: string, content: string, updatedAt: Date, hitCount: number): string {
  const name = MEMORY_TYPES[type as MemoryType]?.name ?? type;
  // hitCount>1 才写次数：写「验证1次」既没信息量又容易被模型当成强证据引用
  const verified = hitCount > 1 ? ` · 已重复验证${hitCount}次` : '';
  return `[${name} · ${relativeAge(updatedAt)}${verified}] ${content}`;
}

// 把记忆注入 system prompt 段。
// 传入 query（如当前选题/热点）→ 语义召回最相关记忆；否则按置信度召回。
export async function buildMemoryContext(workspaceId: string, accountId?: string, query?: string): Promise<string> {
  let lines: string[];
  if (query) {
    const hits = await semanticRecall(workspaceId, accountId, query);
    lines = hits.length > 0 ? hits : await recallForInjection(workspaceId, accountId);
  } else {
    lines = await recallForInjection(workspaceId, accountId);
  }
  if (lines.length === 0) return '';
  // R7 记忆可见化：让「引用了哪条记忆」在输出里看得见。
  //
  // 这条指令放在这里而不是各个 prompt 站点，是刻意的：buildMemoryContext 是全站记忆注入的
  // 唯一入口（选题精排 / 智囊团 / 创作工坊 / 助手 / 热点组合都走它），改这一处等于改全部，
  // 而挨个改十几个 prompt 才是真正会漏、会漂移的做法。
  //
  // ⚠️ 末句「不改变输出格式」不是客套：这些站点里有一半要求模型返回严格 JSON（finePrompt 等），
  // 少了它，模型会在 JSON 前面加一段「因为你上月…」的说明把解析打挂。
  //
  // 但这句话**不能出现「JSON」二字**。真实模型实测（MiniMax-Text-01）：末句写成
  // 「…要求返回 JSON 的仍然只返回 JSON」时，连**没要求 JSON 的自然语言场景**（创作工坊初稿、
  // 助手对话）都会被带得吐出裸 JSON——对照实验确认是这句话导致的，去掉记忆块或去掉这句都不会。
  // 提一个格式名就等于给它一个默认格式。改成只说「保持本次任务原有的格式」，不点名任何格式。
  //
  // 同理第二句：方括号里是元信息（类型·时间·验证次数），不说清楚模型会把「偏好记忆」这种
  // 类型名当成事实的一部分念出来（实测出现过「因为你今天有偏好记忆显示…」）。
  //
  // ⚠️ 这里**不能写占位符模板**。原文是「写成『因为你<时间><那条记忆讲的事实>，所以…』」，
  // 真机 2026-07-30（MiniMax-Text-01）把尖括号连同内容一起照抄进用户可见的推荐理由：
  //     「因为你<2023-09-15 · 家庭理财与保险避坑博主>，受众是…」——6 条推荐里 3 条这样。
  // 而且那个日期是**编的**：memoryLine 输出的时间是「上月」「本周」这类相对说法，
  // 库里根本没有任何年月日。一句「让用户能核对来历」的话，配上一个核对不了的假日期，
  // 比不写更糟——正是下面第「没有真正用到就不要硬凑」那句要防的事。
  //
  // ⚠️ 第一版改法是「把模板换成例句」，实测**更糟**：模型把例句里那条虚构的
  // 「你上月那条清单体跑赢了基线」当成用户的真实数据抄进了推荐理由（这个新租户库里
  // 一条这样的记忆都没有）。教训是——这段说明里**任何**长得像事实的句子都会被当素材抄走。
  // 所以最终版一句可抄的假事实都不给：只描述该怎么引用，配一组硬性禁止项。
  return [
    '【账号长期记忆（越用越懂，仅供参考，可能过时）】',
    ...lines,
    '',
    '每行开头方括号里是元信息（记忆类型 · 学到的时间 · 被重复验证的次数），不是事实内容本身。',
    '使用要求：当你的建议确实基于上面某条记忆时，把依据点明，让用户能核对这条建议的来历——',
    '用那条记忆自己的说法复述它讲的事实，并带上它那一行方括号里的时间词（如「上月」「本周」「更早」）。',
    '硬性约束：',
    '（1）不许出现尖括号占位符；',
    '（2）不许写具体日期——方括号里没有年月日，你写出的任何日期都是编的；',
    '（3）不许照抄本说明里的任何字句当成用户的事实；',
    '（4）只能引用上面真实列出的记忆行，一条都不许自己造；',
    '（5）不要把「偏好记忆」这类类型名念进句子里；',
    // 实测：只说「别念类型名」不够，模型会把整段方括号前缀原样抄进正文
    //（「[人设记忆 · 今天] 账号定位：…」）——那是给模型看的标注，不是给用户看的话。
    '（6）不许把方括号那段标注原样抄进回答——它是给你看的元信息，不是正文的一部分。',
    '没有真正用到记忆就**不要**硬凑这句话（编造引用比不引用更糟）；',
    '记忆与当前事实冲突时以当前事实为准，并直说「与此前记录不同」。',
    '以上只影响你**行文措辞**，不改变本次任务原有的输出格式与结构要求。',
  ].join('\n');
}

// 语义召回：返回格式化的记忆行（带相关度排序）
export async function semanticRecall(workspaceId: string, accountId: string | undefined, query: string): Promise<string[]> {
  const hits = dropThreats(await searchMemories(workspaceId, accountId, query, MAX_INJECT));
  if (hits.length === 0) return [];
  // R7：补 updatedAt/hitCount 好让注入行带上「什么时候学到的/验证过几次」。
  // 刻意用一次 id 回查，而不是给 searchMemories 的 SELECT 加列——那条 postgres 分支是
  // 手写 raw SQL（pgvector），本地 sqlite 跑不到它，改了没法验证。回查是零风险的等价做法。
  const rows = await prisma.memoryEntry.findMany({
    where: { id: { in: hits.map((h) => h.id) } },
    select: { id: true, updatedAt: true, hitCount: true },
  });
  const meta = new Map(rows.map((r) => [r.id, r]));
  return hits.map((h) => {
    const m = meta.get(h.id);
    // 回查不到（并发删除）→ 退回不带时间的旧格式，不因为装饰信息缺失就丢掉这条记忆
    return m
      ? memoryLine(h.type, h.content, m.updatedAt, m.hitCount)
      : `[${MEMORY_TYPES[h.type as MemoryType]?.name ?? h.type}] ${h.content}`;
  });
}

// R7 记忆可见化 · 周报用：「烽火台这周记住了你的 N 件事」。
//
// 全部在代码里算，不经 LLM——这是「系统到底记住了什么」的事实陈述，让模型复述一遍
// 只会引入改写和幻觉。用户看到的必须与库里那几条逐字对应，否则「可见化」就成了新的黑箱。
//
// 只取本周期内 updatedAt 有变动的：包含新学到的，也包含老结论被再次验证（hitCount+1）的——
// 后者恰恰是最该让用户看到的（「这条我又验证了一次」比「我新猜了一条」有价值得多）。
export type LearnedMemory = {
  type: string;
  typeName: string;
  content: string;
  hitCount: number;
  /** 本周期内是否是首次出现（false = 老结论被再次验证） */
  isNew: boolean;
};

export async function recentlyLearnedMemories(
  workspaceId: string,
  accountId: string | undefined,
  since: Date,
  take = 3,
): Promise<LearnedMemory[]> {
  const entries = await prisma.memoryEntry.findMany({
    where: {
      workspaceId,
      OR: [{ accountId: accountId ?? null }, { accountId: null }],
      active: true,
      updatedAt: { gte: since },
    },
    // 重复验证过的排前面（hitCount），再按置信度——「反复验证的结论」比「刚冒头的猜测」更值得报
    orderBy: [{ hitCount: 'desc' }, { confidence: 'desc' }, { updatedAt: 'desc' }],
    take,
  });
  return entries.map((e) => ({
    type: e.type,
    typeName: MEMORY_TYPES[e.type as MemoryType]?.name ?? e.type,
    content: e.content,
    hitCount: e.hitCount,
    isNew: e.createdAt >= since,
  }));
}

// 互斥记忆下线：写入某结论前，把同类的「反面结论」置 active=false（不删，hitCount 留着，
// 数据反转时反方向走去重累计还能重新生效）。learn.ts 早有一个写死 type='preference' 的私有版本；
// 这里泛化出通用工具，供复盘的曲线形态记忆（performance 类，如「首日爆发型」vs「长尾型」）等复用。
export async function deactivateOppositeMemory(
  workspaceId: string,
  accountId: string,
  type: MemoryType,
  oppositeContents: string[],
): Promise<void> {
  const contents = oppositeContents.filter(Boolean);
  if (contents.length === 0) return;
  await prisma.memoryEntry.updateMany({
    where: { workspaceId, accountId, type, content: { in: contents }, active: true },
    data: { active: false },
  });
}

// 把模型抄进正文的记忆行标注洗掉。
//
// 背景：memoryLine 给每条注入的记忆加了 `[类型名 · 时间 · 已重复验证N次]` 前缀，那是给模型看的
// 元信息。prompt 里明确说过它不是正文、别念类型名、别原样抄——三轮加码都没治住：
// 真机 2026-07-30（MiniMax-Text-01）最后一轮 6 条推荐理由里 5 条带着「[人设记忆 · 今天]」出街，
// 加了「不许把方括号那段标注原样抄进回答」之后反而从 1 条涨到 5 条（越强调越显著）。
//
// 结论：这类「模型必须记得不做某事」的约束，靠 prompt 是概率性的，靠代码才是确定的。
// prompt 里的那几条留着（能降低发生率、也解释了意图），但**最终保证**由这个函数给。
// 只删标注本身，不动它后面的句子——那句话通常是有效引用，删了会把好内容一起删掉。
const MEMORY_TAG_RE = /\[[^\]\n]{0,12}记忆\s*·[^\]\n]{0,40}\]\s*/g;
// 删完之后的接缝：模型常写「根据[人设记忆 · 今天]的记录…」，删掉标注就剩「根据的记录」。
// 只在**确实删过标注**时才做这一步——「我根据的是数据」这种正常句子不能被误改。
const DANGLING_DE_RE = /(根据|依据|基于)的/g;

export function stripMemoryTags(text: string): string {
  if (!text) return text;
  const stripped = text.replace(MEMORY_TAG_RE, '');
  if (stripped === text) return text; // 没有标注，原样返回，绝不碰正常文本
  return stripped.replace(DANGLING_DE_RE, '$1').replace(/\s{2,}/g, ' ').trim();
}
