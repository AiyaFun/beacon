import { prisma } from '../db';
import { tickScheduledAgents } from '../workflow/schedule';
import { AGENT_TICK_MINUTES } from './schedule-config';
import { ingestHot, clusterHotTopics, crawlCompetitors, generateRecommendations } from '../pipeline';
import { toJson, parseJson, type Metrics } from '../json';
import { realCompetitorAdapter } from '../adapters/competitor-real';
import { learnFromPerformance, learnFromAbandonedDrafts } from '../insight/learn';
import { buildDailyBrief } from '../topic/brief';
import { replenishEvergreen } from '../topic/sources/evergreen';
import { notify } from '../notify';
import { pushEvent, beaconUrl } from '../bot';
import { isPushDue } from '../bot/push-window';
import { optimizeWorkspaceMemory } from '../memory/optimize';
import { scanAndGenerateReviews, scanWeeklyReviews } from '../insight/review';
import { evaluateAndAlert } from '../insight/alert';
import { DEMO_TENANT_ID, DEMO_WORKSPACE_ID } from '../demo/guard';
import { DAY_MS } from '../pay/plan';
import { expiryNoticeFor, sentStagesFrom, EXPIRED_GRACE_DAYS } from '../pay/expiry';
import { sweepRetention } from '../legal/retention';
import { automationAllows } from './automation';
import { JOB_TRACK, type JobHandler, type JobName } from './types';

// 各任务的实际处理逻辑，包一层 JobRun 记账（可观测性）。

// 回流里程碑：发布后前 7 天逐日各抓一次（D+1..D+7）+ D+14/D+30 两个长尾点，
// 支撑「每篇前 7 天逐日增长」的可复盘数据模式（差分层据逻辑日折算，见 lib/insight/timeseries.ts）。
// 兜底 cron 每 6h 扫一次，只处理刚跨过某里程碑窗口的记录；grace 12h > cron 间隔，保证每个窗口至少命中一次。
// 过窗不补——把晚抓的数值贴到早里程碑上，比缺一个点更糟（缺日在差分层显式标注跨日）。
const MILESTONES: { label: string; ms: number }[] = [
  { label: 'D+1', ms: 1 * 24 * 3600_000 },
  { label: 'D+2', ms: 2 * 24 * 3600_000 },
  { label: 'D+3', ms: 3 * 24 * 3600_000 },
  { label: 'D+4', ms: 4 * 24 * 3600_000 },
  { label: 'D+5', ms: 5 * 24 * 3600_000 },
  { label: 'D+6', ms: 6 * 24 * 3600_000 },
  { label: 'D+7', ms: 7 * 24 * 3600_000 },
  { label: 'D+14', ms: 14 * 24 * 3600_000 },
  { label: 'D+30', ms: 30 * 24 * 3600_000 },
];
const GRACE_MS = 12 * 3600_000;

// 该记录当前到期、且尚未抓过的里程碑（无则不处理）。
// 判「已抓」以快照的 milestone 标签为准，而非 takenAt 越点：插件/手动快照 milestone 恒 null、
// takenAt=写库时间，用 takenAt 越点判定会把它们误当成「官方里程碑已抓」，逐日制下会系统性吞掉官方点。
function dueMilestone(publishedAt: Date, snapshots: { milestone: string | null }[], now: number): string | null {
  const age = now - publishedAt.getTime();
  for (const m of MILESTONES) {
    if (age < m.ms || age >= m.ms + GRACE_MS) continue;
    if (snapshots.some((s) => s.milestone === m.label)) continue;
    return m.label;
  }
  return null;
}

// 晨报取数：不加 take——晨报要按队列分组，只取前 N 条会让「今日突击」这一队随机丢失，
// 恰恰是最有时间压力的那一队。条数上限由 brief.ts 按队列各自控制。
// 不按日期过滤是有意的：generateRecommendations 每轮会先清掉旧的 candidate/recommended 再写入，
// 库里 state='recommended' 的就是最新一轮的结果——而且容器跑在 UTC，
// 「北京 05:00 生成、09:00 推送」跨了 UTC 日界，按 UTC 自然日过滤反而会把当天的推荐全滤没。
function briefTopics(accountId: string) {
  return prisma.topicIdea.findMany({
    where: { accountId, state: 'recommended' },
    orderBy: { totalScore: 'desc' },
    select: {
      title: true, totalScore: true, queue: true, angle: true,
      windowHint: true, sourceType: true, isExploration: true, mocked: true,
    },
  });
}

async function withRun(name: JobName, tenantId: string | undefined, fn: () => Promise<{ detail?: string }>) {
  const startedAt = Date.now();
  const run = await prisma.jobRun.create({
    data: { name, track: JOB_TRACK[name], status: 'running', tenantId },
  });
  try {
    const r = await fn();
    await prisma.jobRun.update({
      where: { id: run.id },
      data: { status: 'ok', detail: r.detail, finishedAt: new Date(), durationMs: Date.now() - startedAt },
    });
    return r;
  } catch (e) {
    await prisma.jobRun.update({
      where: { id: run.id },
      data: { status: 'failed', detail: (e as Error).message.slice(0, 300), finishedAt: new Date(), durationMs: Date.now() - startedAt },
    });
    throw e;
  }
}

export const HANDLERS: Record<JobName, JobHandler> = {
  // 广播型：热榜采集（全租户共享，成本不随租户涨）
  ingest_hot: async () =>
    withRun('ingest_hot', undefined, async () => {
      const r = await ingestHot();
      return { detail: `插入 ${r.inserted} 条，降级源 ${r.degraded.length}` };
    }),

  cluster_topics: async () =>
    withRun('cluster_topics', undefined, async () => {
      const r = await clusterHotTopics();
      return { detail: `聚类 ${r.clusters} 个` };
    }),

  // 广播型：竞对采集（按全局订阅去重，此处遍历所有工作区订阅）
  crawl_competitors: async () =>
    withRun('crawl_competitors', undefined, async () => {
      // 演示工作区是只读展台，它的订阅是种子假数据，不该发起真实采集
      const workspaces = await prisma.workspace.findMany({
        where: { id: { not: DEMO_WORKSPACE_ID } },
        select: { id: true },
      });
      let posts = 0;
      let failed = 0;
      let handed = 0;
      for (const w of workspaces) {
        // 单个工作区的采集失败（数据源超时/限流）不该让其余工作区这一轮也没有数据
        try {
          const r = await crawlCompetitors(w.id);
          posts += r.posts;
        } catch (e) {
          console.warn(`[job:crawl_competitors] workspace ${w.id} failed:`, (e as Error).message);
          failed++;
        }
        // 服务端够不着的平台，转手派给插件
        handed += await handOffUncrawlable(w.id);
      }
      return {
        detail: `${workspaces.length} 工作区 / ${posts} 条作品`
          + `${handed ? ` / 转派插件 ${handed} 条` : ''}${failed ? ` / 失败 ${failed} 个` : ''}`,
      };
    }),

  // 批租户型：为每个活跃账号生成今日推荐（夜间批处理）
  daily_recommend: async (payload) =>
    withRun('daily_recommend', payload?.tenantId as string | undefined, async () => {
      const accounts = await prisma.creatorAccount.findMany({
        // 演示工作区必须排除：精排一路走到 llmComplete，在演示租户上被 assertNotDemo 抛错。
        // 不排除的话整个 job 崩在第一个演示账号上，**真实用户当天就没有推荐**（生产实际发生过）。
        where: { status: 'active', workspaceId: { not: DEMO_WORKSPACE_ID } },
        include: { workspace: true },
      });
      let created = 0;
      let skippedOff = 0;
      let failed = 0;
      for (const a of accounts) {
        // 按工作区自动化开关门控（缺省开，保持既有全自动行为）
        if (!automationAllows(a.workspace.automationConfig, 'dailyRecommend')) {
          skippedOff++;
          continue;
        }
        // 错误隔离（与 backfill_metrics 同款）：单账号失败（配额耗尽/模型超时/人设缺失）
        // 只影响该账号，不连坐其余租户
        try {
          const r = await generateRecommendations(a.id, a.workspaceId, 6);
          created += r.created;
          if (r.created > 0) {
            const brief = buildDailyBrief(a.name, await briefTopics(a.id));
            if (brief) {
              // 站内信在**生成时**就写，不等机器人那个时刻：它是静默的红点，用户 7 点打开网页
              // 就该看到；押到 9 点反而白白晚 4 小时。有声打扰的那一路（机器人）才按用户设定的时刻走。
              // 机器人出站已移到 push_daily_brief——用户在设置页配的「每日定时推送时间」以前根本没人读，
              // 推送时刻实际等于这个 job 的 cron（2026-07-28 用户反馈：设了 9 点，13 点才收到）。
              await notify({
                workspaceId: a.workspaceId,
                accountId: a.id,
                kind: 'daily_recommend',
                title: brief.title,
                body: brief.summary,
                link: '/topics',
              });
            }
          }
        } catch (e) {
          console.warn(`[job:daily_recommend] account ${a.id} failed:`, (e as Error).message);
          failed++;
        }
      }
      return {
        detail: `${accounts.length} 账号 / ${created} 条推荐${skippedOff ? ` / ${skippedOff} 个已关闭` : ''}${failed ? ` / 失败 ${failed} 个` : ''}`,
      };
    }),

  // 批租户型：把今日选题晨报推给**这一跳到点**的机器人。
  // 每 10 分钟跑一次，自己按各机器人的 pushSchedule 判到点（见 push-window.ts）——
  // 推送时刻是用户在设置页填的，一个工作区的两个机器人可以各配各的，写死在 cron 里做不到。
  // 只推不生成：推荐由 daily_recommend 在清晨产出，这里纯出站，没到点就是一次空扫（几乎零成本）。
  push_daily_brief: async (payload) =>
    withRun('push_daily_brief', payload?.tenantId as string | undefined, async () => {
      const now = payload?.now ? new Date(payload.now as string) : new Date();
      const integrations = await prisma.botIntegration.findMany({
        // 演示工作区不推（与 daily_recommend 同款排除）
        where: { enabled: true, workspaceId: { not: DEMO_WORKSPACE_ID } },
        select: { id: true, workspaceId: true, pushSchedule: true, pushEvents: true, webhookUrl: true, inboundKey: true },
      });
      // 到点 + 订阅了该事件 + 有可用出站通道。事件订阅 pushEvent 内部也会再判一次，
      // 这里先判是为了「一个都没到点」时直接空转返回，不去查账号和选题。
      const due = integrations.filter(
        (it) =>
          (it.webhookUrl || it.inboundKey) &&
          parseJson<string[]>(it.pushEvents, []).includes('daily_recommend') &&
          isPushDue(it.pushSchedule, now),
      );
      if (due.length === 0) return { detail: '本跳无到点的机器人' };

      // 按工作区归并：同工作区的多个机器人可能同时到点，一次取数推给这几个
      const byWorkspace = new Map<string, string[]>();
      for (const it of due) byWorkspace.set(it.workspaceId, [...(byWorkspace.get(it.workspaceId) ?? []), it.id]);

      let sent = 0;
      let failed = 0;
      for (const [workspaceId, integrationIds] of byWorkspace) {
        // 错误隔离（与 daily_recommend 同款）：一个工作区取数失败不连坐其余租户
        try {
          const accounts = await prisma.creatorAccount.findMany({
            where: { workspaceId, status: 'active' },
            include: { workspace: true },
          });
          for (const a of accounts) {
            if (!automationAllows(a.workspace.automationConfig, 'dailyRecommend')) continue;
            const brief = buildDailyBrief(a.name, await briefTopics(a.id));
            // 没推荐就不推：宁可这天没晨报，也不推一张空卡片
            if (!brief) continue;
            const r = await pushEvent(
              workspaceId,
              'daily_recommend',
              // 落地页指「本周作战」而不是「选题引擎」：晨报的意图是「今天动手做一条」，
              // 而 /battle 是那个能**就地起稿**的行动面（/topics 只能看不能就地起）。
              // 选题看全了要用完整队列分组时，/battle 里有「看全部选题」回到 /topics。
              { kind: 'card', title: brief.title, lines: brief.lines, link: { text: '打开本周作战 · 直接起稿', url: beaconUrl('/battle') } },
              { integrationIds },
            );
            sent += r.sent;
            failed += r.failed;
          }
        } catch (e) {
          console.warn(`[job:push_daily_brief] workspace ${workspaceId} failed:`, (e as Error).message);
          failed++;
        }
      }
      return { detail: `${due.length} 个机器人到点 / 推送 ${sent} 条${failed ? ` / 失败 ${failed} 条` : ''}` };
    }),

  // 批租户型：常青储备补货（sources/evergreen.ts）。
  // 与 daily_recommend 分开是刻意的：那个每天重来，这个按水位线触发——储备够的账号
  // 一次 LLM 都不调用（replenishEvergreen 先 count 后决定），成本只花在真的空了的账号上。
  replenish_evergreen: async () =>
    withRun('replenish_evergreen', undefined, async () => {
      const accounts = await prisma.creatorAccount.findMany({
        // 与 daily_recommend 同款排除：演示工作区走到 llmComplete 会被 assertNotDemo 抛错
        where: { status: 'active', workspaceId: { not: DEMO_WORKSPACE_ID } },
        include: { workspace: true },
      });
      let created = 0;
      let touched = 0;
      let skippedOff = 0;
      let failed = 0;
      for (const a of accounts) {
        // 复用「每日选题推荐」开关：用户关掉自动选题，就不该背着他继续烧钱补常青题。
        if (!automationAllows(a.workspace.automationConfig, 'dailyRecommend')) {
          skippedOff++;
          continue;
        }
        try {
          const r = await replenishEvergreen({ accountId: a.id, workspaceId: a.workspaceId });
          if (r.created > 0) {
            created += r.created;
            touched++;
          }
        } catch (e) {
          console.warn(`[job:replenish_evergreen] account ${a.id} failed:`, (e as Error).message);
          failed++;
        }
      }
      return {
        detail: `${accounts.length} 账号 / ${touched} 个补货 ${created} 条${skippedOff ? ` / ${skippedOff} 个已关闭` : ''}${failed ? ` / 失败 ${failed} 个` : ''}`,
      };
    }),

  // 事件驱动：发布回流（D+1..D+7/D+14/D+30 按平台适配器抓取已发布内容的真实表现快照）
  backfill_metrics: async () =>
    withRun('backfill_metrics', undefined, async () => {
      const now = Date.now();
      // 只取还可能落在里程碑窗口内的记录，过期太久的不再回流
      const oldest = new Date(now - (MILESTONES[MILESTONES.length - 1].ms + GRACE_MS));
      const records = await prisma.publishRecord.findMany({
        where: {
          platformItemId: { not: null },
          publishedAt: { gte: oldest },
          // 演示租户的种子记录带假 platformItemId、发布于近几天，逐日制下会天天进 due 列表
          // 触发真实适配器空拉——直接在取数层排除（isDemoTenant 的工作区维度）。
          account: { workspaceId: { not: DEMO_WORKSPACE_ID } },
        },
        include: {
          account: { select: { workspaceId: true, handle: true, workspace: { select: { automationConfig: true } } } },
          snapshots: { select: { milestone: true } },
        },
      });

      type Due = { rec: (typeof records)[number]; milestone: string };
      const due: Due[] = [];
      for (const rec of records) {
        // 工作区关闭了「数据自动同步」→ 跳过（缺省开）
        if (!automationAllows(rec.account.workspace.automationConfig, 'autoBackfill')) continue;
        const milestone = dueMilestone(rec.publishedAt, rec.snapshots, now);
        if (milestone) due.push({ rec, milestone });
      }

      // 适配器按账号拉最近作品列表，同账号多条记录合并成一次调用
      const groups = new Map<string, Due[]>();
      for (const d of due) {
        const key = `${d.rec.platform}::${d.rec.account.handle ?? ''}`;
        const g = groups.get(key);
        if (g) g.push(d);
        else groups.set(key, [d]);
      }

      const snappedBy: Record<string, number> = {};
      const noSource = new Set<string>();
      let snapped = 0;
      let noHandle = 0;
      let missed = 0;
      let failed = 0;

      for (const items of groups.values()) {
        const { platform, account } = items[0].rec;
        // 无 key → 无真实数据源：跳过并如实记账，绝不写自我复制的假快照
        const adapter = realCompetitorAdapter(platform);
        if (!adapter) {
          noSource.add(platform);
          continue;
        }
        if (!account.handle) {
          noHandle += items.length;
          continue;
        }
        // 错误隔离：单个平台/账号挂掉只影响本组，不让整个 job 崩
        let posts;
        try {
          posts = await adapter.fetchPosts(account.handle);
        } catch (e) {
          console.warn(`[job:backfill_metrics] fetch ${platform}/${account.handle} failed:`, (e as Error).message);
          failed += items.length;
          continue;
        }
        const byId = new Map(posts.map((p) => [p.platformItemId, p]));
        for (const d of items) {
          try {
            const post = byId.get(d.rec.platformItemId ?? '');
            // 作品不在最近列表里（发太久或已删）：没抓到就是没抓到
            if (!post?.metrics) {
              missed++;
              continue;
            }
            // 真实指标覆盖旧值；completion 等平台不返回的字段保留手动回填的结果
            const metrics: Metrics = { ...parseJson<Metrics>(d.rec.metrics, {}), ...post.metrics };
            await prisma.publishRecord.update({ where: { id: d.rec.id }, data: { metrics: toJson(metrics) } });
            await prisma.performanceSnapshot.create({
              data: { publishId: d.rec.id, metrics: toJson(metrics), source: adapter.name, milestone: d.milestone },
            });
            snapped++;
            snappedBy[d.milestone] = (snappedBy[d.milestone] ?? 0) + 1;
            // 与手动回填一致：真实数据回流后触发账号属性学习闭环
            await learnFromPerformance(d.rec.accountId, d.rec.account.workspaceId, d.rec.id).catch(() => {});
            // 爆款/异常预警（默认关，opt-in；自兜底不抛）
            await evaluateAndAlert(d.rec.accountId, d.rec.account.workspaceId, d.rec.id);
          } catch (e) {
            console.warn(`[job:backfill_metrics] snap ${d.rec.id} (${d.milestone}) failed:`, (e as Error).message);
            failed++;
          }
        }
      }

      const by = Object.entries(snappedBy).map(([k, v]) => `${k} ${v}`).join('，');
      const parts = [`到期 ${due.length} 条`, `回流 ${snapped} 条${by ? `（${by}）` : ''}`];
      if (missed) parts.push(`平台列表未命中 ${missed} 条`);
      if (noHandle) parts.push(`账号缺 handle ${noHandle} 条`);
      if (noSource.size) parts.push(`无数据源未回流：${[...noSource].join('/')}（缺商业 key，已跳过未写快照）`);
      if (failed) parts.push(`失败 ${failed} 条`);
      return { detail: parts.join('；') };
    }),

  // 批租户型：记忆持续学习优化。回流(backfill_metrics)之后跑 → 用最新绩效反哺，
  // 去重/生效/遗忘一遍，并把「本轮学到了什么」推到订阅了 learning_summary 的机器人。
  optimize_memory: async () =>
    withRun('optimize_memory', undefined, async () => {
      const workspaces = await prisma.workspace.findMany({ select: { id: true, automationConfig: true } });
      let touched = 0;
      let abandoned = 0;
      let embedded = 0;
      for (const w of workspaces) {
        if (!automationAllows(w.automationConfig, 'optimizeMemory')) continue;
        // W-4 创作过程信号：先把「起了初稿却长期没做完」的选题记成落地难，
        // 再跑记忆优化——这样本轮新写入的偏好也一并参与去重/生效/降权。
        // 演示工作区跳过：那是只读展台，不该被自动学习改写。
        if (w.id !== DEMO_WORKSPACE_ID) {
          abandoned += (await learnFromAbandonedDrafts(w.id).catch(() => ({ marked: 0 }))).marked;
        }
        const r = await optimizeWorkspaceMemory(w.id);
        embedded += r.embedded; // 换嵌入模型后的向量自愈，只进 detail 不打扰用户
        if (r.merged || r.promoted || r.retired) {
          touched++;
          await pushEvent(w.id, 'learning_summary', {
            kind: 'card',
            title: '🧠 记忆学习小结',
            lines: [r.summaryText],
            link: { text: '看人设与记忆', url: beaconUrl('/persona?tab=memory') },
          });
        }
      }
      return {
        detail: `${workspaces.length} 工作区 / ${touched} 个有更新${abandoned ? ` / 搁置草稿 ${abandoned} 篇计入落地难信号` : ''}${embedded ? ` / 补算向量 ${embedded} 条` : ''}`,
      };
    }),

  // 批租户型：为发布满 7 天、有选题归因、数据齐且尚无复盘的内容自动生成 AI 复盘（逻辑见 scanAndGenerateReviews）。
  generate_reviews: async () =>
    withRun('generate_reviews', undefined, async () => {
      const r = await scanAndGenerateReviews();
      return { detail: `扫描 ${r.scanned} 条 / 生成 ${r.generated} 篇复盘 / 跳过 ${r.skipped}` };
    }),

  // 批租户型：每周为有发布的活跃账号生成运营周报（逻辑见 scanWeeklyReviews）
  weekly_review: async () =>
    withRun('weekly_review', undefined, async () => {
      const r = await scanWeeklyReviews();
      return { detail: `${r.accounts} 账号 / 生成 ${r.generated} 份周报` };
    }),

  // 批租户型：到期/续费提醒。送达走**站内通知 + 顶部横幅 + 机器人推送**三条腿
  // （2026-07-30 起不再发邮件：邮件通道整个下线，改由产品内触达 + 用户已有的群机器人承担）。
  // 横幅那条腿由 components/ExpiryBanner.tsx 在每次打开页面时按到期日现算，
  // 不依赖本任务是否跑过——任务漏跑也不会出现「到期了却全无提示」。
  // 手动续费模式下到期是静默发生的（effectivePlan 懒判断），没有这条任务，
  // 用户只会在第二天发现「额度突然不够了」，而付费协议承诺过会提醒。
  plan_expiry_notice: async () =>
    withRun('plan_expiry_notice', undefined, async () => {
      const now = new Date();
      // 只捞窗口内的租户：将到期 8 天内（比最早的 d7 档多留 1 天余量）或刚过期不久。
      // 买断（99 年）、无到期日（运营手工开通）都天然落在窗口外。
      const upper = new Date(now.getTime() + 8 * DAY_MS);
      const lower = new Date(now.getTime() - (EXPIRED_GRACE_DAYS + 1) * DAY_MS);
      const tenants = await prisma.tenant.findMany({
        where: {
          plan: { not: 'free' },
          id: { not: DEMO_TENANT_ID }, // 演示租户是只读展台，别给它发续费提醒
          planExpiresAt: { gte: lower, lte: upper },
        },
        select: { id: true, plan: true, planExpiresAt: true, workspaces: { select: { id: true } } },
      });

      let notified = 0;
      let failed = 0;
      for (const t of tenants) {
        try {
          if (!t.planExpiresAt || t.workspaces.length === 0) continue;
          // 同一周期同一档只发一次：去重键带到期时刻 ⇒ 用户一续费就自动开启新一轮。
          const prior = await prisma.notification.findMany({
            where: {
              workspaceId: { in: t.workspaces.map((w) => w.id) },
              kind: 'plan_expiry',
              refId: { startsWith: `plan-expiry:${t.planExpiresAt.toISOString()}:` },
            },
            select: { refId: true },
          });
          const notice = expiryNoticeFor({
            plan: t.plan,
            planExpiresAt: t.planExpiresAt,
            now,
            sentStages: sentStagesFrom(prior.map((p) => p.refId), t.planExpiresAt),
          });
          if (!notice) continue;

          for (const w of t.workspaces) {
            await notify({
              workspaceId: w.id,
              kind: 'plan_expiry',
              refId: notice.refId,
              title: notice.title,
              body: notice.body,
              link: '/billing',
            });
            await pushEvent(w.id, 'plan_expiry', {
              kind: 'card',
              title: `⏳ ${notice.title}`,
              lines: [notice.body],
              link: { text: '去续费', url: beaconUrl('/billing') },
            });
          }
          notified++;
        } catch (e) {
          // per-tenant 隔离：一个租户炸掉不能让其余租户收不到提醒（daily_recommend 踩过这个坑）
          failed++;
          console.warn(`[job:plan_expiry_notice] tenant ${t.id} failed:`, (e as Error).message);
        }
      }
      return { detail: `扫描 ${tenants.length} 个到期窗口内租户 / 提醒 ${notified} 个${failed ? ` / 失败 ${failed}` : ''}` };
    }),

  // 广播型：保留期兑现闸。清单与理由都在 lib/legal/retention.ts，这里只负责把它跑起来。
  //
  // 【为什么不吞错误】sweepRetention 内部按步骤隔离（一张表失败不连坐其余），但会把失败原样带出来。
  // 这里必须把它抛成任务失败：一次静默失败的合规清理，和没有这个任务是一回事——而 JobRun 里
  // 一条绿色记录反而会让人以为「删过了」。宁可任务红着，也不要一份骗人的执行记录。
  purge_retention: async () =>
    withRun('purge_retention', undefined, async () => {
      const r = await sweepRetention();
      const detail =
        `评论正文 ${r.readerComments} 条 / 提问归档 ${r.commentQuestions.archived} 删除 ${r.commentQuestions.deleted}` +
        ` / 孤儿日志 ${r.orphanedLlmLogs}` +
        ` / 运行记录 AI ${r.runLogs.agentRuns} 工作流 ${r.runLogs.workflowRuns}` +
        ` / 浏览器任务 过期 ${r.browserTasks.expired} 清理 ${r.browserTasks.purged}` +
        ` / 移除申请重扫 ${r.removals.swept} 条`;
      if (r.errors.length > 0) {
        throw new Error(`${detail}；失败步骤：${r.errors.map((e) => `${e.step}(${e.message})`).join('，')}`);
      }
      return { detail };
    }),

  // 定时智能体：扫到点的用户自定义计划并跑。
  // 三道闸（每日上限 / 连续失败自动停 / 同日不重跑）都在 tickScheduledAgents 里，
  // 这里只负责把结果如实记进 JobRun——skipped 与 paused 不算失败，但必须出现在 detail 里，
  // 否则用户看到「跑了 0 条」却不知道是没到点还是被闸拦了。
  run_scheduled_agents: async () =>
    withRun('run_scheduled_agents', undefined, async () => {
      const r = await tickScheduledAgents(new Date(), AGENT_TICK_MINUTES);
      return {
        detail: `扫 ${r.scanned} 条 · 跑 ${r.ran} · 跳过 ${r.skipped}（到上限）· 失败 ${r.failed} · 自动停用 ${r.paused}`,
      };
    }),

  /**
   * 把一次 AI 执行往前推（用户开了一次执行 / 点了确认 / 等的事有结果了）。
   *
   * 【为什么刻意不 withRun】JobRun 是**系统体检**表：13 条定时任务各自的健康度。
   * AI 执行是用户级的跑动记录，它有自己的表（AgentRun/AgentStep）也有自己的页
   *（/runs 运行中心）。混进 JobRun 会让运维台被用户行为淹没，而 /ops/health
   * 上「今天跑了多少次」的判读从此失真。
   *
   * 失败也刻意不往外抛：runAgentLoop 自己会把失败写进 AgentRun.error，用户在
   * 运行中心看得到。抛出去只会让 BullMQ 记一条谁也不会看的红，还触发运维告警。
   */
  run_agent_loop: async (payload) => {
    const runId = typeof payload.runId === 'string' ? payload.runId : '';
    if (!runId) return { detail: '缺少 runId' };
    const { runAgentLoop } = await import('../agent/run');
    await runAgentLoop(runId);
    return { detail: `agent run ${runId}` };
  },

  /**
   * AI 执行的兜底巡检。与 run_agent_loop 同理**不记 JobRun**（那是用户级跑动，
   * 不是平台作业），但它是广播型的：扫的是全表里卡住的那几行。
   *
   * 【为什么要有它】此前两种自愈都挂在「用户打开页面看这次运行」上。执行改成
   * 可以挂起几小时之后这条就不够用了——等额度的运行是在半夜重置的，那时候
   * 没有任何人在看页面。
   */
  tick_agent_runs: async () => {
    const { tickAgentRuns } = await import('../agent/tick');
    const r = await tickAgentRuns();
    return { detail: `恢复 ${r.resumed} 接手 ${r.rekicked}` };
  },
};

/**
 * 服务端采不到的竞对，转手派给浏览器插件。
 *
 * 【为什么必须有这一步】生产实测：竞对作品按平台是
 * douyin 622 / xiaohongshu 194 / x 63 / bilibili 37 / youtube 24，而
 * **wechat 与 shipinhao 都是 0**——同时这两个平台上有 10 个竞对订阅。
 * 也就是说有人订阅了竞对、一条数据都没拿到过，而系统一声不吭。
 *
 * 根因不是 bug 而是**没有路**：公众号要 NewRank 之类的商业源（生产没配 key），
 * 视频号根本没有官方内容接口。这两条路服务端永远走不通，但**插件走得通**——
 * 它在用户自己已登录的浏览器里读公开页面，`collect_competitor` 早就实现好了，
 * 只是定时任务从来没把活交给它。
 *
 * 三道闸，少一道都会变成骚扰：
 *   ① 只派服务端确实够不着的（serverCanCrawl 说了算，补了 key 会自动停手）
 *   ② 这个工作区得真装了插件（没装的话任务只会堆到过期，白占队列还吓人）
 *   ③ 每个工作区每轮封顶——采集是用户浏览器在出力，一次塞十几个活等于占着他的机器
 */
const HANDOFF_PER_WORKSPACE = 3;

async function handOffUncrawlable(workspaceId: string): Promise<number> {
  const { serverCanCrawl } = await import('../adapters/registry');
  const { hasCollector, enqueueBrowserTask } = await import('../browser-task');

  const items = await prisma.watchlistItem.findMany({
    where: { workspaceId },
    select: { competitorId: true, competitor: { select: { platform: true } } },
  });
  const stuck = items.filter((i) => i.competitor && !serverCanCrawl(i.competitor.platform));
  if (stuck.length === 0) return 0;

  // 闸②放在这里而不是循环外：没有竞对卡住的工作区不必白查一次令牌表
  if (!(await hasCollector(workspaceId))) return 0;

  let n = 0;
  for (const it of stuck.slice(0, HANDOFF_PER_WORKSPACE)) {
    // enqueueBrowserTask 自带去重（同一个 pending 的活不会排两遍），
    // 所以每两小时跑一次也不会越堆越多——插件没来领的那条会被复用
    const r = await enqueueBrowserTask({
      workspaceId,
      payload: { kind: 'collect_competitor', competitorId: it.competitorId, limit: 20 },
      origin: 'schedule',
      createdBy: 'job:crawl_competitors',
    });
    if (r.ok) n++;
  }
  return n;
}
