// AI 引用回执：AI 回答里到底引了谁，其中有没有你自己的东西（2026-08-29）。
//
// ── 它回答的问题，和 AI 爬虫计数不是同一个 ──
// `lib/geo/crawler-log.ts` 回答「有没有被**看见**」（爬虫来过没有）；
// 这里回答「有没有被**用上**」（回答里真的引了你）。后者才是 GEO 的终点，
// 但它拿不到全量——只能一次问一句、看一次结果，所以**永远是样本，不是统计**。
//
// ── 因此有一条贯穿全文件的红线：不出百分比 ──
// n=1 印成百分比是这条路上最容易犯、也最难被发现的错：
// 「你的内容被引用率 33%」听起来像个指标，其实是「问了 3 次中了 1 次」。
// 所以本模块**只产出条目与计数**，不产出比率、份额、概率、趋势曲线。
// （08-11 评估里明确列过的「不做」清单，这里逐条守住。）
//
// ── 归属只认精确匹配 ──
// 判断「这条引用是不是你的」**必须**走 parsePublishUrl 拿到 (platform, platformItemId)
// 再与 PublishRecord 精确比对。**绝不许按 host 猜**——`mp.weixin.qq.com` 是全国
// 所有公众号共用的域名，按 host 判等于把别人的文章算成你的。
import { prisma } from '../db';
import { parsePublishUrl } from '../publish/parse-url';
import type { PlatformKey } from '../constants';
import { createLogger } from '../logger';

const log = createLogger({ module: 'ai-citation' });

/** 一条 AI 回答里最多认多少条引用。超出的丢掉——一页上百条链接多半是导航不是引用。 */
export const MAX_CITATIONS = 40;

/** 留存天数。与爬虫计数同档。 */
export const CITATION_RETENTION_DAYS = 180;

/**
 * 认得的 AI 回答页。
 *
 * 【robotsNote 不是判据，只是说明】真正拦不拦由 browseLocal 里那次**实时** robots.txt
 * 读取决定（那是机器闸）。这里写下来只是为了在界面上**提前告诉用户为什么读不了**——
 * 否则元宝那条路会表现成「点了没反应」，而真相是它自己不让抓。
 * ⚠️ 这是 2026-08-29 实测的快照，站点随时可能改；**它错了不影响安全**（闸在别处），
 * 只影响提示语准不准。
 */
export type AiAnswerSite = {
  engine: string;
  hostMatch: string;
  /** 2026-08-29 实测该站 robots.txt 对回答页的态度 */
  robotsNote: string;
  /** 实测判断：这条路现在走不走得通 */
  expectBlocked: boolean;
};

export const AI_ANSWER_SITES: readonly AiAnswerSite[] = [
  {
    engine: '豆包',
    hostMatch: 'doubao.com',
    robotsNote: '2026-08-29 实测：robots.txt 未禁止对话页（只禁了 /thread/ /bot/ /article/ 等）。',
    expectBlocked: false,
  },
  {
    engine: '腾讯元宝',
    hostMatch: 'yuanbao.tencent.com',
    // 这一条是这个功能最重要的一句话：不是我们做不到，是它明说了不许
    robotsNote: '2026-08-29 实测：robots.txt 里 `Disallow: /chat/` —— **对话页它自己禁止抓取**。'
      + '我们不绕 robots，所以元宝这条路读不了。这不是故障。',
    expectBlocked: true,
  },
] as const;

/** 这个网址属于哪个 AI 回答站。认不出返回 null。 */
export function answerSiteOf(url: string): AiAnswerSite | null {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  return AI_ANSWER_SITES.find((s) => host === s.hostMatch || host.endsWith(`.${s.hostMatch}`)) ?? null;
}

export type CitationCandidate = {
  url: string;
  title: string;
  platform: PlatformKey | null;
  platformItemId: string | null;
};

/**
 * 从页面外链里挑出「像引用」的那些。
 *
 * 【为什么不试图判断「哪个才是引用区」】各家版式不同、随时改版，靠选择器认引用区
 * 是最脆的一种做法。改为：**认得出是某个平台的作品链接**的就算候选，其余全部丢掉。
 * 这条判据由 parsePublishUrl 提供，它本来就是为「这是不是一条作品链接」写的，
 * 而且**认不出就说认不出**（no-item-id / unknown-host），不会瞎猜。
 * 代价是漏掉非平台来源（新闻站、政府网站）——那些本来也不是创作者能优化的东西。
 */
export function extractCitations(
  links: readonly { href: string; text: string }[],
): CitationCandidate[] {
  const out: CitationCandidate[] = [];
  const seen = new Set<string>();
  for (const l of links) {
    if (out.length >= MAX_CITATIONS) break;
    const parsed = parsePublishUrl(l.href);
    if (!parsed.ok) continue; // 认不出作品 ID 的一律不收——绝不按 host 猜
    const key = `${parsed.platform}:${parsed.platformItemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      url: parsed.canonicalUrl,
      title: (l.text || '').slice(0, 200),
      platform: parsed.platform,
      platformItemId: parsed.platformItemId,
    });
  }
  return out;
}

export type AttributedCitation = CitationCandidate & {
  /** 命中了自己的哪条发布记录。没命中就是 null——**不是「可能是」，是「不是」** */
  matchedRecordId: string | null;
  matchedAccountId: string | null;
};

/**
 * 把候选与「这个工作区自己发过的东西」精确比对。
 *
 * 【为什么是 (platform, platformItemId) 两个字段一起比】只比 itemId 会跨平台撞车
 * （抖音与 TikTok 的 id 形态一模一样，代码里专门注释过「平台靠域名分，不靠 ID 形态分」）。
 */
export async function attributeCitations(
  workspaceId: string,
  candidates: readonly CitationCandidate[],
): Promise<AttributedCitation[]> {
  if (candidates.length === 0) return [];
  const ids = candidates.map((c) => c.platformItemId).filter((x): x is string => !!x);
  const mine = await prisma.publishRecord.findMany({
    where: {
      platformItemId: { in: ids },
      account: { workspaceId },
    },
    select: { id: true, accountId: true, platform: true, platformItemId: true },
  });
  const byKey = new Map(mine.map((m) => [`${m.platform}:${m.platformItemId}`, m]));
  return candidates.map((c) => {
    const hit = byKey.get(`${c.platform}:${c.platformItemId}`);
    return { ...c, matchedRecordId: hit?.id ?? null, matchedAccountId: hit?.accountId ?? null };
  });
}

/**
 * 落库。一次问答一批。
 *
 * 【为什么连「不是我的」那些也记】同一个问题下 AI 引了哪几个平台，是能直接指导选题的
 * ——「这类问题它只引公众号」比任何评分都有用。
 * 但**只记平台与链接，不记作者、不排榜**（08-11 明确列过「被引作者榜」不做：
 * 那会变成一个盯着同行的东西，而不是帮你写下一篇）。
 */
export async function saveCitations(input: {
  tenantId: string;
  workspaceId: string;
  engine: string;
  answerUrl: string;
  question: string;
  citations: readonly AttributedCitation[];
  now?: Date;
}): Promise<{ saved: number; mine: number }> {
  const now = input.now ?? new Date();
  const rows = input.citations.slice(0, MAX_CITATIONS);
  if (rows.length === 0) return { saved: 0, mine: 0 };
  try {
    await prisma.aiCitation.createMany({
      data: rows.map((c) => ({
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        engine: input.engine,
        answerUrl: input.answerUrl.slice(0, 500),
        question: input.question.slice(0, 300),
        sourceUrl: c.url,
        sourceTitle: c.title,
        platform: c.platform ?? '',
        platformItemId: c.platformItemId ?? '',
        isMine: !!c.matchedRecordId,
        matchedRecordId: c.matchedRecordId,
        matchedAccountId: c.matchedAccountId,
        capturedAt: now,
      })),
    });
  } catch (e) {
    // 不抛（旁路记录），但要留声：静默失败会让「一条引用都没有」这个结论站不住——
    // 那到底是真没被引用，还是每次都写库失败？
    log.warn('引用回执写入失败', { error: (e as Error).message, engine: input.engine });
    return { saved: 0, mine: 0 };
  }
  return { saved: rows.length, mine: rows.filter((c) => c.matchedRecordId).length };
}

/** 到期清理。由 lib/legal/retention.ts 的每日 sweep 调用。 */
export async function purgeExpiredCitations(now = Date.now()): Promise<number> {
  const cutoff = new Date(now - CITATION_RETENTION_DAYS * 86_400_000);
  const r = await prisma.aiCitation.deleteMany({ where: { capturedAt: { lt: cutoff } } });
  return r.count;
}
