import { prisma } from '../db';
import { resolvePlatformItemId } from './parse-url';
import { writeMemory } from '../memory/core';
import { platformName } from '../constants';

// ── 「这篇发出去了」这件事怎么落库 ────────────────────────────────────────────
//
// 两个入口都走这里：用户手动「登记发布」，以及一键发布的任务回执。
// 抽出来的理由是**唯一事实来源**：这段 upsert 里有三处容易各写各的地方——
//   ① 有作品 ID 时要 upsert 到 (accountId, platformItemId)，不能各建一条
//      （否则同一篇在 learn 基线里算两次、/data 篇数翻倍）；
//   ② needsBackfill 恒等于 platformItemId==null，两处写漂移就会出现「有链接却说缺链接」；
//   ③ 草稿与选题的状态要一起推进，漏一处就出现「已发布的稿子还停在编辑中」。
// 复制一份到发布任务那条路上，早晚会漂。

export type RecordPublishInput = {
  workspaceId: string;
  accountId: string;
  draft: {
    id: string;
    title: string;
    platform: string;
    topicId: string | null;
    /** 选题的切入角，用于写入偏好记忆（没有就不写） */
    topicAngle?: string | null;
    /** 选题来源类型，用于归因 fromRecommend */
    topicSourceType?: string | null;
  };
  content: string;
  /** 发布链接（可空：允许先记一笔，之后补） */
  url?: string | null;
  /** 已经解析好的作品 ID（插件回执可能直接给得出，就不必再解析一次链接） */
  platformItemId?: string | null;
};

export type RecordPublishResult = {
  platformItemId: string | null;
  warnings: string[];
};

export async function recordPublished(input: RecordPublishInput): Promise<RecordPublishResult> {
  const { workspaceId, accountId, draft, content } = input;
  const fromRecommend = !!draft.topicId && ['hot', 'competitor', 'advisor'].includes(draft.topicSourceType ?? '');

  const warnings: string[] = [];
  let platformItemId: string | null = input.platformItemId ?? null;
  if (platformItemId === null) {
    if (input.url && input.url.trim()) {
      const r = resolvePlatformItemId(input.url, draft.platform);
      platformItemId = r.platformItemId;
      if (r.warning) warnings.push(r.warning);
    } else {
      warnings.push('未填发布链接，未解析出作品 ID，这条记录的数据自动回流将不可用（需手动回填）。');
    }
  }

  const needsBackfill = platformItemId === null;
  if (platformItemId !== null) {
    await prisma.publishRecord.upsert({
      where: { accountId_platformItemId: { accountId, platformItemId } },
      create: {
        accountId,
        topicId: draft.topicId,
        draftId: draft.id,
        platform: draft.platform,
        title: draft.title,
        contentText: content,
        platformItemId,
        needsBackfill: false,
        fromRecommend,
      },
      // 补上登记侧才有的正文/标题/选题归因并解除缺链接标记；不动已回填的 metrics。
      update: {
        topicId: draft.topicId,
        draftId: draft.id,
        title: draft.title,
        contentText: content,
        needsBackfill: false,
        fromRecommend,
      },
    });
  } else {
    await prisma.publishRecord.create({
      data: {
        accountId,
        topicId: draft.topicId,
        draftId: draft.id,
        platform: draft.platform,
        title: draft.title,
        contentText: content,
        platformItemId: null,
        needsBackfill,
        fromRecommend,
      },
    });
  }

  await prisma.draft.update({ where: { id: draft.id }, data: { status: 'published' } });
  if (draft.topicId) {
    await prisma.topicIdea.update({ where: { id: draft.topicId }, data: { state: 'published' } }).catch(() => {});
  }
  // 记忆学习：发布即形成偏好/绩效信号，反哺后续推荐与语义召回
  if (draft.topicAngle) {
    await writeMemory({
      workspaceId,
      accountId,
      type: 'preference',
      content: `采用并发布了切入角：${draft.topicAngle}`,
      confidence: 0.4,
    });
  }
  await writeMemory({
    workspaceId,
    accountId,
    type: 'performance',
    content: `发布《${draft.title}》到${platformName(draft.platform)}`,
    confidence: 0.3,
  });

  return { platformItemId, warnings };
}
