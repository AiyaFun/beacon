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
//   ④ 同一篇稿子在同一个平台只留一条记录 —— 唯一约束挡不住 platformItemId=null 的重复，
//      详见下面 prior 那一段。
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

  // ④ **同一篇稿子 + 同一个平台，只该有一条发布记录。**
  //
  // 唯一约束 (accountId, platformItemId) 挡不住这件事：SQL 里 NULL 互异，所以每一条
  // 「还没链接」的记录都能重复插入。两条真实路径都会撞上：
  //   · 用户先点「登记发布」但没贴链接（很常见——刚发完还没拿到分享链接），
  //     过一会儿拿到链接再点一次 → 走 upsert 又建了**第二条**，第一条永远停在
  //     needsBackfill=true，/data 顶部那句「N 篇缺链接学不到数据」永远消不掉；
  //   · 插件回执重发（网络重试／用户又点了一次「我发完了」）→ 每次再建一条。
  // 后果与上面 ① 说的是同一件事：learn 基线算两次、/data 篇数翻倍。
  //
  // 稿子路径与 /data 的手动回填不同：这里**一定**有 draftId，所以
  // (accountId, draftId, platform) 就是「这一篇在这个平台」的天然主键，拿它先认领旧记录。
  // 手动回填没有 draftId，「缺链接的两条各自独立」是它那边刻意的口径，别把它一起改了。
  const prior = await prisma.publishRecord.findFirst({
    where: { accountId, draftId: draft.id, platform: draft.platform },
    orderBy: { publishedAt: 'asc' },
    select: { id: true, platformItemId: true },
  });
  const isFirstRecord = prior === null;

  // 每条分支都要写的字段。platform 只在 create 时给：更新一条已存在的记录时改平台，
  // 等于把回流指到另一个平台去找作品。
  const common = {
    topicId: draft.topicId,
    draftId: draft.id,
    title: draft.title,
    contentText: content,
    fromRecommend,
  };

  if (platformItemId !== null) {
    // 这个作品 ID 是不是已经被另一条记录占着（例如 /data 手动回填先建过一条）
    const owner = await prisma.publishRecord.findUnique({
      where: { accountId_platformItemId: { accountId, platformItemId } },
      select: { id: true },
    });
    if (!owner && prior) {
      // 补链接：落在原来那条骨架上，不另起一条
      await prisma.publishRecord.update({
        where: { id: prior.id },
        data: { ...common, platformItemId, needsBackfill: false },
      });
    } else {
      await prisma.publishRecord.upsert({
        where: { accountId_platformItemId: { accountId, platformItemId } },
        create: { ...common, accountId, platform: draft.platform, platformItemId, needsBackfill: false },
        // 补上登记侧才有的正文/标题/选题归因并解除缺链接标记；不动已回填的 metrics。
        update: { ...common, needsBackfill: false },
      });
      // 骨架与真记录并存 = 同一篇算两次。骨架没有作品 ID，自动回流本来也用不上它。
      if (prior && owner && prior.id !== owner.id && prior.platformItemId === null) {
        await prisma.publishRecord.delete({ where: { id: prior.id } }).catch(() => {});
      }
    }
  } else if (prior) {
    // 重复登记 / 重复回执，两次都没有链接：更新那一条，别再堆一条一模一样的
    await prisma.publishRecord.update({
      where: { id: prior.id },
      data: { ...common, needsBackfill: true },
    });
  } else {
    await prisma.publishRecord.create({
      data: { ...common, accountId, platform: draft.platform, platformItemId: null, needsBackfill },
    });
  }

  await prisma.draft.update({ where: { id: draft.id }, data: { status: 'published' } });
  if (draft.topicId) {
    await prisma.topicIdea.update({ where: { id: draft.topicId }, data: { state: 'published' } }).catch(() => {});
  }
  // 记忆学习：发布即形成偏好/绩效信号，反哺后续推荐与语义召回。
  // **只在第一次落这条记录时写**：writeMemory 对同内容是累加 hitCount 的，而 hitCount≥2
  // 就会把这条记忆激活进 prompt。重复登记（先没链接、后补链接）本来就是同一次发布，
  // 让它把 hitCount 顶过激活线 = 把一次操作伪装成「被反复验证过的结论」。
  if (isFirstRecord) {
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
  }

  return { platformItemId, warnings };
}
