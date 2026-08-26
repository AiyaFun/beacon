import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { toJson } from '@/lib/json';

// 本周作战的周一推送 nudge：让「本周作战」这一页每周主动露一次面，
// 接在已有的周度复盘推送里（复用它的 cron / 逐账号 / 推送 / 开关，不新增 surface）。
//
// 这里钉两件事：
//   · buildBattleDigest 的取数（有待起稿选题才返回，头一条按分排）；
//   · 周一那张推送卡片**真的**带上了作战一行 + /battle 链接。
// 后者用 spy 抓 pushEvent 的入参——只测 digest 函数不测推送，就守不住「算出来了没接进消息」。

const pushSpy = vi.fn();
vi.mock('@/lib/bot', () => ({
  pushEvent: (...args: unknown[]) => pushSpy(...args),
  beaconUrl: (p: string) => `https://beacon.iyunci.cn${p}`,
}));
vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async () => ({ text: JSON.stringify({ conclusions: ['本周均播上升'], suggestions: ['继续晚间发布'] }), mocked: false, degraded: false }),
}));

const { buildBattleDigest } = await import('@/lib/battle/report');
const { generateWeeklyReview } = await import('@/lib/insight/review');

let tenantId: string, workspaceId: string, accountId: string;

beforeEach(async () => {
  pushSpy.mockClear();
  await prisma.notification.deleteMany();
  await prisma.reviewReport.deleteMany();
  await prisma.publishRecord.deleteMany();
  await prisma.topicIdea.deleteMany();
  await prisma.creatorAccount.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.tenant.deleteMany();
  const tenant = await prisma.tenant.create({ data: { name: 't' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
  const acc = await prisma.creatorAccount.create({ data: { workspaceId: ws.id, name: '木子的家', platform: 'xiaohongshu' } });
  tenantId = tenant.id; workspaceId = ws.id; accountId = acc.id;
});

const publish = (daysAgo: number, views: number) =>
  prisma.publishRecord.create({
    data: { accountId, platform: 'xiaohongshu', platformItemId: 'p' + Math.random(), title: '作品', publishedAt: new Date(Date.now() - daysAgo * 86_400_000), metrics: toJson({ views }) },
  });
const recTopic = (title: string, score: number) =>
  prisma.topicIdea.create({ data: { accountId, title, angle: '角', state: 'recommended', totalScore: score, scores: '{}' } });

describe('buildBattleDigest', () => {
  it('没有 recommended 选题 → null（推送里不追加作战行）', async () => {
    await recTopic('已采纳的不算', 90).then((t) => prisma.topicIdea.update({ where: { id: t.id }, data: { state: 'accepted' } }));
    expect(await buildBattleDigest(accountId)).toBeNull();
  });

  it('有 recommended → 返回条数与最高分那条', async () => {
    await recTopic('低分', 60);
    await recTopic('最高分', 95);
    await recTopic('中分', 80);
    const d = await buildBattleDigest(accountId);
    expect(d).toEqual({ count: 3, topTitle: '最高分' });
  });
});

describe('🔒 周一推送带上本周作战 nudge', () => {
  it('有待起稿选题 → 卡片含作战行，主按钮指向 /battle', async () => {
    await publish(2, 100000); // 本周有发布，周报才会生成并推送
    await recTopic('小户型玄关藏电线', 92);
    await recTopic('租房不打孔挂墙', 88);

    const r = await generateWeeklyReview({ tenantId, accountId, workspaceId });
    expect(r).not.toBeNull();

    expect(pushSpy).toHaveBeenCalledTimes(1);
    const [, event, card] = pushSpy.mock.calls[0] as [string, string, { lines: string[]; link: { text: string; url: string } }];
    expect(event).toBe('review_ready');
    const joined = card.lines.join('\n');
    expect(joined).toContain('本周作战');
    expect(joined).toContain('2 条'); // 条数
    expect(joined).toContain('小户型玄关藏电线'); // 头一条（最高分）
    expect(card.link.url).toContain('/battle'); // 主按钮改成更可行动的作战页
    expect(card.link.text).toContain('本周作战');
  });

  it('🔒 没有待起稿选题 → 不追加作战行，主按钮仍是数据看板', async () => {
    await publish(2, 100000); // 有发布，出周报
    // 没有 recommended 选题
    const r = await generateWeeklyReview({ tenantId, accountId, workspaceId });
    expect(r).not.toBeNull();

    const [, , card] = pushSpy.mock.calls[0] as [string, string, { lines: string[]; link: { text: string; url: string } }];
    expect(card.lines.join('\n')).not.toContain('本周作战');
    expect(card.link.url).toContain('/data');
  });
});
