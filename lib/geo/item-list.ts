// 给**有真内容的那两页**补 ItemList / BreadcrumbList 结构化数据（2026-09-17）。
//
// ── 为什么这件事比再加一百个关键词重要 ──
// 这个站公开可抓的页只有十来个，其中**只有 /hotlists 和 /topics-today 有真内容**。
// 它们今天对模型是一整团 HTML：能读到字，但读不出「这是一个榜单、有 N 条、第一条是什么」。
// AI 检索要引用一个来源，靠的正是这种结构——一个能直接摘出条目的清单，
// 比一段描述它的散文容易被引用得多。
//
// ── 必须说破的天花板 ──
// 补结构化数据能让这两页**更容易被引用**，但改不了「可索引内容只有两页」这件事。
// 排名的根本前提是有足够多、足够独立的内容页。这一层做完，天花板仍然在那儿。
//
// ⚠️ 空清单一律返回 null（页面不输出 script）。
//    宣称「这一页有个榜单」然后给出零条，比什么都不说更糟。

/** ItemList 的一条。`url` 可选：有些条目（常青选题、节点日历）本来就没有外部链接。 */
export type ListEntry = { name: string; url?: string; description?: string };

/** 一页最多写多少条。热榜本来就是 TOP 榜，第 31 名对「今天什么在热」没有信息量； */
/** 更要紧的是这段 JSON 会进 HTML，条数直接变成首屏体积。 */
const MAX_ENTRIES = 30;

function base(): string {
  return (process.env.BEACON_SITE_URL || process.env.BEACON_PUBLIC_URL || 'https://beacon.iyunci.cn').replace(/\/$/, '');
}

/** 标题清洗：去掉首尾空白、压掉换行。空标题的条目直接丢弃（不给引擎喂空名字）。 */
function clean(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 生成一段 ItemList。
 *
 * @param path 这一页的路径（`/hotlists`），用来拼 @id 与 url
 * @param name 这个清单叫什么
 * @param description 一句话说清这个清单是什么
 * @param entries 条目。**调用方负责过滤掉示例数据与敏感条目**——
 *                这个函数不认识业务规则，它只负责成形。
 */
export function itemListJsonLd(
  path: string,
  name: string,
  description: string,
  entries: readonly ListEntry[],
): object | null {
  const rows = entries
    .map((e) => ({ ...e, name: clean(e.name) }))
    .filter((e) => e.name.length > 0)
    .slice(0, MAX_ENTRIES);
  if (rows.length === 0) return null;

  const site = base();
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    '@id': `${site}${path}#itemlist`,
    name,
    description,
    url: `${site}${path}`,
    // numberOfItems 写的是**这段结构化数据里真的有几条**，不是库里有几条。
    // 写成库里的总数就是拿截断前的数字冒充清单长度——引擎数得出来对不上。
    numberOfItems: rows.length,
    itemListOrder: 'https://schema.org/ItemListOrderDescending',
    itemListElement: rows.map((e, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: e.name,
      ...(e.url ? { url: e.url } : {}),
      ...(e.description ? { description: clean(e.description) } : {}),
    })),
  };
}

/**
 * 面包屑。
 *
 * 【它换来什么】搜索结果里标题下面那一行「烽火台 › 全网热榜」，以及让引擎知道
 * 这一页在站点结构里的位置——对只有两层的小站，后者的价值比前者大。
 */
export function breadcrumbJsonLd(path: string, title: string): object {
  const site = base();
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    '@id': `${site}${path}#breadcrumb`,
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: '烽火台', item: site },
      { '@type': 'ListItem', position: 2, name: title, item: `${site}${path}` },
    ],
  };
}

/**
 * 从热榜条目里挑出该写进结构化数据的那一批。
 *
 * ── 为什么不能直接「按 rank 排序取前 30」──
 * HotItem 存的是**历次采集的快照**，不是当前榜单：生产库里 baidu 有 402 行，
 * 而 rank 只有 1~30 三十个值——也就是攒了约 13 次采集。按 rank 全局排序的结果是
 * 前 23 条**全都自称「第 1 位」**，而且分别来自 09-15、09-16、09-17 三天。
 * 那不是一个榜单，是把三天的冠军堆在一起，还各自宣称自己是第一。
 * 结构化数据是**对搜索引擎的明确断言**，这种句子一条都不能发出去。
 *
 * ── 两条判据 ──
 *   ① 只要每个源**最近一次采集**的那一批。rank 只在单次快照内唯一，跨快照必然重复。
 *   ② 跨平台轮转取，而不是一家取满。全局排序时百度一家占了 30 席里的 11 席——
 *      一个叫「全网热榜聚合」的清单里有三分之一来自同一个平台，名不副实。
 *
 * @param items   库里取出的热榜行（含 source / rank / title / url / fetchedAt / isMock）
 * @param brandOf 源 key → 展示用平台名（传 sourceBrandName，这个模块不认识业务命名）
 */
export function hotItemEntries(
  items: readonly { source: string; rank: number | null; title: string | null; url: string | null; fetchedAt: Date; isMock: boolean }[],
  brandOf: (key: string) => string,
): ListEntry[] {
  // ① 每个源最近一次采集的时刻
  const latest = new Map<string, number>();
  for (const it of items) {
    if (it.isMock) continue;
    const t = it.fetchedAt.getTime();
    if (t > (latest.get(it.source) ?? 0)) latest.set(it.source, t);
  }

  // ② 只留最新那一批，按 rank 排好，按源分组
  const bySource = new Map<string, typeof items[number][]>();
  for (const it of items) {
    if (it.isMock || !clean(it.title)) continue;
    if (it.fetchedAt.getTime() !== latest.get(it.source)) continue;
    if (!bySource.has(it.source)) bySource.set(it.source, []);
    bySource.get(it.source)!.push(it);
  }
  for (const list of bySource.values()) list.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));

  // ③ 跨平台轮转：先每个源第 1 名，再每个源第 2 名……
  const out: ListEntry[] = [];
  const sources = [...bySource.keys()].sort();
  const deepest = Math.max(0, ...[...bySource.values()].map((l) => l.length));
  for (let i = 0; i < deepest && out.length < MAX_ENTRIES; i += 1) {
    for (const src of sources) {
      const it = bySource.get(src)![i];
      if (!it) continue;
      out.push({
        name: it.title!,
        url: it.url && it.url !== '#' ? it.url : undefined,
        description: it.rank ? `${brandOf(it.source)}热榜第 ${it.rank} 位` : `${brandOf(it.source)}热榜`,
      });
      if (out.length >= MAX_ENTRIES) break;
    }
  }
  return out;
}
