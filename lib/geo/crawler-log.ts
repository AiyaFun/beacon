// 记一次 AI 爬虫来访（2026-08-29）。
//
// 【它在整条 GEO 链上的位置】HeiGe-GEO-SEO 审查里排第一的病灶是
// **「评分与真实被引用率零校准」**——量表打得很细，却从来没有任何一条真实反馈进来过。
// 这个文件是把第一条反馈接进来：**AI 爬虫到底来没来、来的是谁、爬的哪一页。**
// 它回答不了「有没有被引用」，但它能回答「有没有被看见」——而后者是前者的必要条件，
// 且是这条链上第一个不靠推理、只靠事实的数字。
//
// 【三条不许违反的】
// ① **绝不抛**：它挂在真实请求的路径上。一次统计写失败不能连累用户看页面。
// ② **绝不阻塞**：不 await 到响应里去（调用方 fire-and-forget）。
// ③ **不记任何身份**：不存 IP、不存完整 UA、不存查询串。我们要的是「哪个爬虫来过」，
//    而 IP 与查询串既不回答这个问题，又都是个人信息面。
import { prisma } from '../db';
import { beijingDayKey } from '../beijing';
import { identifyAiCrawler } from './ai-crawler';
import { createLogger } from '../logger';

const log = createLogger({ module: 'ai-crawler' });

/** 路径长度上限。爬虫会试各种超长路径，不夹一道会让这张表被垃圾撑大。 */
const MAX_PATH = 200;

/**
 * 归一化路径：去查询串、去尾斜杠、截断。
 *
 * 【为什么必须去查询串】`/hotlists?from=x&t=123` 每次都不一样，
 * 不去掉的话「按 (agent, path, day) 聚合」就退化成一条一行，聚合的意义全没了。
 * 而查询串里还可能带着我们不想留的东西。
 */
export function normalizePath(raw: string): string {
  const p = String(raw ?? '/').split('?')[0].split('#')[0];
  const trimmed = p.length > 1 ? p.replace(/\/+$/, '') : p;
  return (trimmed || '/').slice(0, MAX_PATH);
}

/**
 * 认出来就记一笔，认不出就什么都不做。
 *
 * **同一个 (爬虫, 路径, 天) 只有一行**，重复来访只加计数——见 schema 里那段说明。
 */
export async function recordCrawlerHit(
  userAgent: string | null | undefined,
  path: string,
  now: Date = new Date(),
): Promise<{ recorded: boolean; agent?: string }> {
  const agent = identifyAiCrawler(userAgent);
  if (!agent) return { recorded: false };

  const day = beijingDayKey(now);
  const p = normalizePath(path);
  try {
    // upsert 而不是「先查再写」：爬虫会并发来，先查再写会在同一天同一路径上撞唯一键
    await prisma.aiCrawlerHit.upsert({
      where: { agent_path_day: { agent: agent.token, path: p, day } },
      create: { agent: agent.token, purpose: agent.purpose, path: p, day, count: 1, firstAt: now, lastAt: now },
      update: { count: { increment: 1 }, lastAt: now },
    });
    return { recorded: true, agent: agent.token };
  } catch (e) {
    // 【绝不抛】它挂在真实请求路径上——一次统计写失败不该让用户看不成页面。
    // 但**要留声**：这张表的空与非空是要拿去下结论的（「AI 爬虫到底来没来」），
    // 静默失败会让一个「写不进去」被读成「它们没来」，方向完全错。
    log.warn('AI 爬虫计数写入失败', { error: (e as Error).message, agent: agent.token });
    return { recorded: false, agent: agent.token };
  }
}

/**
 * 调用方用这个：**不等它**。
 *
 * 【为什么单独给一个函数而不是让调用方自己写 void】写成 `void record(...)` 时，
 * 一个未处理的 rejection 在 Node 里会打到进程级。上面虽然已经 catch 了，
 * 但那是「现在」catch 了——收口成一个函数，将来谁改坏了也只坏一处。
 */
export function recordCrawlerHitAsync(userAgent: string | null | undefined, path: string): void {
  void recordCrawlerHit(userAgent, path).catch(() => { /* 见上：统计不该影响请求 */ });
}

export type CrawlerSummaryRow = {
  agent: string;
  purpose: string;
  hits: number;
  days: number;
  lastAt: Date;
};

/**
 * 最近 N 天来过哪些爬虫。给界面用。
 *
 * 【为什么返回 days 而不只是 hits】一个爬虫在一天里来一千次，和它连着三十天每天来一次，
 * 是完全不同的两件事：前者是一次批量抓取，后者才说明它在持续跟进你。
 * 只给总次数会把这两种混成一个数。
 */
export async function crawlerSummary(sinceDays = 30, now: Date = new Date()): Promise<CrawlerSummaryRow[]> {
  const cutoff = beijingDayKey(new Date(now.getTime() - sinceDays * 86_400_000));
  const rows = await prisma.aiCrawlerHit.findMany({
    where: { day: { gte: cutoff } },
    select: { agent: true, purpose: true, count: true, day: true, lastAt: true },
  });
  const by = new Map<string, CrawlerSummaryRow & { dayset: Set<string> }>();
  for (const r of rows) {
    const cur = by.get(r.agent)
      ?? { agent: r.agent, purpose: r.purpose, hits: 0, days: 0, lastAt: r.lastAt, dayset: new Set<string>() };
    cur.hits += r.count;
    cur.dayset.add(r.day);
    if (r.lastAt > cur.lastAt) cur.lastAt = r.lastAt;
    by.set(r.agent, cur);
  }
  return [...by.values()]
    .map(({ dayset, ...rest }) => ({ ...rest, days: dayset.size }))
    .sort((a, b) => b.hits - a.hits);
}

/** 留存天数。计数行很小，但只增不减的表迟早会变成库里最大的那张。 */
export const CRAWLER_HIT_RETENTION_DAYS = 180;

/** 到期清理。由 lib/legal/retention.ts 的每日 sweep 调用。 */
export async function purgeExpiredCrawlerHits(now = Date.now()): Promise<number> {
  const cutoff = beijingDayKey(new Date(now - CRAWLER_HIT_RETENTION_DAYS * 86_400_000));
  // day 是 YYYY-MM-DD 定长字符串，字典序等于时间序，可以直接比
  const r = await prisma.aiCrawlerHit.deleteMany({ where: { day: { lt: cutoff } } });
  return r.count;
}
