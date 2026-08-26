import { prisma } from '../db';
import { parseJson, type Metrics } from '../json';
import { llmComplete } from '../llm/gateway';
import { fmtDate } from '../format';
import { platformName } from '../constants';
import { authoritativeMetrics } from '../insight/source-priority';
import { absenceNote } from '../insight/platform-metrics';
import { readerVoice, KIND_LABEL } from '../insight/reader-voice';

// ── 情报简报：工作流 analyze 步的实现 ────────────────────────────────────────
//
// 「每天采一遍对家 → 出一份对比简报 → 推到群里」这类流水线，此前在四类可编排单位里
// 是拼不出来的：六种步骤全都围着草稿转，没有一种是「看一眼数据然后说人话」。
//
// 【它刻意不采新数据】只读库里已经有的。要新数据是采集/插件那条链的事——
// 混在一起会让一次「出简报」变成一次几分钟的采集，而用户以为只是看一眼。

export type BriefTarget = 'performance' | 'rivals' | 'readers';

export const BRIEF_TITLE: Record<BriefTarget, string> = {
  performance: '我的作品表现',
  rivals: '对家最近在发什么',
  readers: '读者在关心什么',
};

type Facts = { lines: string[]; empty: boolean; note?: string };

/**
 * 先把**确定性事实**摆出来，再交给模型写成人话。
 *
 * 【为什么不直接让模型查】模型看不到库。而如果把原始行丢给它自己算，
 * 它会把缺席的指标当成 0——这个坑本项目踩过两次。这里算好、缺的说清楚，
 * 模型只负责组织语言。
 */
async function collectFacts(
  target: BriefTarget,
  scope: { workspaceId: string; accountId: string },
): Promise<Facts> {
  if (target === 'performance') {
    const records = await prisma.publishRecord.findMany({
      where: { accountId: scope.accountId },
      orderBy: { publishedAt: 'desc' },
      take: 10,
      select: {
        title: true, platform: true, publishedAt: true, metrics: true,
        snapshots: { select: { takenAt: true, metrics: true, source: true, milestone: true } },
      },
    });
    if (records.length === 0) return { lines: [], empty: true, note: '这个账号还没有发布记录' };

    return {
      empty: false,
      lines: records.map((r) => {
        const m = authoritativeMetrics(r.metrics, r.snapshots, r.publishedAt);
        // 缺席就写「该平台没有这项」，绝不写 0——写 0 模型会算出假的互动率
        const views = typeof m.views === 'number' ? `播放 ${m.views}` : `播放：${absenceNote(r.platform, 'views')}`;
        const likes = typeof m.likes === 'number' ? `赞 ${m.likes}` : '赞：没采到';
        return `《${r.title ?? '无标题'}》${platformName(r.platform)} ${fmtDate(r.publishedAt)} — ${views}，${likes}`;
      }),
    };
  }

  if (target === 'rivals') {
    const watched = await prisma.watchlistItem.findMany({
      where: { workspaceId: scope.workspaceId },
      include: { competitor: { select: { id: true, name: true, platform: true } } },
    });
    if (watched.length === 0) return { lines: [], empty: true, note: '还没有添加任何对标账号' };

    const since = new Date(Date.now() - 7 * 86_400_000);
    const lines: string[] = [];
    for (const w of watched) {
      const posts = await prisma.crawledPost.findMany({
        where: { competitorId: w.competitor.id, publishedAt: { gte: since } },
        orderBy: { publishedAt: 'desc' },
        take: 5,
        select: { title: true, publishedAt: true, metrics: true },
      });
      if (posts.length === 0) {
        // 「这一周没发」与「我们没采到」是两件事，但库里分不出来——如实说成后者的可能
        lines.push(`${w.competitor.name}（${platformName(w.competitor.platform)}）：近 7 天没有采到新作品`);
        continue;
      }
      for (const p of posts) {
        const m = parseJson<Metrics>(p.metrics, {});
        const heat = typeof m.likes === 'number' ? `赞 ${m.likes}` : '互动数据没采到';
        lines.push(`${w.competitor.name}：《${p.title}》${p.publishedAt ? fmtDate(p.publishedAt) : ''} — ${heat}`);
      }
    }
    return { empty: false, lines };
  }

  // readers
  const voice = await readerVoice(scope.workspaceId, { scope: 'own', accountId: scope.accountId });
  if (voice.total === 0) {
    return { lines: [], empty: true, note: '没有留存的读者评论（评论正文只保留 90 天，也可能是还没用插件采过）' };
  }
  return {
    empty: false,
    lines: [
      `共 ${voice.total} 条读者评论`,
      ...voice.kinds.map((k) => `${KIND_LABEL[k.kind] ?? k.kind}：${k.count} 条（${k.pct}%）`),
      ...voice.concerns.slice(0, 8).map((c) => `反复被提到「${c.term}」（${c.docs} 条），例如：${c.samples[0] ?? ''}`),
    ],
  };
}

export type BriefResult =
  | { ok: true; title: string; text: string; mocked: boolean }
  | { ok: false; error: string };

export async function buildBrief(
  ctx: { tenantId: string; workspaceId: string; accountId: string },
  target: BriefTarget,
): Promise<BriefResult> {
  const facts = await collectFacts(target, ctx);
  const title = BRIEF_TITLE[target];

  // 没有素材就**不调模型**：让它对着空数据写，出来的一定是一段编的
  if (facts.empty) {
    return { ok: false, error: `${title}：${facts.note ?? '没有可用的数据'}，这次没出简报` };
  }

  const res = await llmComplete(
    ctx.tenantId,
    'generation',
    [
      {
        role: 'system',
        content:
          '你在写一份给创作者本人看的简报。规矩：'
          + '① 只用下面给出的事实，一个数字都不许自己编或估算；'
          + '② 凡是写着「没采到」「该平台没有」的项，就说没有这项数据，**绝不当成 0**；'
          + '③ 先说结论再说依据，全文控制在 300 字以内，用中文；'
          + '④ 最后给一条具体的、今天就能做的建议。',
      },
      { role: 'user', content: `简报主题：${title}\n\n事实清单：\n${facts.lines.join('\n')}` },
    ],
    { temperature: 0.4 },
  );

  return { ok: true, title, text: res.text.trim(), mocked: res.mocked };
}
