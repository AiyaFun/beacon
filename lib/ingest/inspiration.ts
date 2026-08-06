import { z } from 'zod';
import { prisma } from '../db';
import { toJson } from '../json';
import { PLATFORMS } from '../constants';

// 灵感收集箱 · 插件回传入口的数据契约与入库逻辑。
//
// 【与竞对/自有回传的关键区别：这里收的是「用户主动标记的一条内容」，不是批量抓取】
// 所以没有 posts 数组、没有指标、没有 handle——它就是一条书签 + 一句备注。
// 权限面因此比另外两条通道更小：不写任何全局共享表，只往调用方工作区自己的收集箱里加一行。
//
// 【关于正文】原口径是「只存标题/链接/备注，不存正文」（正文是搬运）。
// 2026-07-29 按需求放开：插件可以带 content 回传，落成「资讯库」条目（source='clip'），
// 用途限定为**用户自己的学习与分析**。放开的前提是三条护栏同时在（详见 lib/clip/index.ts 顶部）：
// 只落自己工作区 / 绝不进生成语料池（有 🔒 测试钉死）/ 页面与回执标注来源与「别直接复用其文字」。
// 没有 content 的老通道行为完全不变。

// 一个工作区最多留这么多条待用灵感。超了不是报错，是**先挤掉最老的**——
// 收集箱是个流动的暂存区，不是永久档案；无上限增长只会让它变成没人看的垃圾堆。
export const INSPIRATION_CAP = 200;

export const inspirationPayloadSchema = z.object({
  title: z.string().trim().min(1, '标题不能为空').max(200),
  note: z.string().trim().max(300).optional(),
  url: z.string().url().max(500).optional(),
  // 平台可空：手动录入或插件在未知站点上都可能给不出
  platform: z
    .string()
    .max(32)
    .optional()
    .refine((p) => p == null || p in PLATFORMS, { message: '未知平台' }),
  author: z.string().trim().max(100).optional(),
  tags: z.array(z.string().trim().min(1).max(24)).max(8).optional(),
  // plugin 插件一键收藏 | manual 网页手动记
  // comment 从**自有**作品评论里挖出来的读者提问
  // rival-comment 从**同行**作品评论里挖出来的提问（用户手动粘贴，见下）
  //
  // 为什么把自有和同行分成两个值：两者的解读方式不同。自有评论里的问题是「我的读者想要什么」，
  // 同行评论里的问题是「这个赛道里没被满足的需求」——后者要额外判断「他们的读者是不是我的读者」。
  // 混成一个值，用户在收集箱里就分不清哪条该直接做、哪条要先掂量。
  source: z.enum(['plugin', 'manual', 'comment', 'rival-comment', 'clip']).optional().default('plugin'),
  // 插件在浏览器里读到的正文。给了它就走资讯库通道（抓正文→摘要→要点→对本账号的用处）。
  // 上限与 lib/clip 的 MAX_STORE_CHARS 一致；超出由插件侧截断，这里再兜一道。
  content: z.string().max(20_000).optional(),
});

export type InspirationPayload = z.infer<typeof inspirationPayloadSchema>;

export type IngestInspirationResult =
  | { ok: true; id: string; duplicate: boolean; total: number }
  | { ok: false; error: string };

// 入库。同工作区内 URL 相同视为同一条（重复收藏不新增，只更新备注/标签）——
// 用户在同一条内容上点第二次，意思几乎总是「补一句备注」，而不是「我要两条」。
export async function ingestInspiration(
  workspaceId: string,
  payload: InspirationPayload,
  accountId?: string | null,
): Promise<IngestInspirationResult> {
  // 带正文 = 资讯库入库：交给 lib/clip 走「摘要 + 要点 + 对本账号的用处」那条管线，
  // 而不是在这里再写一份。摘要失败也照存正文（clip 内部已兜底）。
  if (payload.content && payload.content.trim().length >= 120) {
    const { clipCaptured } = await import('../clip');
    const r = await clipCaptured({
      workspaceId,
      accountId,
      title: payload.title,
      url: payload.url ?? null,
      author: payload.author ?? null,
      platform: payload.platform ?? null,
      text: payload.content,
      note: payload.note,
    });
    if (!r.ok) return { ok: false, error: r.error };
    const total = await prisma.inspirationItem.count({ where: { workspaceId, state: 'open' } });
    return { ok: true, id: r.id, duplicate: r.duplicate, total };
  }

  const tags = payload.tags?.filter(Boolean) ?? [];

  // 读者提问没有 URL，去重只能靠标题：同一个问题下次再挖到时不该又存一条。
  // 与 URL 去重同一个道理——重复入库只会让收集箱被同一个问题刷屏。
  // 自有与同行分开去重：同一个问题在两边都被问到是**有信息量的**（说明是赛道级需求），不该被合并掉。
  if (!payload.url && (payload.source === 'comment' || payload.source === 'rival-comment')) {
    const dup = await prisma.inspirationItem.findFirst({
      where: { workspaceId, source: payload.source, title: payload.title },
      select: { id: true },
    });
    if (dup) {
      await prisma.inspirationItem.update({
        where: { id: dup.id },
        // 备注里带着「被问到 N 次」，重挖时这个数会变，覆盖成最新的
        data: { ...(payload.note ? { note: payload.note } : {}), state: 'open' },
      });
      const total = await prisma.inspirationItem.count({ where: { workspaceId, state: 'open' } });
      return { ok: true, id: dup.id, duplicate: true, total };
    }
  }

  if (payload.url) {
    const existing = await prisma.inspirationItem.findFirst({
      where: { workspaceId, url: payload.url },
      select: { id: true, note: true, tags: true },
    });
    if (existing) {
      await prisma.inspirationItem.update({
        where: { id: existing.id },
        data: {
          // 空备注不覆盖已有备注：第二次收藏没写备注，不代表要把第一次写的删掉
          ...(payload.note ? { note: payload.note } : {}),
          ...(tags.length ? { tags: toJson(tags) } : {}),
          // 已归档的重新收藏 = 用户又想起它了，放回待用
          state: 'open',
        },
      });
      const total = await prisma.inspirationItem.count({ where: { workspaceId, state: 'open' } });
      return { ok: true, id: existing.id, duplicate: true, total };
    }
  }

  const created = await prisma.inspirationItem.create({
    data: {
      workspaceId,
      accountId: accountId ?? null,
      title: payload.title,
      note: payload.note,
      url: payload.url,
      platform: payload.platform,
      author: payload.author,
      source: payload.source,
      tags: toJson(tags),
    },
    select: { id: true },
  });

  await pruneInspiration(workspaceId);
  const total = await prisma.inspirationItem.count({ where: { workspaceId, state: 'open' } });
  return { ok: true, id: created.id, duplicate: false, total };
}

// 评论提问独立配额，与灵感互不吃额度
export const COMMENT_CAP = 60;

// 超出上限时挤掉最老的待用条目（已转成选题的 used 与用户主动归档的 archived 不动——
// 那两类是有结论的记录，删掉等于抹掉用户的操作痕迹）。
// 灵感和评论分池挤出：不分的话评论会把用户手记的灵感物理删除。
export async function pruneInspiration(workspaceId: string): Promise<number> {
  const [insOverflow, cmtOverflow] = await Promise.all([
    prisma.inspirationItem.findMany({
      where: { workspaceId, state: 'open', source: { notIn: ['comment', 'rival-comment'] } },
      orderBy: { createdAt: 'desc' },
      skip: INSPIRATION_CAP,
      select: { id: true },
    }),
    prisma.inspirationItem.findMany({
      where: { workspaceId, state: 'open', source: { in: ['comment', 'rival-comment'] } },
      // 被反复问到的高价值问题 createdAt 永远停在第一次，按 createdAt 挤会把它们优先淘汰
      orderBy: [{ lastAskedAt: 'desc' }, { createdAt: 'desc' }],
      skip: COMMENT_CAP,
      select: { id: true },
    }),
  ]);
  const ids = [...insOverflow, ...cmtOverflow].map((o) => o.id);
  if (ids.length === 0) return 0;
  await prisma.inspirationItem.deleteMany({ where: { id: { in: ids } } });
  return ids.length;
}
