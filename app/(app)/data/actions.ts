'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSession, withSession } from '@/lib/session';
import { toJson, parseJson, type Metrics } from '@/lib/json';
import { learnFromPerformance, type PerformanceInsight } from '@/lib/insight/learn';
import { requireRole } from '@/lib/rbac';
import { resolvePlatformItemId } from '@/lib/publish/parse-url';
import { PLATFORMS, platformName, type PlatformKey } from '@/lib/constants';
import { publishCsv, snapshotCsv } from '@/lib/insight/csv';
import { filterRecordsByRange, parseRange } from '@/lib/insight/dashboard-filter';
import { generateArticleReview } from '@/lib/insight/review';

// 手动回填一条发布记录（MVP 归因：发布登记 + 手动回填，不代发、不托管 Cookie）
//
// opts.url → 解析出 platformItemId，这是自动回流（lib/jobs/handlers.ts backfill_metrics）
// 的唯一入口；不写它这条记录就只能一直手填。
// opts.aigcConfirmed → PRD §6 F7-1 AC③「登记时 AI 声明确认项必选」的硬闸。
export async function actBackfill(
  platform: string,
  views: number,
  likes: number,
  fromRecommend = false,
  opts: { url?: string; aigcConfirmed?: boolean } = {},
): Promise<{ ok: boolean; id?: string; error?: string; warning?: string; platformItemId?: string }> {
  const s = await getSession();
  requireRole(s, 'content.publish'); // 登记发布记录属于发布动作
  if (!s.accountId) return { ok: false, error: '未选择账号' };
  // AC③ 必选：AI 声明确认是《标识办法》告知义务链条的一环，前端勾选框不算数——
  // 服务端不认这个 flag，前端那个勾就只是个装饰。
  if (opts.aigcConfirmed !== true) {
    return { ok: false, error: '请先确认「AI 使用声明」后再登记' };
  }
  const v = Number.isFinite(views) && views > 0 ? Math.round(views) : 0;
  const l = Number.isFinite(likes) && likes > 0 ? Math.round(likes) : 0;

  // 解析失败不阻断登记，但如实告知「自动回流将不可用」
  const warnings: string[] = [];
  let platformItemId: string | null = null;
  if (opts.url && opts.url.trim()) {
    const r = resolvePlatformItemId(opts.url, platform);
    platformItemId = r.platformItemId;
    if (r.warning) warnings.push(r.warning);
  } else {
    warnings.push('未填发布链接，未解析出作品 ID，这条记录的数据自动回流将不可用（需手动回填）。');
  }

  // 【只写这个表单真的问过的两项，且必须合并已有值】2026-08-30 之前这里是
  //   `toJson({ views: v, likes: l, comments: 0, shares: 0 })` + `update: { metrics }`（整包替换）。
  // 两个错叠在一起：
  //   ① 表单只有播放量和点赞两个输入框（Backfill.tsx），comments/shares 的 0 是代码补的——
  //      把「没问过」写成了「观测到 0」；
  //   ② 整包替换会把插件已经采到的 collects / danmaku / coins / completion / impressions /
  //      sources 全部抹掉。用户先用插件回填过一条 B站作品（评论 122、收藏 34、完播 42%），
  //      几天后看到「N 篇缺发布链接」的提醒来补个链接，一提交这些数就没了——
  //      而他完全不会知道是自己那次「登记」干的。
  // 同一文件 11 行之下的 actUpdateMetrics 写着一模一样的道理：
  //「不铺 prev 的话，用户手改一次播放量就会把这些字段整片抹掉」。那处做对了，这处没有。
  const existing = platformItemId !== null
    ? await prisma.publishRecord.findUnique({
        where: { accountId_platformItemId: { accountId: s.accountId, platformItemId } },
        select: { id: true, metrics: true },
      })
    : null;
  const prev = existing ? parseJson<Metrics>(existing.metrics, {}) : {};
  const merged: Metrics = { ...prev, views: v, likes: l };
  const metricsJson = toJson(merged);

  // 有作品ID → 命中唯一键就更新，杜绝同篇两条记录污染 learn 基线与统计。
  // 无作品ID → 建独立记录并打 needsBackfill。
  const rec = existing
    // 不覆盖 fromRecommend（登记入口的归因更可信），只更新 metrics 并解除缺链接标记
    ? await prisma.publishRecord.update({
        where: { id: existing.id },
        data: { metrics: metricsJson, needsBackfill: false },
      })
    : await prisma.publishRecord.create({
        data: {
          accountId: s.accountId, platform, platformItemId,
          needsBackfill: platformItemId === null, fromRecommend, metrics: metricsJson,
        },
      });
  // 同时落一条回流快照，作为归因时间线的起点。
  // 【写合并后的完整值，不是只写这次填的两项】authoritativeMetrics 是**整份挑一条快照**、
  // 不做跨快照合并（见 lib/insight/source-priority.ts）。只写 {views, likes} 的话，
  // 这条手填快照一旦当选权威，评论/收藏/完播就在整页上凭空消失。
  // lib/ingest/own-post.ts 的 applyMetrics 写快照用的也是 merged——快照是「那一刻的完整画面」。
  await prisma.performanceSnapshot.create({
    data: { publishId: rec.id, metrics: metricsJson },
  });
  // 触发账号属性学习（与基线对比、沉淀记忆）
  await learnFromPerformance(s.accountId, s.workspaceId, rec.id).catch(() => {});

  revalidatePath('/data');
  revalidatePath('/');
  return {
    ok: true,
    id: rec.id,
    platformItemId: platformItemId ?? undefined,
    warning: warnings.length ? warnings.join(' ') : undefined,
  };
}

// 更新已有发布记录的最新数据：滚动快照 + 触发账号属性学习闭环
// （发布 → 流量回流 → 与自身基线对比 → 沉淀记忆/风格指纹 → 反哺下一次诊断与推荐）
export async function actUpdateMetrics(
  publishId: string,
  input: { views: number; likes: number; comments?: number; shares?: number; collects?: number; completion?: number },
): Promise<{ ok: boolean; insights?: PerformanceInsight[]; error?: string }> {
  const s = await getSession();
  requireRole(s, 'content.publish'); // 回填/更新发布记录数据，同属发布动作
  const record = await prisma.publishRecord.findFirst({ where: { id: publishId, accountId: s.accountId } });
  if (!record) return { ok: false, error: '记录不存在' };

  const clean = (n: number | undefined) => (Number.isFinite(n) && (n as number) > 0 ? Math.round(n as number) : 0);
  const prev = parseJson<Metrics>(record.metrics, {});
  const metrics: Metrics = {
    // 先铺已有值：这个表单只编辑下面 6 个字段，而插件回填的 impressions / danmaku / coins /
    // sources（曝光、弹幕、投币、流量来源）不在表单里。不铺 prev 的话，用户手改一次播放量
    // 就会把这些字段整片抹掉——CTR、来源占比这些「公开页拿不到」的信号就永久没了。
    // 与 lib/ingest/own-post.ts applyMetrics 的合并口径一致：本次没给的字段不覆盖已有值。
    ...prev,
    views: clean(input.views),
    likes: clean(input.likes),
    comments: clean(input.comments),
    shares: clean(input.shares),
    collects: clean(input.collects),
    // 完播率 0-1；允许填 0–100 的百分数自动折算
    completion:
      typeof input.completion === 'number' && input.completion > 0
        ? input.completion > 1
          ? Math.min(1, input.completion / 100)
          : input.completion
        : prev.completion,
  };
  if (!metrics.views) return { ok: false, error: '播放量必填' };

  await prisma.publishRecord.update({ where: { id: record.id }, data: { metrics: toJson(metrics) } });
  await prisma.performanceSnapshot.create({ data: { publishId: record.id, metrics: toJson(metrics) } });

  const insights = await learnFromPerformance(s.accountId, s.workspaceId, record.id).catch(() => [] as PerformanceInsight[]);

  revalidatePath('/data');
  revalidatePath('/');
  return { ok: true, insights };
}

// 给缺链接的历史记录补发布链接：解析出 platformItemId 后，这条记录即进入
// lib/jobs/handlers.ts backfill_metrics 的自动回流集合（此前 platformItemId=null 被直接过滤）。
// 这是 /data 顶部「N 篇缺链接」提醒的落地入口——把「登记完就以为万事大吉」拉回闭环。
export async function actAttachPublishUrl(
  publishId: string,
  url: string,
): Promise<{ ok: boolean; error?: string; warning?: string; platformItemId?: string }> {
  // 查归属 → 查撞号 → 改，三步在同一事务里（短事务、纯 DB，可以走 withSession）。
  // 顺带把「先查后写」之间的竞态窗口收掉：并发两次登记同一链接时，
  // 唯一约束仍是最终真值点，但这里的可读错误不会再时灵时不灵。
  return withSession(async (s, tx) => {
    requireRole(s, 'content.publish');
    const record = await tx.publishRecord.findFirst({ where: { id: publishId, accountId: s.accountId } });
    if (!record) return { ok: false, error: '记录不存在' };
    if (!url || !url.trim()) return { ok: false, error: '请填写发布链接' };

    const r = resolvePlatformItemId(url, record.platform);
    if (!r.platformItemId) {
      // 解析不出作品 ID（链接非法或平台不符）→ 保持 needsBackfill，如实回传原因
      return { ok: false, error: r.warning ?? '无法从链接解析出作品 ID，请检查链接是否正确' };
    }
    // 该作品 ID 可能已登记在另一条记录上（唯一约束会拦），先行检测给出可读错误而非抛库异常
    const clash = await tx.publishRecord.findFirst({
      where: { accountId: s.accountId, platformItemId: r.platformItemId, id: { not: publishId } },
      select: { id: true },
    });
    if (clash) return { ok: false, error: '该作品链接已登记在另一条记录上，请勿重复登记' };

    await tx.publishRecord.update({
      where: { id: publishId },
      data: { platformItemId: r.platformItemId, needsBackfill: false },
    });
    revalidatePath('/data');
    revalidatePath('/');
    return { ok: true, platformItemId: r.platformItemId, warning: r.warning };
  });
}

// ── F9-2 自有作品导入：CSV 批量导入历史作品（充实基线，让学习引擎有料可学）──
// CSV 格式：platform,title,publishedAt,views,likes,comments,shares,collects,completion
// 第一行为表头（忽略），后续每行一条记录。
const VALID_PLATFORMS = new Set(Object.keys(PLATFORMS));
const MAX_IMPORT_ROWS = 200;

export type ImportResult = {
  ok: boolean;
  imported: number;
  skipped: number;
  errors: string[];
};

export async function actImportOwnPosts(csvText: string): Promise<ImportResult> {
  const s = await getSession();
  requireRole(s, 'content.publish');
  if (!s.accountId) return { ok: false, imported: 0, skipped: 0, errors: ['未选择账号'] };

  const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { ok: false, imported: 0, skipped: 0, errors: ['CSV 至少需要表头 + 1 行数据'] };

  const rows = lines.slice(1).slice(0, MAX_IMPORT_ROWS);
  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const cols = parseCSVLine(rows[i]);
    if (cols.length < 2) {
      errors.push(`第 ${i + 2} 行：列数不足`);
      skipped++;
      continue;
    }

    const platform = cols[0].trim().toLowerCase();
    if (!VALID_PLATFORMS.has(platform)) {
      errors.push(`第 ${i + 2} 行：平台 "${cols[0]}" 无效`);
      skipped++;
      continue;
    }

    const title = cols[1].trim().slice(0, 200);
    if (!title) {
      errors.push(`第 ${i + 2} 行：标题为空`);
      skipped++;
      continue;
    }

    const publishedAt = cols[2] ? parseDate(cols[2].trim()) : null;
    const num = (idx: number) => {
      const raw = cols[idx]?.trim();
      if (!raw) return 0;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    };
    const views = num(3);
    const likes = num(4);
    const comments = num(5);
    const shares = num(6);
    const collects = num(7);
    const completionRaw = cols[8] ? parseFloat(cols[8].trim()) : undefined;
    const completion = completionRaw !== undefined && Number.isFinite(completionRaw)
      ? completionRaw > 1 ? Math.min(1, completionRaw / 100) : Math.max(0, completionRaw)
      : undefined;

    const metrics: Metrics = { views, likes, comments, shares, collects, completion };

    await prisma.ownPost.create({
      data: {
        accountId: s.accountId,
        platform: platform as PlatformKey,
        title,
        publishedAt,
        metrics: toJson(metrics),
      },
    });
    imported++;
  }

  if (lines.length - 1 > MAX_IMPORT_ROWS) {
    errors.push(`超出上限：仅导入前 ${MAX_IMPORT_ROWS} 行，剩余已忽略`);
  }

  revalidatePath('/data');
  return { ok: imported > 0, imported, skipped, errors: errors.slice(0, 10) };
}

function parseDate(s: string): Date | null {
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && !inQuotes) {
      inQuotes = true;
    } else if (c === '"' && inQuotes) {
      if (line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = false;
      }
    } else if (c === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  result.push(current);
  return result;
}

// ── CSV 导出（导出=所见即所得，受当前筛选约束）──
// scope='publish' 每篇明细一行；scope='snapshot' 每篇×每逻辑日一行（AI分析/自建报表原料）。
export async function actExportData(
  scope: 'publish' | 'snapshot',
  filters: { range?: string; platform?: string } = {},
): Promise<{ ok: boolean; filename?: string; dataBase64?: string; error?: string }> {
  const s = await getSession();
  requireRole(s, 'content.view');
  if (!s.accountId) return { ok: false, error: '未选择账号' };

  const all = await prisma.publishRecord.findMany({
    where: { accountId: s.accountId },
    include: { snapshots: { orderBy: { takenAt: 'asc' } } },
    orderBy: { publishedAt: 'desc' },
  });

  const range = parseRange(filters.range);
  const platform = filters.platform && filters.platform !== 'all' ? filters.platform : null;
  const scoped = filterRecordsByRange(all, range, Date.now()).filter((r) => !platform || r.platform === platform);

  const csv = scope === 'snapshot' ? snapshotCsv(scoped) : publishCsv(scoped);
  const tag = platform ? platformName(platform) : '全平台';
  const filename = `烽火台_${scope === 'snapshot' ? '逐日快照' : '发布明细'}_${tag}_${range}.csv`;
  return { ok: true, filename, dataBase64: Buffer.from(csv, 'utf-8').toString('base64') };
}

// ── AI 单篇复盘（Phase 2）：确定性数据事实 + LLM 归因，三合一回流见 lib/insight/review.ts ──
export async function actGenerateReview(publishId: string) {
  const s = await getSession();
  requireRole(s, 'content.create'); // 调 LLM 生成复盘，属内容产出
  if (!s.accountId) return { ok: false as const, error: '未选择账号' };
  try {
    const review = await generateArticleReview({
      tenantId: s.tenantId,
      accountId: s.accountId,
      workspaceId: s.workspaceId,
      publishId,
    });
    if (!review) return { ok: false as const, error: '记录不存在' };
    revalidatePath('/data');
    return { ok: true as const, review };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message.slice(0, 140) };
  }
}
