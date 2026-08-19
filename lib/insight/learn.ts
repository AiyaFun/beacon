import { prisma } from '../db';
import { parseJson, toJson, type Metrics, engagementRate } from '../json';
import { buildBaseline } from '../algorithm/coach';
import { writeMemory } from '../memory/core';
import { platformName } from '../constants';
import { readFingerprint, mergeLayer, toFingerprintJson } from '../style';
import { advisorWeight, dataDeltaFromNotes, type LearnedNote } from '../advisor/weight';
import { authoritativeMetrics } from './source-priority';

// 发布回流 → 账号属性持续学习引擎。
// 每次某条发布的数据被回填/更新，就把它与账号在该平台的历史基线对比，
// 沉淀成「稳定措辞」的记忆（同类结论重复出现会累计置信度直至生效），
// 并把高表现选题的切入角写进风格指纹 topic 层——账号越发越懂自己。

export type PerformanceInsight = {
  kind: 'overperform' | 'underperform' | 'angle' | 'platform';
  text: string;
};

// 高/低表现判定倍数（相对账号自身基线，非绝对值）
const OVER_RATIO = 1.5;
const UNDER_RATIO = 0.5;
// 基线至少要有的样本数（不含本条），不足时只积累不下结论
const MIN_PEERS = 3;

// 切入角结论的两种方向。措辞是稳定契约：writeMemory 靠 content 全等去重累计，互斥也靠它反查。
const angleProven = (angle: string, pName: string) => `切入角「${angle}」在${pName}被数据验证有效`;
const angleFailed = (angle: string, pName: string) => `切入角「${angle}」在${pName}未跑出基线`;

// 矛盾记忆互斥：同一切入角在同一平台的正反结论不能同时生效——否则两条一起注入
// prompt 自相矛盾。写入某方向前先把反方向下线；只置 active=false 不删，hitCount 留着，
// 数据反转时反方向结论走去重累计还能重新生效（口味回潮是常态）。
async function deactivateOpposite(workspaceId: string, accountId: string, opposite: string): Promise<void> {
  await prisma.memoryEntry.updateMany({
    where: { workspaceId, accountId, type: 'preference', content: opposite, active: true },
    data: { active: false },
  });
}

export async function learnFromPerformance(
  accountId: string,
  workspaceId: string,
  publishId: string,
): Promise<PerformanceInsight[]> {
  const record = await prisma.publishRecord.findFirst({
    where: { id: publishId, accountId },
  });
  if (!record) return [];
  // 下结论用「来源优先级」挑出的值，不是 PublishRecord.metrics 上那个「谁最后写谁说了算」的值。
  // 用户随手补的一个约数不该盖掉适配器同日拉回来的精确值——判跑赢/跑输、写记忆、改选题状态
  // 全靠这个数，它错了后面整条链都错。挑选规则见 source-priority.ts（含为何按逻辑日分组）。
  const snapshots = await prisma.performanceSnapshot.findMany({
    where: { publishId },
    select: { takenAt: true, metrics: true, source: true, milestone: true },
  });
  const m = authoritativeMetrics(record.metrics, snapshots, record.publishedAt);
  if (!m.views || m.views <= 0) return [];
  // PublishRecord.topicId 是无 FK 松引用（选题可能已被清理），findUnique 取不到就当没有归因
  const topic = record.topicId
    ? await prisma.topicIdea.findUnique({
        where: { id: record.topicId },
        select: { id: true, angle: true, state: true, rationale: true, sourceType: true, sourceRef: true },
      })
    : null;

  // 同平台其他发布 + 历史作品 = 账号自身基线
  const [peers, ownPosts] = await Promise.all([
    prisma.publishRecord.findMany({
      where: { accountId, platform: record.platform, id: { not: publishId } },
      orderBy: { publishedAt: 'desc' },
      take: 30,
      select: { metrics: true },
    }),
    prisma.ownPost.findMany({
      where: { accountId, platform: record.platform },
      orderBy: { publishedAt: 'desc' },
      take: 20,
      select: { metrics: true },
    }),
  ]);
  const peerMetrics = [...peers, ...ownPosts]
    .map((p) => parseJson<Metrics>(p.metrics, {}))
    .filter((x) => (x.views ?? 0) > 0);
  const baseline = buildBaseline(peerMetrics);

  const insights: PerformanceInsight[] = [];
  const pName = platformName(record.platform);
  const title = record.title ?? '未命名内容';
  const angle = topic?.angle?.trim();

  if (baseline.sample >= MIN_PEERS && baseline.avgViews !== null && baseline.avgViews > 0) {
    const avgViews = baseline.avgViews; // 收窄一次，下面整段都不必再判空
    const ratio = m.views / avgViews;

    if (ratio >= OVER_RATIO) {
      insights.push({
        kind: 'overperform',
        text: `《${title}》在${pName}播放 ${m.views}，高出账号基线（${avgViews}）${Math.round((ratio - 1) * 100)}%`,
      });
      // 绩效记忆：账号级稳定措辞（聚合信号，非单篇明细）。
      // 为什么不写「《标题》超基线 x%」：那个 x% 每次回流（T+48h/T+7d/多次手填）都不同，
      // content 不全等 → writeMemory 去重永不命中 → 同一篇在记忆里堆成一排僵尸条目，
      // 且 conf0.5 单条即生效，一篇爆款就能塞满 12 个注入位把多样经验挤走。
      // 改为平台级稳定措辞：同平台每出一篇跑赢基线就累计一次，攒到 hitCount≥2 或 conf≥0.7
      // 才「生效」注入——这正是设计要的「重复验证才算数」。conf 0.4 让首篇只积累不注入。
      // 单篇超基线多少的明细走 insights 即时回显给用户，不沉淀进长期记忆。
      await writeMemory({
        workspaceId,
        accountId,
        type: 'performance',
        content: `${pName}高表现内容特征正在形成`,
        confidence: 0.4,
      });
      // 偏好记忆：切入角级（稳定措辞——同一切入角再次跑赢会累计命中并「生效」，这就是持续学习）
      if (angle) {
        await deactivateOpposite(workspaceId, accountId, angleFailed(angle, pName));
        await writeMemory({
          workspaceId,
          accountId,
          type: 'preference',
          content: angleProven(angle, pName),
          confidence: 0.45,
        });
        insights.push({ kind: 'angle', text: `切入角「${angle}」被数据验证有效，已计入账号偏好` });
        await addFingerprintTopic(accountId, angle);
      }
    } else if (ratio <= UNDER_RATIO) {
      insights.push({
        kind: 'underperform',
        text: `《${title}》在${pName}播放 ${m.views}，低于账号基线（${avgViews}）${Math.round((1 - ratio) * 100)}%`,
      });
      if (angle) {
        await deactivateOpposite(workspaceId, accountId, angleProven(angle, pName));
        await writeMemory({
          workspaceId,
          accountId,
          type: 'preference',
          content: angleFailed(angle, pName),
          confidence: 0.35,
        });
      }
    }

    // ── P1-3 发布复盘回写选题（激活 reviewed 态）+ W-5 数据校准人物战绩 ──
    // 放在 over/under 判定之外：跑平也是结论，选题一样要被标记复盘过，否则 reviewed 只记得极端值。
    if (topic) {
      await reviewTopicFromPerformance(topic, {
        title,
        platformName: pName,
        views: m.views,
        avgViews,
        sample: baseline.sample,
        ratio,
      });
      if (ratio >= OVER_RATIO || ratio <= UNDER_RATIO) {
        await calibrateAdvisorPersona(accountId, topic, {
          proven: ratio >= OVER_RATIO,
          title,
          platformName: pName,
        });
      }
    }

    // 互动结构信号：本条互动率显著高于基线均值 → 记账号属性事实。
    // 本条或基线任一算不出互动率（没有播放量做分母）就整个跳过：
    // 拿 0 去比会稳定得出「没超基线」，等于永远学不到东西，还看不出是缺数据。
    const eng = engagementRate(m);
    const { likeRate, commentRate, shareRate, collectRate } = baseline;
    const baseEng =
      likeRate === null || commentRate === null || shareRate === null || collectRate === null
        ? null
        : likeRate + commentRate + shareRate + collectRate;
    if (eng !== null && baseEng !== null && baseEng > 0 && eng >= baseEng * 1.5) {
      await writeMemory({
        workspaceId,
        accountId,
        type: 'fact',
        content: `账号在${pName}的高互动内容特征正在形成（互动率显著超基线）`,
        confidence: 0.4,
      });
    }
  } else {
    insights.push({
      kind: 'platform',
      text: `${pName}回流样本 ${baseline.sample + 1} 条（满 ${MIN_PEERS + 1} 条后开始输出账号级学习结论）`,
    });
  }

  return insights;
}

// ─────────────────────────────────────────────────────────────
// P1-3 表现数据回写选题：激活七态里从未被写入的 reviewed
// ─────────────────────────────────────────────────────────────

// rationale 里复盘段的稳定标记：回流会发生多次（T+48h / T+7d / 用户多次手填），
// 每次都追加就会把 rationale 撑成流水账 —— 认标记做「整段替换」而不是 append。
export const REVIEW_MARK = '【发布复盘】';

type ReviewFacts = {
  title: string;
  platformName: string;
  views: number;
  avgViews: number;
  sample: number;
  ratio: number;
};

export function reviewSummaryText(f: ReviewFacts): string {
  const pctOfBase = Math.round(f.ratio * 100);
  const verdict = f.ratio >= OVER_RATIO ? '跑赢' : f.ratio <= UNDER_RATIO ? '跑输' : '基本持平';
  return `${REVIEW_MARK}《${f.title}》在${f.platformName}播放 ${f.views}，为账号同平台基线（${f.avgViews}，${f.sample} 条样本）的 ${pctOfBase}%，${verdict}。`;
}

// rationale 去掉旧复盘段（含其前的空行），保留 LLM 精排原文
export function stripReviewSection(rationale: string | null): string {
  if (!rationale) return '';
  const i = rationale.indexOf(REVIEW_MARK);
  return i < 0 ? rationale.trimEnd() : rationale.slice(0, i).trimEnd();
}

async function reviewTopicFromPerformance(
  topic: { id: string; state: string; rationale: string | null },
  facts: ReviewFacts,
): Promise<void> {
  // 用户明确否决过的选题不因为一条发布回流被改写成 reviewed —— 否决是人的判断，数据不能替他翻案
  if (topic.state === 'rejected') return;
  const base = stripReviewSection(topic.rationale);
  const rationale = [base, reviewSummaryText(facts)].filter(Boolean).join('\n\n');
  await prisma.topicIdea.update({
    where: { id: topic.id },
    data: { state: 'reviewed', rationale },
  });
}

// ─────────────────────────────────────────────────────────────
// P1-3 消费端：账号的「切入角历史战绩」事实块，注入选题精排
// ─────────────────────────────────────────────────────────────

// 从「发布记录 ← 选题」的松引用反查，按切入角聚合真实表现。
// 与记忆里的 angleProven/angleFailed 是两条独立链路：那条靠措辞全等去重累计（脆弱），
// 这条每次现算，样本数与倍率都摆在明面上，LLM 能据此定量而不是只看一句断言。
export async function angleTrackRecordBlock(accountId: string, limit = 6): Promise<string> {
  const records = await prisma.publishRecord.findMany({
    where: { accountId, topicId: { not: null } },
    orderBy: { publishedAt: 'desc' },
    take: 60,
    select: { topicId: true, platform: true, metrics: true },
  });
  if (records.length === 0) return '';

  const profiles = await accountPlatformProfiles(accountId);
  const avgByPlatform = new Map(profiles.filter((p) => p.avgViews > 0).map((p) => [p.platform, p.avgViews]));
  if (avgByPlatform.size === 0) return '';

  const topicIds = [...new Set(records.map((r) => r.topicId!).filter(Boolean))];
  const topics = await prisma.topicIdea.findMany({
    where: { id: { in: topicIds } },
    select: { id: true, angle: true },
  });
  const angleById = new Map(topics.map((t) => [t.id, t.angle?.trim() ?? '']));

  // 按切入角聚合「本条播放 / 该平台账号均播放」的比值
  const byAngle = new Map<string, number[]>();
  for (const r of records) {
    const angle = angleById.get(r.topicId!) ?? '';
    if (!angle) continue;
    const base = avgByPlatform.get(r.platform);
    if (!base || base <= 0) continue;
    const views = parseJson<Metrics>(r.metrics, {}).views ?? 0;
    if (views <= 0) continue;
    const key = angle.slice(0, 30);
    if (!byAngle.has(key)) byAngle.set(key, []);
    byAngle.get(key)!.push(views / base);
  }

  // 单篇的表现噪声太大，2 篇起才敢当「这类切入角的战绩」说给 LLM 听
  const rows = [...byAngle.entries()]
    .filter(([, ratios]) => ratios.length >= 2)
    .map(([angle, ratios]) => ({
      angle,
      n: ratios.length,
      ratio: ratios.reduce((a, b) => a + b, 0) / ratios.length,
    }))
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, limit);
  if (rows.length === 0) return '';

  const lines = rows.map((r) => {
    const verdict = r.ratio >= OVER_RATIO ? '明显跑赢' : r.ratio <= UNDER_RATIO ? '明显跑输' : '与基线相当';
    return `- 切入角「${r.angle}」：${r.n} 篇，平均为账号同平台基线的 ${Math.round(r.ratio * 100)}%（${verdict}）`;
  });
  return ['【该账号切入角历史战绩（发布回流实测）】', ...lines].join('\n');
}

// ─────────────────────────────────────────────────────────────
// W-5 发布数据校准智囊团人物战绩
// ─────────────────────────────────────────────────────────────

// 人物战绩此前只由用户手动采纳/否决驱动。这里补上数据侧：
// 该人物的提案 → 采纳成选题（sourceType='advisor', sourceRef=opinionId）→ 发布 → 数据跑赢/跑输，
// 结论写进 learnedNotes 并微调 weight（幅度小于人工判定，见 weight.ts 的取舍说明）。
//
// 唯一入口：发布回流（本文件）与 AI 单篇复盘（insight/review.ts）两条链路都调这里。
// 两条都能对同一篇下结论，靠 subject（标题+平台）键去重，谁后到谁作数——绝不各写各的堆成两条。
export async function calibrateAdvisorPersona(
  accountId: string,
  topic: { sourceType: string; sourceRef: string | null },
  outcome: { proven: boolean; title: string; platformName: string },
): Promise<void> {
  if (topic.sourceType !== 'advisor' || !topic.sourceRef) return;
  const opinion = await prisma.advisorOpinion.findFirst({
    where: { id: topic.sourceRef, session: { accountId } },
    select: { personaKey: true },
  });
  if (!opinion) return;
  const persona = await prisma.advisorPersona.findUnique({
    where: { accountId_key: { accountId, key: opinion.personaKey } },
  });
  if (!persona) return;

  const notes = parseJson<LearnedNote[]>(persona.learnedNotes, []);
  // 幂等 + 可翻案：同一篇（标题+平台）只保留最新一条数据结论。
  // 回流会重复触发（T+48h 跑输、T+7d 长尾跑赢很常见），既不能累计成一排重复条目，
  // 也不能让先到的结论把后到的真相钉死。
  const subject = `《${outcome.title}》（${outcome.platformName}）`;
  const kept = notes.filter((n) => !((n.verdict === 'data_proven' || n.verdict === 'data_failed') && n.text.includes(subject)));
  kept.push({
    verdict: outcome.proven ? 'data_proven' : 'data_failed',
    text: `数据验证：${subject}${outcome.proven ? '跑赢' : '跑输'}账号基线`,
    at: new Date().toISOString(),
  });
  const trimmed = kept.slice(-20);

  await prisma.advisorPersona.update({
    where: { id: persona.id },
    data: {
      learnedNotes: toJson(trimmed),
      weight: advisorWeight(persona.adoptedCount, persona.rejectedCount, persona.key, dataDeltaFromNotes(trimmed)),
    },
  });
}

// ─────────────────────────────────────────────────────────────
// W-4 创作过程信号：草稿被搁置 → 该切入角「落地难」写回记忆
// ─────────────────────────────────────────────────────────────

const ABANDON_DAYS = 14;

// 起了初稿却长期没再动、而账号这段时间明明在做别的内容 = 这个切入角在实操层面难产。
// 两个刻意的克制：
//   ① 必须有「换去做别的」的证据（更新过别的草稿 / 发过别的内容），否则只是账号整体停更，
//      不该赖到某个切入角头上；
//   ② 处理过的草稿标记为 abandoned，避免每日 job 反复给同一条记忆刷 hitCount 把置信度刷成生效。
//      用户回来重新生成初稿会把状态改回 editing（actDraft），信号自然复活。
export async function learnFromAbandonedDrafts(
  workspaceId: string,
  now: Date = new Date(),
): Promise<{ marked: number }> {
  const cutoff = new Date(now.getTime() - ABANDON_DAYS * 86400000);
  const stale = await prisma.draft.findMany({
    where: {
      status: 'editing',
      updatedAt: { lt: cutoff },
      topicId: { not: null },
      account: { workspaceId },
    },
    select: { id: true, accountId: true, updatedAt: true, topicId: true },
    take: 50,
  });
  let marked = 0;
  for (const d of stale) {
    const [movedOn, published] = await Promise.all([
      prisma.draft.count({
        where: { accountId: d.accountId, id: { not: d.id }, updatedAt: { gt: d.updatedAt } },
      }),
      prisma.publishRecord.count({
        where: { accountId: d.accountId, publishedAt: { gt: d.updatedAt } },
      }),
    ]);
    if (movedOn === 0 && published === 0) continue; // 账号整体停更，不归咎于切入角

    const topic = await prisma.topicIdea.findUnique({
      where: { id: d.topicId! },
      select: { angle: true },
    });
    const angle = topic?.angle?.trim();
    if (angle) {
      await writeMemory({
        workspaceId,
        accountId: d.accountId,
        type: 'preference',
        // 稳定措辞：同类切入角再次难产会累计命中，攒够才生效——与 angleProven/angleFailed 同一套机制
        content: `切入角「${angle.slice(0, 30)}」落地难：初稿起了但长期未完成`,
        confidence: 0.3,
      });
    }
    await prisma.draft.update({ where: { id: d.id }, data: { status: 'abandoned' } });
    marked++;
  }
  return { marked };
}

// 把被数据验证的切入角沉淀进风格指纹 topic 层（去重+累计 score/count，FIFO 12 条）
async function addFingerprintTopic(accountId: string, angle: string): Promise<void> {
  const account = await prisma.creatorAccount.findUnique({ where: { id: accountId } });
  if (!account) return;
  const fp = readFingerprint(account.styleFingerprint);
  const entry = angle.slice(0, 30);
  const incoming = [{ tag: entry, score: 0.6, count: 1 }];
  const merged = { ...fp, topic: mergeLayer(fp.topic, incoming) };
  await prisma.creatorAccount.update({
    where: { id: accountId },
    data: { styleFingerprint: toFingerprintJson(merged) },
  });
}

// 账号属性画像：按平台聚合基线，给「这个账号是什么属性」的可视判断
export type PlatformProfile = {
  platform: string;
  sample: number;
  avgViews: number;
  avgCompletion: number | null;
  engagement: number | null; // 互动率合计（赞+评+转+藏 / 播放 的均值和）；无播放量的平台为 null
};

export async function accountPlatformProfiles(accountId: string): Promise<PlatformProfile[]> {
  const [records, ownPosts] = await Promise.all([
    prisma.publishRecord.findMany({
      where: { accountId },
      select: { platform: true, metrics: true },
    }),
    prisma.ownPost.findMany({
      where: { accountId },
      select: { platform: true, metrics: true },
    }),
  ]);
  const byPlatform = new Map<string, Metrics[]>();
  for (const r of [...records, ...ownPosts]) {
    const m = parseJson<Metrics>(r.metrics, {});
    if (!m.views || m.views <= 0) continue;
    if (!byPlatform.has(r.platform)) byPlatform.set(r.platform, []);
    byPlatform.get(r.platform)!.push(m);
  }
  const profiles: PlatformProfile[] = [];
  for (const [platform, list] of byPlatform) {
    const b = buildBaseline(list);
    // 上面已经按 views>0 过滤过，这里 avgViews 不可能是 null；真到了就说明过滤失效，
    // 那宁可不产出这条画像，也不要 `?? 0` 把一个假均播摆到页面上。
    if (b.avgViews === null) continue;
    profiles.push({
      platform,
      sample: b.sample,
      avgViews: b.avgViews,
      avgCompletion: b.avgCompletion,
      // 四个率任一为 null（该平台拿不到播放量）就整体为 null——不能把缺席当 0 加进来
      engagement:
        b.likeRate === null || b.commentRate === null || b.shareRate === null || b.collectRate === null
          ? null
          : b.likeRate + b.commentRate + b.shareRate + b.collectRate,
    });
  }
  return profiles.sort((a, b) => b.avgViews - a.avgViews);
}
