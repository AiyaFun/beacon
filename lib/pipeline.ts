import { prisma } from './db';
import { toJson, parseJson, type Metrics } from './json';
import { heatForSort, normalizedHeat } from './insight/heat';
import { isRemovalRequested } from './legal/removal';
import { fetchAllHot, fetchCompetitorPosts } from './adapters/registry';
import { readPersona, type PersonaCard } from './persona';
import { buildAccountContext } from './account-context';
import { runScoring, finePrompt, coarseRank, textShingles, type Candidate } from './topic/scoring';
import { computeSaturation } from './topic/saturation';
import { semanticPersonaFit } from './topic/semantic';
import { pickExploration, EXPLORATION_NOTE } from './topic/explore';
import { allocateByQueue } from './topic/queue';
import { demandProxy, blueSeaByTitle } from './topic/bluesea';
import { gapCandidates } from './topic/sources/gap';
import {
  loadOwnWorks, enrichWithRecycle, platformBaselines, crossPlatformCandidates,
  dropDuplicateCrossPlat, type OwnWork,
} from './topic/sources/recycle';
import { calendarCandidates } from './topic/sources/calendar';
import { enrichCandidatesWithMaterial } from './topic/sources/material';
import { applyInspirationForAccount } from './topic/sources/inspiration';
import { recordCollectionRun, type CollectionChannel } from './ingest/collection-run';
import { getEmbedder, cosine } from './vector/embed';
import { llmComplete, resolveProvider } from './llm/gateway';
import { computeLifecycle } from './hot/lifecycle';
import { isSensitiveTitle } from './hot/sensitive';
import { angleTrackRecordBlock } from './insight/learn';
import { recordCompetitorDaily } from './insight/growth-store';

// 敏感词库已拆到 lib/hot/sensitive.ts（候选源要用，留在这里会循环依赖）。
// 原样再导出：sensitiveHits/isSensitiveTitle/SENSITIVE_RULES_VERSION 长期被当作 pipeline 的公开面使用，
// 拆文件是内部重构，不该让调用方跟着改 import。
export { sensitiveHits, isSensitiveTitle, SENSITIVE_RULES_VERSION, type SensitiveHit } from './hot/sensitive';

// AI 管线（PRD §6）：采集 → 清洗入库 → 打分 → 推荐生成。
// 开发态同步执行（进程内）；生产态由 BullMQ/cron 编排（三轨：广播型/批租户型/事件驱动）。

// 1) 热榜采集入库（广播型，全租户共享）。
// upsert by [source, title]：保留 firstSeenAt / peakRank / peakHeat，计算 lifecycle 阶段。
export async function ingestHot(): Promise<{ inserted: number; degraded: string[] }> {
  const results = await fetchAllHot();
  const degraded: string[] = [];
  let inserted = 0;
  const now = new Date();
  for (const r of results) {
    if (r.degraded) degraded.push(r.source);
    if (r.entries.length === 0) continue;
    // 真源恢复供数 → 立刻清掉该源上一轮留下的示例条目。
    // 不清的话它们只会随 lifecycle 慢慢 cooling/faded，中间这段时间**混在真榜单里**：
    // 真机 2026-07-30 百度榜里躺着一条演示词条「灵活就业人数破两亿」，而板块徽标是
    // 「全部 isMock 才标示例」，于是这条假词条在一片真数据里完全看不出来。
    if (!r.degraded) {
      await prisma.hotItem.deleteMany({ where: { source: r.source, isMock: true } });
    }
    const seenTitles = new Set<string>();
    for (const e of r.entries) {
      seenTitles.add(e.title);
      const heat = e.heat ?? 0;
      const existing = await prisma.hotItem.findUnique({
        where: { source_title: { source: e.source, title: e.title } },
      });
      if (existing) {
        const peakHeat = Math.max(existing.peakHeat ?? 0, heat);
        const peakRank = Math.min(existing.peakRank ?? e.rank, e.rank);
        const lifecycle = computeLifecycle(
          { heat, peakHeat, firstSeenAt: existing.firstSeenAt, lastSeenAt: now, source: e.source },
          now,
        );
        await prisma.hotItem.update({
          where: { id: existing.id },
          data: { rank: e.rank, heat, url: e.url, extra: toJson(e.extra ?? {}), isMock: r.degraded, fetchedAt: now, lastSeenAt: now, peakRank, peakHeat, lifecycle },
        });
      } else {
        await prisma.hotItem.create({
          data: {
            source: e.source, rank: e.rank, title: e.title, url: e.url, heat, extra: toJson(e.extra ?? {}),
            isMock: r.degraded, fetchedAt: now, firstSeenAt: now, lastSeenAt: now, peakRank: e.rank, peakHeat: heat, lifecycle: 'rising',
          },
        });
      }
      inserted++;
    }
    // 不在本轮榜单上的旧条目 → 标记 cooling/faded（分批处理，避免一次全量加载）
    const STALE_BATCH = 500;
    let staleCursor: string | undefined;
    while (true) {
      const stale = await prisma.hotItem.findMany({
        where: { source: r.source, title: { notIn: [...seenTitles] } },
        take: STALE_BATCH,
        ...(staleCursor ? { skip: 1, cursor: { id: staleCursor } } : {}),
        orderBy: { id: 'asc' },
      });
      if (stale.length === 0) break;
      staleCursor = stale[stale.length - 1].id;

      const toDelete: string[] = [];
      const toUpdate: { id: string; lifecycle: string }[] = [];
      for (const s of stale) {
        const lifecycle = computeLifecycle(
          { heat: 0, peakHeat: s.peakHeat, firstSeenAt: s.firstSeenAt, lastSeenAt: s.lastSeenAt, source: s.source },
          now,
        );
        if (lifecycle === 'faded') {
          toDelete.push(s.id);
        } else {
          toUpdate.push({ id: s.id, lifecycle });
        }
      }
      if (toDelete.length > 0) {
        await prisma.hotItem.deleteMany({ where: { id: { in: toDelete } } });
      }
      // updateMany 只能设同一个值，lifecycle 因条目而异需逐组更新
      const byLifecycle = new Map<string, string[]>();
      for (const u of toUpdate) {
        const ids = byLifecycle.get(u.lifecycle) ?? [];
        ids.push(u.id);
        byLifecycle.set(u.lifecycle, ids);
      }
      for (const [lifecycle, ids] of byLifecycle) {
        await prisma.hotItem.updateMany({ where: { id: { in: ids } }, data: { lifecycle } });
      }

      if (stale.length < STALE_BATCH) break;
    }
  }
  return { inserted, degraded };
}

// 2a) 单个竞对采集：拉取新作品 upsert 入库（自定义添加竞对后立即试采也走这里）
//
// ledger：传了就落一条采集台账（见 lib/ingest/collection-run.ts）。竞对档案是全局共享的，
// 这个函数本身不知道是"谁"在采，所以工作区与通道必须由调用方给——给不出就不记，
// 绝不拿某个工作区顶包。
export async function crawlOneCompetitor(
  competitorId: string,
  ledger?: { workspaceId: string; channel: CollectionChannel },
): Promise<{ posts: number; degraded: boolean }> {
  const competitor = await prisma.competitorAccount.findUnique({ where: { id: competitorId } });
  if (!competitor) return { posts: 0, degraded: false };
  // 数据移除申请执行闸（PIPL 拒绝权）：被申请移除的账号一律不再采集。
  // 这张表此前只有写入没有执行——公开页收下申请却没有任何代码兑现它。
  if (await isRemovalRequested(competitor.platform, competitor.handle)) {
    if (ledger) {
      await recordCollectionRun({
        ...ledger,
        scope: 'rival',
        platform: competitor.platform,
        targetId: competitor.id,
        targetName: competitor.name,
        items: 0,
        note: '该账号已提交数据移除申请，按拒绝权停止采集',
      });
    }
    return { posts: 0, degraded: false };
  }
  const res = await fetchCompetitorPosts(competitor.platform, competitor.handle);
  // Mock 绝不落库。真机 2026-07-29：用户加「人民日报」时，添加动作自带的那次试采因为
  // 公众号没有服务端通道而落到 Mock，往库里写了 7 条假文章（标题是「为什么你的完播率一直上不去」
  // 这类通用文案，还带上百万编造播放量），排在插件采到的 20 条真文章前面。
  // 更糟的是那些假指标会进 buildBaseline 当竞对基准——这类污染是永久的，删掉才没有。
  // 展示层要示例数据自己去调 fetchCompetitorPosts（带 isMock 标注），持久化这一层一律拒收。
  if (res.isMock) {
    if (ledger) {
      await recordCollectionRun({
        ...ledger,
        scope: 'rival',
        platform: competitor.platform,
        targetId: competitor.id,
        targetName: competitor.name,
        items: 0,
        note: '该平台没有服务端采集通道，未入库任何作品（示例数据一律不落库）',
      });
    }
    return { posts: 0, degraded: true };
  }
  let posts = 0;
  let newCount = 0;
  let updCount = 0;
  for (const p of res.posts) {
    // metrics 为 undefined = 本通道天生无指标（RSS 变更监控只知道"发了新内容"）。
    // 这时 update 分支必须什么都不写——写 {} 会把商业 API/插件通道已采到的真实指标抹成零。
    const views = p.metrics?.views ?? 0;
    const hotScore = Math.round((views / 20000) * 10) / 10;
    // 此前这里是一条 upsert。改成先查再写，是为了能落 PostMetricSnapshot——
    // upsert 不告诉你「这条是新建还是更新、指标有没有变」，而快照只该在**指标真的变了**时落，
    // 否则每轮采集都追加一条一模一样的记录，趋势图上是一条假的水平线 + 无限膨胀的表。
    // 口径与插件通道（lib/ingest/competitor.ts）完全一致，两条通道的快照可以混在一条曲线上。
    const existing = await prisma.crawledPost.findUnique({
      where: { platform_platformItemId: { platform: p.platform, platformItemId: p.platformItemId } },
      select: { id: true, metrics: true },
    });
    if (existing) {
      if (p.metrics) {
        // 每次采集都留时点（与插件通道 lib/ingest/competitor.ts 同口径）。
        // 原来「和上次一样就不写」，会让「没涨」和「没采」在序列上无法区分，
        // 且与展示值四舍五入叠加后，大号可能几个月写不出一条快照。
        // 这条是服务端通道（RSS/定时抓取），与插件在页面上采的不是一回事，来源要分开标
        await prisma.postMetricSnapshot.create({ data: { postId: existing.id, metrics: toJson(p.metrics), source: 'server' } });
        await prisma.crawledPost.update({ where: { id: existing.id }, data: { metrics: toJson(p.metrics), hotScore } });
      }
      updCount++;
    } else {
      const created = await prisma.crawledPost.create({
        data: {
          competitorId,
          platform: p.platform,
          platformItemId: p.platformItemId,
          title: p.title,
          summary: p.summary,
          url: p.url,
          publishedAt: p.publishedAt,
          metrics: toJson(p.metrics ?? {}),
          hotScore,
        },
      });
      // 首次入库也落一条快照：它是这条作品趋势的起点，缺了它第二次采集就只有一个点画不出线
      if (p.metrics) {
        await prisma.postMetricSnapshot.create({ data: { postId: created.id, metrics: toJson(p.metrics), source: 'server' } });
      }
      newCount++;
    }
    posts++;
  }
  await prisma.competitorAccount.update({ where: { id: competitorId }, data: { lastCrawledAt: new Date() } });
  // 账号级当日快照（与插件通道 lib/ingest/competitor.ts 同一处调用点，两条通道口径一致）
  await recordCompetitorDaily(competitorId);
  if (ledger) {
    await recordCollectionRun({
      ...ledger,
      scope: 'rival',
      platform: competitor.platform,
      targetId: competitor.id,
      targetName: competitor.name,
      dates: res.posts.map((p) => p.publishedAt ?? null),
      items: posts,
      created: newCount,
      updated: updCount,
      note: res.degraded ? '通道降级：本次结果可能不完整' : null,
    });
  }
  return { posts, degraded: res.degraded };
}

// 2) 竞对采集（按工作区订阅的竞对拉取新作品）
//
// channel 决定台账里记成"谁触发的"：cron 是 server，页面上点「采集竞对」是 manual。
// 空转的 server 轮次不进台账（多数平台没有服务端通道，每 2 小时一轮全是 0 条），
// 详见 recordCollectionRun 的取舍说明。
export async function crawlCompetitors(
  workspaceId: string,
  channel: CollectionChannel = 'server',
): Promise<{ posts: number; accounts: number; degraded: boolean }> {
  const items = await prisma.watchlistItem.findMany({ where: { workspaceId } });
  let posts = 0;
  let degraded = false;
  for (const it of items) {
    const r = await crawlOneCompetitor(it.competitorId, { workspaceId, channel });
    posts += r.posts;
    if (r.degraded) degraded = true;
  }
  return { posts, accounts: items.length, degraded };
}

// 账号红线命中判定：候选标题与某条 cantDo 红线的相关度。
// 复用全站「相关」口径——与饱和度(saturation.ts)、粗排指纹同一把尺子：共享 ≥2 个中文 2-gram 即判相关；
// 极短红线（≤3 字，切不出 2 个 gram）退化为整词包含。宁精不滥：红线是硬剔除，不能靠单个 gram 误伤。
function hitsCantDo(title: string, cantDo: string[]): boolean {
  const titleSh = textShingles(title);
  const t = title.replace(/[\s、,，。/·|]+/g, '').toLowerCase();
  for (const raw of cantDo) {
    const p = (raw ?? '').trim();
    if (!p) continue;
    const pNorm = p.replace(/[\s、,，。/·|]+/g, '').toLowerCase();
    if (pNorm.length <= 3) {
      if (pNorm.length >= 2 && t.includes(pNorm)) return true;
      continue;
    }
    let shared = 0;
    for (const sh of textShingles(p)) if (titleSh.has(sh)) shared++;
    if (shared >= 2) return true;
  }
  return false;
}

// P0-2 红线硬过滤 + 空池兜底：命中 cantDo 的候选剔除；若过滤后为空则整体放弃过滤（绝不清成空窗）。
export function filterByCantDo(candidates: Candidate[], persona: PersonaCard): Candidate[] {
  const cantDo = (persona.cantDo ?? []).filter((x) => x && x.trim());
  if (cantDo.length === 0) return candidates;
  const kept = candidates.filter((c) => !hitsCantDo(c.title, cantDo));
  return kept.length > 0 ? kept : candidates;
}

// 3) 生成今日推荐（批租户型：候选池 → 粗排 → LLM 精排 → 写入选题）
export async function generateRecommendations(accountId: string, workspaceId: string, topN = 6): Promise<{ created: number }> {
  const account = await prisma.creatorAccount.findUnique({ where: { id: accountId } });
  if (!account) return { created: 0 };
  // 精排烧的是这个租户的钱：tenantId 必须一路传到 llmComplete，走配额与成本归属。
  // 传 null 会以「平台自用」身份落账——那是给热榜这类全局广播任务留的口子，不是给租户任务用的。
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { tenantId: true } });
  const tenantId = ws?.tenantId ?? null;
  const persona = readPersona(account.personaCard);
  // 用人设关键词做语义召回，注入最相关的记忆
  const memoryQuery = [persona.niche, persona.identity, ...(persona.canDo ?? [])].filter(Boolean).join(' ');
  // 统一账号上下文：记忆 + 风格指纹 + 真实数据基线。指纹（含被数据验证的擅长切入角）与跨平台基线
  // 一并注入精排，让 learn.ts 沉淀的经验进入每日推荐主链路（P0-1）。account 已在手，避免重复查库。
  const ctx = await buildAccountContext({
    workspaceId,
    accountId,
    account,
    // audience：受众画像进精排——「这个选题跟你的读者对不对得上」此前只能靠人设卡里
    // 手写的一句话推测，现在有后台回来的真实分布可依（无数据时整块缺席，不影响原有行为）
    blocks: ['fingerprint', 'baseline', 'audience', 'memory'],
    memoryQuery,
  });
  const memory = ctx.parts.memory ?? '';
  // P1-3 消费端：切入角历史战绩（发布回流实测的定量结论）也进精排——「推荐→发布→数据→下轮推荐」
  // 的显式闭环，不再只靠记忆那条「措辞全等去重」的脆弱链路传话。无回流数据时返回空串。
  const angleTrack = await angleTrackRecordBlock(accountId).catch(() => '');
  const scoringContext = [ctx.parts.fingerprint, ctx.parts.baseline, angleTrack].filter(Boolean).join('\n\n');

  // 候选池：热榜项（跳过敏感话题簇）+ 本工作区订阅竞对的高热作品（不吃其他租户的订阅数据）
  // isMock:false 是硬闸：示例词条（某源没有真实通道时由 MockHotAdapter 兜底产出）绝不进候选池。
  // 它们一旦进来，就会被 LLM 精排成一条**带六维分和差异化切入角的正经推荐**——落到用户眼里
  // 和真热点毫无区别（真机 2026-07-30：新账号收到「自媒体新手避坑指南 · bilibili · 81 分」，
  // 词条本身是 Mock 造的）。选题卡上的「示例数据」标记的是**精排是否 Mock**，管不到来源是否 Mock，
  // 所以这道闸只能设在这里。宁可这一轮少几条候选，也不能把编的东西当情报卖。
  const hotItems = await prisma.hotItem.findMany({
    where: { isMock: false },
    orderBy: { heat: 'desc' },
    take: 40,
    include: { cluster: { include: { _count: { select: { hotItems: true } } } } },
  });
  const watch = await prisma.watchlistItem.findMany({ where: { workspaceId }, select: { competitorId: true } });
  // 竞对作品候选。**不按 hotScore 取**——那是 `views / 20000` 算的，没有播放量的平台恒为 0，
  // 于是抖音/小红书/X 的竞对作品几乎永远进不了选题候选池（见 lib/insight/heat.ts）。
  // 改成多取一些、按互动量在内存里排：互动量每个平台都拿得到。
  const topPostPool = watch.length
    ? await prisma.crawledPost.findMany({
        where: { competitorId: { in: watch.map((w) => w.competitorId) } },
        orderBy: { publishedAt: 'desc' },
        take: 200,
      })
    : [];
  const topPosts = [...topPostPool]
    .sort((a, b) => heatForSort(parseJson<Metrics>(b.metrics, {})) - heatForSort(parseJson<Metrics>(a.metrics, {})))
    .slice(0, 15);
  // heat 按**批内最大值**归一，不用固定除数：原来是 `hotScore / 100`，
  // 小号的作品永远接近 0、大号永远顶格 1，两者都不是「相对权重」。
  const postHeat = normalizedHeat(topPosts.map((p) => parseJson<Metrics>(p.metrics, {})));
  const maxHeat = Math.max(1, ...hotItems.map((h) => h.heat));
  const externalCandidates: Candidate[] = [
    // F1-4 双闸：簇级打标（clusterHotTopics 写入，含 LLM 复核结论）+ 条目级词库兜底。
    // 少了第二道就有个零成本绕过：只在 1 个源上榜的敏感词条**根本进不了跨平台簇**，
    // cluster 为 null → `!h.cluster?.isSensitive` 恒为 true → 直接进候选池。
    ...hotItems
      .filter((h) => !h.cluster?.isSensitive && !isSensitiveTitle(h.title))
      .map((h) => ({ title: h.title, heat: h.heat / maxHeat, sourceType: h.source, sourceRef: h.id, lifecycle: h.lifecycle, firstSeenAt: h.firstSeenAt, platform: h.source })),
    ...topPosts.map((p, i) => ({ title: p.title, heat: postHeat[i], sourceType: 'competitor', sourceRef: p.id, platform: p.platform })),
  ];

  // P2 需求代理（bluesea.ts）：在榜时长 × 跨平台扩散广度。**只有热榜项算得出**——
  // 竞对作品、自搬运、常青、日历都没有热榜时间线，它们在这张表里缺席，蓝海度即 0，行为退回原样。
  // 跨源簇的成员数就是「几个平台在同时聊这件事」：簇是按事件聚的，一个成员 = 一个源上的一条词条。
  const demandByTitle: Record<string, number> = {};
  for (const h of hotItems) {
    demandByTitle[h.title] = demandProxy({
      hoursOnList: (h.lastSeenAt.getTime() - h.firstSeenAt.getTime()) / 3_600_000,
      sourceCount: h.cluster?._count.hotItems ?? 1,
    });
  }

  // ── 延伸候选源（lib/topic/sources/）：把「别人做爆了什么」扩成「什么在发生 × 你有什么 × 为什么是现在」──
  //
  // 三个源全部并行取数，且全部 best-effort：它们是对原候选池的**增量**，任何一个挂了都只是少一类候选，
  // 绝不能让「热榜+竞对」这条已经跑了很久的主路径跟着崩。取数失败即当作该源今天没有货。
  //
  // 成本护栏不变：这些源产出的是**候选**，不是推荐。最终仍是粗排截断到 topN 才进精排，
  // LLM 调用次数与扩展前完全相同（topN + 至多 1 个探索位）。
  const [gapList, ownWorks] = await Promise.all([
    gapCandidates({ workspaceId, persona, maxHeat }).catch((e) => {
      console.warn('[pipeline] 时间差雷达取数失败，本轮跳过:', (e as Error).message);
      return [] as Candidate[];
    }),
    loadOwnWorks(accountId).catch((e) => {
      console.warn('[pipeline] 自有作品取数失败，翻新/自搬运本轮跳过:', (e as Error).message);
      return [] as OwnWork[];
    }),
  ]);
  const crossPlat = await crossPlatformCandidates({ accountId, persona, works: ownWorks }).catch(() => [] as Candidate[]);
  // 日历节点：纯日期计算，无 IO 无网络，不需要 try/catch 也不会失败。
  // 它是唯一对「零数据新账号」立刻生效的源——不依赖热榜、竞对或历史作品。
  const calendar = calendarCandidates({ persona });

  // 抢跑候选与热榜候选可能指向同一个话题（簇首本来就是某条在榜词条）。
  // 同题只保留抢跑那条：它携带的「你的平台还没有 + 还剩几小时」是严格更多的信息。
  const gapTitles = new Set(gapList.map((c) => c.title));
  const external = [...gapList, ...externalCandidates.filter((c) => !gapTitles.has(c.title))];
  // 自搬运只在池子里还没有同题候选时才单独占位（见 dropDuplicateCrossPlat）
  const merged = [...external, ...dropDuplicateCrossPlat(crossPlat, external), ...calendar];

  // 话题回温：不新增候选，只给已在池中的热点挂上「你做过这个题、当时跑了多少」的事实证据
  // （详见 sources/recycle.ts 里为什么它是 enricher 而不是 source）。
  const recycled = enrichWithRecycle(merged, ownWorks, platformBaselines(ownWorks));
  // 素材唤醒：对**任何来源**的候选都成立——它回答的是「你能怎么做得不一样」，不是「为什么推它」，
  // 所以只往 evidence 追加、不改来源不改队列（详见 sources/material.ts）。放在回温之后，两句证据可叠加。
  const withMaterial = await enrichCandidatesWithMaterial(accountId, recycled).catch((e) => {
    console.warn('[pipeline] 素材库取数失败，本轮不做素材唤醒:', (e as Error).message);
    return recycled;
  });
  // 灵感收集箱：同题的唤醒已有候选（「你 3 周前收藏过这个」），没同题的自己成候选。
  // 同一条灵感只走其中一条路，不会既唤醒又占位（详见 sources/inspiration.ts）。
  const enriched = await applyInspirationForAccount(workspaceId, accountId, withMaterial)
    .then((r) => r.candidates)
    .catch((e) => {
      console.warn('[pipeline] 灵感收集箱取数失败，本轮跳过:', (e as Error).message);
      return withMaterial;
    });

  // P0-2 账号红线硬过滤：命中人设 cantDo 的候选直接剔除（个人红线不再只靠 LLM 自觉）。
  // 兜底：若过滤后候选被清空（红线过宽或热榜恰好全撞线），放弃过滤照常出推荐——绝不让红线把推荐清成空窗。
  const candidates = filterByCantDo(enriched, persona);

  // 竞争饱和度：近 72h 竞对作品的同话题计数（竞对库为空 → 全 0，新账号不受影响）。
  // P2-4：传人设按赛道过滤——同赛道样本不足 8 条时函数内部自动退回全局口径，不拿小样本装赛道结论。
  const saturation = await computeSaturation(candidates.map((c) => c.title), persona);
  // P2-5 语义匹配：仅在配了真 embedding key 时有值（Mock/哈希嵌入返回空表），与词形分取 max
  const semantic = await semanticPersonaFit(candidates.map((c) => c.title), persona);

  // P2 蓝海度：需求代理已验证 × 供给还空着。它不新增权重项，只把倒U最优点往低供给方向推
  // （详见 bluesea.ts——叠加会和倒U打架，一个奖励低供给一个惩罚低供给）。
  const blueSea = blueSeaByTitle(candidates, demandByTitle, saturation);
  const withBlueSea = candidates.map((c) =>
    blueSea[c.title] === undefined ? c : { ...c, blueSea: blueSea[c.title] },
  );

  // 队列配额：先粗排全池，再按「今日突击 / 本周窗口」分名额取满 topN（queue.ts）。
  // 放在精排之前是硬要求——配额要影响的是「谁值得花那笔精排的钱」，
  // 放在精排之后就变成了「钱花完了再挑」，成本翻倍且毫无意义。
  const selected = allocateByQueue(
    coarseRank(withBlueSea, persona, saturation, semantic, demandByTitle),
    topN,
  );
  const scored = await runScoring(
    tenantId, selected, persona, memory, topN, saturation, scoringContext, semantic, demandByTitle,
  );

  // 清掉旧的 candidate/recommended，保留用户已操作(accepted/rejected/...)的。
  // 常青储备（queue=evergreen）豁免：它是按水位线独立维护的储备池（sources/evergreen.ts），
  // 不随每日热点重来一遍——每天清空重建等于每天为同一批常青题重复付精排的钱。
  await prisma.topicIdea.deleteMany({
    where: { accountId, state: { in: ['candidate', 'recommended'] }, queue: { not: 'evergreen' } },
  });

  // Top N 一次性批量写入（原来是 N 次串行 create，N 个来回）。落库顺序不影响正确性——
  // 下游按 state/totalScore 查询排序，不依赖插入次序。
  let created = (await prisma.topicIdea.createMany({
    data: scored.map((s) => ({
      accountId,
      title: s.title,
      angle: s.angle,
      // 缺席即 null（Prisma 对 undefined 走列默认值）：没判定就是没判定，不补默认形状
      angleShape: s.angleShape,
      rationale: s.rationale,
      scores: toJson(s.scores),
      totalScore: s.totalScore,
      sourceType: s.sourceType,
      sourceRef: s.sourceRef,
      queue: s.queue,
      evidence: s.evidence,
      windowHint: s.windowHint,
      blueSea: s.blueSea,
      // 模型判定「只能硬凑」的条目退到候选区，不进今日推荐（scoring.ts 里那段真机案例）。
      // 退到 candidate 而不是直接丢：精排的钱已经花了，留痕让用户能看见系统**考虑过并否掉了**
      // 什么——这比凭空少几条更可信，也让「今天为什么只有 3 条」有处可查。
      // 这批和 recommended 一样每轮重建（上面的 deleteMany 两个状态都清），不会累积。
      state: s.relevant ? 'recommended' : 'candidate',
      mocked: s.mocked,
      degraded: s.llmDegraded,
    })),
  })).count;
  const rejected = scored.filter((s) => !s.relevant).length;
  if (rejected > 0) {
    console.info(`[pipeline] 本轮 ${scored.length} 条精排里 ${rejected} 条被判定与账号硬凑，已退到候选区不进推荐`);
  }

  // 探索位（research-5 §6.3）：从没进 Top N 的候选里挑「热度前 25% 且人设匹配低于中位数」的
  // 一条追加，防止推荐越收越窄。找不到就不追加——探索位不许拿末位凑数。
  //
  // best-effort：探索位是锦上添花，Top N 才是产品主体且已落库提交。这里追加的 finePrompt 是
  // 本次生成里最后、也是可有可无的一次 LLM 调用——它触配额上限（QuotaExceededError）或任何异常，
  // 都绝不能把「Top N 已成功产出」的整次生成对用户报成失败。出错就静默跳过探索位，照常 return。
  try {
    const exploration = pickExploration(withBlueSea, new Set(scored.map((s) => s.title)), persona);
    // 探索位刻意挑「人设匹配低于中位数」的候选，最容易撞上硬凑——这里同样尊重模型的 relevant 判定。
    // 探索位的意义是「帮你开新赛道」，不是「给你一条离谱的题」；硬凑的探索位一条都不如没有。
    if (exploration) {
      const ex = await finePrompt(tenantId, exploration, persona, memory, scoringContext);
      if (!ex.relevant) {
        console.info('[pipeline] 探索位候选被判定与账号硬凑，本轮不追加探索位');
        return { created };
      }
      await prisma.topicIdea.create({
        data: {
          accountId,
          title: ex.title,
          angle: ex.angle,
          angleShape: ex.angleShape,
          rationale: `${EXPLORATION_NOTE}${ex.rationale}`,
          scores: toJson(ex.scores),
          totalScore: ex.totalScore,
          sourceType: ex.sourceType,
          sourceRef: ex.sourceRef,
          queue: ex.queue,
          evidence: ex.evidence,
          windowHint: ex.windowHint,
          blueSea: ex.blueSea,
          state: 'recommended',
          isExploration: true,
          mocked: ex.mocked,
          degraded: ex.llmDegraded,
        },
      });
      created++;
    }
  } catch (err) {
    console.warn('[pipeline] 探索位生成失败（配额/异常），已跳过，不影响本次已产出的推荐:', (err as Error).message);
  }
  return { created };
}

// LLM 复核：**只加不减**。
// 词库已命中的簇不送审、也不给 LLM 翻案权——原因有二：
//   1) 代价不对称（见上）：漏标是事故，误标有申诉出口。
//   2) llmComplete 在真实 provider 失败时会静默降级到 Mock。若允许 LLM 下调，
//      Mock 的固定文案就能把词库命中的簇「洗白」成不敏感——「Mock 把没判断伪装成判断了不敏感」
//      正是本项目栽过的坑。只加不减在结构上堵死这条路径。
// 返回被 LLM 追加判定为敏感的下标集合；任何异常/解析失败都返回空集（= 保留词库结论，绝不放宽）。
async function llmReviewSensitive(titles: string[]): Promise<Set<number>> {
  const empty = new Set<number>();
  if (titles.length === 0) return empty;
  const listed = titles.map((t, i) => `${i}. ${t}`).join('\n');
  try {
    const res = await llmComplete(
      null, // 热榜是广播型数据，全租户共享，不挂租户
      'compliance',
      [
        {
          role: 'system',
          content:
            '你是中文热榜内容风控助手。判断每条热搜词条是否属于「敏感社会/政治类」：涉政治体制/涉外政治、' +
            '军事冲突、反腐与刑事司法、重大灾难伤亡、恶性刑事案件、群体性事件、民族宗教、公共卫生突发。' +
            '注意：明星八卦、影视综艺、体育赛事、天气、美食、财经行情、科技产品、职场生活**都不算敏感**，不要误判。' +
            '只输出 JSON：{"sensitive":[下标数组]}，没有敏感条目就输出 {"sensitive":[]}。',
        },
        { role: 'user', content: listed },
      ],
      { temperature: 0, json: true },
    );
    // 降级到 Mock 的结果一律不采信：Mock 不做判断，它的输出没有信息量。
    if (res.mocked) return empty;
    const parsed = parseJson<{ sensitive?: number[] }>(res.text, {});
    const out = new Set<number>();
    for (const i of parsed.sensitive ?? []) if (Number.isInteger(i) && i >= 0 && i < titles.length) out.add(i);
    return out;
  } catch (err) {
    console.warn('[pipeline] 敏感复核 LLM 不可用，本轮仅词库结论:', (err as Error).message);
    return empty;
  }
}

// ─────────────────────────── F1-2 跨平台话题簇 ───────────────────────────
//
// PRD §6 F1-2：对词条做 embedding 阈值聚类，同一事件在 ≥2 平台上榜时合并。
//
// 【两种模式，绝不互相冒充】
//  - semantic（生产）：配了 BEACON_EMBED_* → 真语义向量（BGE-M3 等），原文入模型。
//  - lexical（dev 兜底）：无 key 时 embed.ts 给的是 HashingEmbedder（字符 2-gram 特征哈希）。
//    实测结论（120 条真实热榜两两比对）：它**不具备语义能力**，只有词形重合度。
//    原文直喂时噪声压过信号——「黄金跌破4000美元」vs「世界杯冠军奖金5000万美元」仅靠共享
//    「美元」「000」就拿到 0.505，比真同事件的「A股今天暴跌原因」vs「A股跌至3790点」(0.105) 还高，
//    **两类之间不存在可分的阈值**。故 lexical 模式先做归一化（剥数字/标点/功能字）把噪声打下去
//    （那两对分别降到 0.251 / 升到 0.165），再用实测阈值 0.42。
//    代价诚实说明：lexical 是**高精度低召回**的降级实现——同事件但换词描述的（A股暴跌 vs A股跌至3790点、
//    詹姆斯去向）聚不到一起。这是词形匹配的能力上限，不是参数没调好；要召回就得配真 embedder。
//    另一条硬缺口见 isLexicalClusterable：lexical 模式对拉丁文标题**直接不聚类**。
const CLUSTER_SIM_LEXICAL = 0.42; // dev 词形模式：实测校准，见上
const CLUSTER_SIM_SEMANTIC = 0.82; // 真 embedder 语义模式：行业常用同事件阈值，**未经本地实测**
                                   // （无 key 无法验证），接入真 embedder 后必须按 F1-2 AC① 抽检重标定，
                                   // 可用 BEACON_CLUSTER_SIM 覆盖而不改码。

// dev 词形模式专用归一化：数字/标点/高频功能字对「是不是同一事件」零信息量，却在短标题里
// 占满 gram 预算制造假相似。真 embedder 不走这里——语义模型要的是自然原文，剥了反而变差。
const LEXICAL_STOP = /[的了是在和与及对为把被就都还也很更最个我你他她们这那有没会要能不之而于以其所吗呢啊吧哦嘛]/g;
// 平台标题模板：知乎几乎每条都是「如何看待 XXX？」、头条爱用「直击 XXX」。
// 这些短语是**栏目格式**，对「是哪个事件」零信息量，却是多字词、比单字停用词更能拉高假相似度——
// 不剥的话「如何看待某明星塌房」和「如何看待房价走势」会因为共享「如何看待」被判成同一事件。
// 长模板必须排在短模板前面（正则交替取最左最先匹配，「如何看待」要抢在「如何」之前）。
const LEXICAL_TEMPLATE =
  /如何看待|如何评价|怎么看待|你怎么看|具体情况如何|是什么体验|一文看懂|深度拆解|为什么说|怎么回事|有哪些|如何|为什么|直击/g;
function normalizeForLexical(title: string): string {
  return title
    .toLowerCase()
    .replace(/[0-9０-９]+/g, '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .replace(LEXICAL_TEMPLATE, '')
    .replace(LEXICAL_STOP, '');
}

// lexical 模式的硬缺口：拉丁文标题不聚类。
// 实测（10 条英文 mock 榜单标题两两比对）：**互不相关**的英文标题相似度中位 0.478、最高 0.714
// （"How creators plan content" vs "The creator economy in 2026"），而中文**真同事件**才 0.46–0.55。
// 26 个字母的 2-gram 天然高度重合，噪声底比信号还高——不存在能同时服务中英文的阈值。
// 与其用一个必然硬凑的阈值把 x/youtube 榜单搅成一坨，不如在 dev 明确不聚它们。
// 配了真 embedder（semantic 模式）就没这条限制，语义向量本来就是跨语种的。
function isLexicalClusterable(title: string): boolean {
  const chars = [...title.replace(/\s/g, '')];
  if (chars.length === 0) return false;
  const cjk = chars.filter((c) => /\p{Script=Han}/u.test(c)).length;
  return cjk / chars.length >= 0.3;
}

function clusterThreshold(lexical: boolean): number {
  const env = Number(process.env.BEACON_CLUSTER_SIM);
  if (Number.isFinite(env) && env > 0 && env <= 1) return env;
  return lexical ? CLUSTER_SIM_LEXICAL : CLUSTER_SIM_SEMANTIC;
}

export type ClusterReport = {
  clusters: number;
  sensitive: number;
  skippedLatin: number; // lexical 模式下因拉丁文而未参与聚类的词条数，别让这条缺口无声无息
  mode: 'semantic' | 'lexical-degraded';
  reviewed: 'lexicon' | 'lexicon+llm'; // 本轮敏感判定实际跑到哪一层，别让调用方猜
};

// 话题跨源聚类（F1-2）+ 敏感打标（F1-4）
export async function clusterHotTopics(): Promise<ClusterReport> {
  // 旧簇全量清理：簇是当轮榜单的**派生物**（ingestHot 每轮清空重建 HotItem），不是累积资产。
  // 原实现只 create 从不 delete，跑一次攒一批——线上那 82 个簇里 73 个是没有成员的孤儿。
  // 只收孤儿不够：上一轮的簇此刻还挂着成员，等本轮重新分配 clusterId 后才变孤儿，会整轮残留。
  // HotItem.clusterId 是 onDelete: SetNull，全删安全。
  await prisma.topicCluster.deleteMany({});

  // 同候选池口径排除示例词条：「跨源热点聚类 = 多平台同时升温 = 更强的选题信号」这句话，
  // 一旦簇里混进 Mock 造的同名词条就是假信号——而簇又直接喂给 gap.ts 的抢跑窗口判断。
  const items = await prisma.hotItem.findMany({ where: { isMock: false }, orderBy: { heat: 'desc' } });
  if (items.length === 0) return { clusters: 0, sensitive: 0, skippedLatin: 0, mode: 'lexical-degraded', reviewed: 'lexicon' };

  const embedder = getEmbedder();
  const lexical = embedder.mocked;
  const threshold = clusterThreshold(lexical);
  // lexical 模式剔掉拉丁文标题（见 isLexicalClusterable）
  const pool = items.filter((it) => !lexical || isLexicalClusterable(it.title));
  const skippedLatin = items.length - pool.length;
  // 批量嵌入：远端 embedder 按次计费，一条一次调用等于把成本乘以榜单条数。
  const texts = pool.map((it) => (lexical ? normalizeForLexical(it.title) : it.title));
  const vecs: number[][] = [];
  for (let i = 0; i < texts.length; i += 64) vecs.push(...(await embedder.embed(texts.slice(i, i + 64))));

  // Leader 聚类：按热度降序，每条找相似度最高的既有簇首，够阈值就并入，否则自己开簇。
  // 不用单链层次聚类——单链会顺着「A≈B、B≈C」把不相关的 A、C 串成一坨，正是要避免的硬凑。
  // 复杂度 O(N×K)（K=簇数），N≈200 时是毫秒级；即便退化成 O(N²)，200 条也只有 2 万次点积。
  const groups: { leader: number; members: number[] }[] = [];
  for (let i = 0; i < pool.length; i++) {
    let best = -1;
    let bestSim = threshold;
    for (let g = 0; g < groups.length; g++) {
      const sim = cosine(vecs[i], vecs[groups[g].leader]);
      if (sim >= bestSim) { bestSim = sim; best = g; }
    }
    if (best >= 0) groups[best].members.push(i);
    else groups.push({ leader: i, members: [i] });
  }

  // F1-2 只产出**跨平台**簇：同一事件至少在 2 个源上榜
  const cross = groups.filter((g) => new Set(g.members.map((m) => pool[m].source)).size >= 2);

  // 敏感打标：词库粗筛（簇内任一成员命中即整簇敏感——同簇本就是同一事件，且方向偏保守）
  const lexHit = cross.map((g) => g.members.some((m) => isSensitiveTitle(pool[m].title)));
  // LLM 复核只补漏：只送词库没命中的簇，且只允许把 false 抬成 true
  let reviewed: ClusterReport['reviewed'] = 'lexicon';
  const provider = await resolveProvider(null, 'compliance');
  if (!provider.mocked) {
    const idx = cross.map((_, i) => i).filter((i) => !lexHit[i]);
    if (idx.length > 0) {
      // 送审整簇标题（不只簇首）：簇首是热度最高那条，未必是最能暴露敏感性的那条
      const flagged = await llmReviewSensitive(idx.map((i) => cross[i].members.map((m) => pool[m].title).join(' / ')));
      for (const k of flagged) lexHit[idx[k]] = true;
      reviewed = 'lexicon+llm';
    }
  }

  let clusters = 0;
  let sensitive = 0;
  for (let i = 0; i < cross.length; i++) {
    const g = cross[i];
    const members = g.members.map((m) => pool[m]);
    const sources = [...new Set(members.map((m) => m.source))];
    const isSensitive = lexHit[i];
    const cluster = await prisma.topicCluster.create({
      data: {
        title: pool[g.leader].title, // 簇首 = 热度最高的那条
        // F1-4 AC④：敏感簇不出 LLM 摘要，summary 留空（堵住「全租户共享分发涉政热点 AI 摘要」的事故面）
        summary: isSensitive ? null : `${sources.length} 个平台同时升温的跨源话题。`,
        sources: toJson(sources),
        heat: Math.max(...members.map((m) => m.heat)),
        isSensitive,
      },
    });
    await prisma.hotItem.updateMany({ where: { id: { in: members.map((m) => m.id) } }, data: { clusterId: cluster.id } });
    clusters++;
    if (isSensitive) sensitive++;
  }
  return { clusters, sensitive, skippedLatin, mode: lexical ? 'lexical-degraded' : 'semantic', reviewed };
}
