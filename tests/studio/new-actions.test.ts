import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';

// 本轮新增的四个创作工坊入口：自由起稿 / 一键去 AI 味 / 标题矩阵 / 一稿多平台。
// 与 studio-shard.test.ts 同款打桩：session 固定、真 SQLite、LLM 走 Mock provider（无 key 即 Mock）。

const session = { memberId: 'm1', tenantId: 't1', workspaceId: 'w1', accountId: 'a1', memberName: '张三', role: 'owner', plan: 'pro' };
vi.mock('@/lib/session', () => ({ getSession: async () => session, getSessionOrNull: async () => session }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

async function base() {
  await prisma.tenant.upsert({ where: { id: 't1' }, create: { id: 't1', name: '测试租户', plan: 'pro' }, update: {} });
  await prisma.workspace.upsert({ where: { id: 'w1' }, create: { id: 'w1', tenantId: 't1', name: '主工作区' }, update: {} });
  await prisma.creatorAccount.upsert({
    where: { id: 'a1' },
    create: { id: 'a1', workspaceId: 'w1', name: '测试账号', platform: 'douyin' },
    update: {},
  });
}

beforeEach(async () => {
  session.role = 'owner';
  await base();
  await prisma.draftVersion.deleteMany({ where: { draft: { accountId: 'a1' } } });
  await prisma.draft.deleteMany({ where: { accountId: 'a1' } });
  await prisma.material.deleteMany({ where: { accountId: 'a1' } });
});

const MY_TEXT = [
  '上周我把跟了三年的老客户砍了。',
  '不是吵架，是算了笔账——他一年给的钱，抵不上我为他熬的那些夜。',
  '砍完那天晚上我睡得特别好。',
  '现在只留五个。收入没掉，反而涨了。',
].join('\n');

describe('自由起稿（选题之外的入口）', () => {
  it('粘一段我写的：建 topicless 草稿，第一版记为 human（绝不能记成 ai，否则污染偏好学习）', async () => {
    const { actCreateDraft } = await import('@/app/(app)/studio/actions');
    const r = await actCreateDraft({ mode: 'paste', platform: 'xiaohongshu', text: MY_TEXT });
    expect(r.ok).toBe(true);
    const draft = await prisma.draft.findUnique({ where: { id: r.draftId! }, include: { versions: true } });
    expect(draft!.topicId).toBeNull();
    expect(draft!.platform).toBe('xiaohongshu');
    expect(draft!.versions).toHaveLength(1);
    expect(draft!.versions[0].authorType).toBe('human');
    expect(draft!.versions[0].content).toBe(MY_TEXT);
    expect(draft!.title).toBe('上周我把跟了三年的老客户砍了。'); // 没填标题 → 取正文首行
  });

  it('粘进来的原稿立刻成为风格样本（这条路顺带解决冷启动没样本的问题）', async () => {
    const { actCreateDraft } = await import('@/app/(app)/studio/actions');
    const { loadExemplars } = await import('@/lib/account-context');
    expect(await loadExemplars('a1', 'xiaohongshu')).toEqual([]);
    await actCreateDraft({ mode: 'paste', platform: 'xiaohongshu', text: MY_TEXT.repeat(2) });
    const ex = await loadExemplars('a1', 'xiaohongshu');
    expect(ex).toHaveLength(1);
    expect(ex[0].source).toBe('human_draft');
  });

  it('空白稿只建壳、不建版本', async () => {
    const { actCreateDraft } = await import('@/app/(app)/studio/actions');
    const r = await actCreateDraft({ mode: 'blank', title: '先占个位', platform: 'wechat' });
    expect(r.ok).toBe(true);
    const versions = await prisma.draftVersion.count({ where: { draftId: r.draftId! } });
    expect(versions).toBe(0);
  });

  it('一句话想法：建壳并落一版 AI 初稿，Mock 时如实标 mocked', async () => {
    const { actCreateDraft } = await import('@/app/(app)/studio/actions');
    const r = await actCreateDraft({ mode: 'idea', platform: 'douyin', text: '想聊聊我为什么把老客户砍了' });
    expect(r.ok).toBe(true);
    expect(r.mocked).toBe(true);
    const draft = await prisma.draft.findUnique({ where: { id: r.draftId! }, include: { versions: true } });
    expect(draft!.versions[0].authorType).toBe('ai');
    expect(draft!.versions[0].content.length).toBeGreaterThan(0);
  });

  it('粘稿/想法模式没给内容 → 人话报错，不建空草稿', async () => {
    const { actCreateDraft } = await import('@/app/(app)/studio/actions');
    expect((await actCreateDraft({ mode: 'paste', text: '   ' })).ok).toBe(false);
    expect((await actCreateDraft({ mode: 'idea', text: '' })).ok).toBe(false);
    expect(await prisma.draft.count({ where: { accountId: 'a1' } })).toBe(0);
  });

  it('viewer 不能起稿', async () => {
    const { actCreateDraft } = await import('@/app/(app)/studio/actions');
    session.role = 'viewer';
    await expect(actCreateDraft({ mode: 'blank' })).rejects.toThrow();
  });
});

describe('一键去 AI 味', () => {
  it('给出前后人味分与合规结果；没有原句样本时如实说明', async () => {
    const { actDeflavor } = await import('@/app/(app)/studio/actions');
    const aiText = '在这个信息爆炸的时代，值得注意的是，我们需要系统性地建立闭环。综上所述，希望这篇文章对你有帮助。'.repeat(2);
    const r = await actDeflavor(aiText, 'wechat');
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.before.hits.length).toBeGreaterThan(0);
    expect(r.hasExemplar).toBe(false); // 没样本必须说出来，不能让用户以为它照着自己写了
    expect(r.compliance.platform).toBe('wechat');
    expect(r.rewritten.length).toBeGreaterThan(0);
  });

  it('有文风样本时 hasExemplar=true', async () => {
    const { actDeflavor } = await import('@/app/(app)/studio/actions');
    await prisma.material.create({ data: { accountId: 'a1', type: 'sample', content: MY_TEXT.repeat(2), tags: '[]' } });
    const r = await actDeflavor('一段需要去味的正文，长度随意。', 'wechat');
    if ('error' in r) throw new Error(r.error);
    expect(r.hasExemplar).toBe(true);
  });

  it('空正文直接拒绝，不浪费一次调用', async () => {
    const { actDeflavor } = await import('@/app/(app)/studio/actions');
    expect(await actDeflavor('  ', 'douyin')).toEqual({ error: '请先输入要处理的正文' });
  });
});

describe('标题矩阵', () => {
  it('Mock 模型给不出可用标题时如实报「演示模式」，绝不编一组假标题', async () => {
    const { actCreateDraft, actTitleMatrix } = await import('@/app/(app)/studio/actions');
    const d = await actCreateDraft({ mode: 'paste', platform: 'xiaohongshu', text: MY_TEXT });
    const r = await actTitleMatrix(d.draftId!);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('演示模式');
  });

  it('空稿不给起标题', async () => {
    const { actCreateDraft, actTitleMatrix } = await import('@/app/(app)/studio/actions');
    const d = await actCreateDraft({ mode: 'blank', title: '空的' });
    const r = await actTitleMatrix(d.draftId!);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('还没有正文');
  });

  it('采纳标题只改标题，不动正文', async () => {
    const { actCreateDraft, actAdoptTitle } = await import('@/app/(app)/studio/actions');
    const d = await actCreateDraft({ mode: 'paste', platform: 'wechat', text: MY_TEXT });
    expect(await actAdoptTitle(d.draftId!, '砍掉3个老客户后，我的收入涨了')).toEqual({ ok: true });
    const draft = await prisma.draft.findUnique({ where: { id: d.draftId! }, include: { versions: true } });
    expect(draft!.title).toBe('砍掉3个老客户后，我的收入涨了');
    expect(draft!.versions[0].content).toBe(MY_TEXT);
  });
});

describe('一稿多平台派生', () => {
  it('每个目标平台建一份独立草稿并认亲（parentDraftId 指向原稿）', async () => {
    const { actCreateDraft, actDeriveToPlatform } = await import('@/app/(app)/studio/actions');
    const { draftFamily } = await import('@/lib/studio/family');
    const d = await actCreateDraft({ mode: 'paste', platform: 'douyin', text: MY_TEXT });
    const r = await actDeriveToPlatform(d.draftId!, ['xiaohongshu', 'wechat']);
    expect(r.ok).toBe(true);
    expect(r.created).toHaveLength(2);
    const fam = await draftFamily('a1', d.draftId!);
    expect(fam.map((m) => m.platform).sort()).toEqual(['douyin', 'wechat', 'xiaohongshu']);
    // 派生稿的首版是 ai，且写明来源版本
    const child = await prisma.draft.findFirst({ where: { parentDraftId: d.draftId! }, include: { versions: true } });
    expect(child!.versions[0].authorType).toBe('ai');
    expect(child!.versions[0].diffFromPrev).toContain('派生');
  });

  it('已经有同源版本的平台跳过，不重复建（否则跨平台对比会出现两条同平台记录）', async () => {
    const { actCreateDraft, actDeriveToPlatform } = await import('@/app/(app)/studio/actions');
    const d = await actCreateDraft({ mode: 'paste', platform: 'douyin', text: MY_TEXT });
    await actDeriveToPlatform(d.draftId!, ['wechat']);
    const again = await actDeriveToPlatform(d.draftId!, ['wechat']);
    expect(again.ok).toBe(false);
    expect(again.error).toContain('已经有同源');
    expect(await prisma.draft.count({ where: { parentDraftId: d.draftId!, platform: 'wechat' } })).toBe(1);
  });

  it('一次最多 3 个平台（每个都是一次真实调用，不做无声批量）', async () => {
    const { actCreateDraft, actDeriveToPlatform } = await import('@/app/(app)/studio/actions');
    const d = await actCreateDraft({ mode: 'paste', platform: 'douyin', text: MY_TEXT });
    const r = await actDeriveToPlatform(d.draftId!, ['xiaohongshu', 'wechat', 'bilibili', 'zhihu', 'x']);
    expect(r.created).toHaveLength(3);
  });

  it('从派生稿再派生：仍挂在同一个家族根下，不长成链', async () => {
    const { actCreateDraft, actDeriveToPlatform } = await import('@/app/(app)/studio/actions');
    const d = await actCreateDraft({ mode: 'paste', platform: 'douyin', text: MY_TEXT });
    const first = await actDeriveToPlatform(d.draftId!, ['wechat']);
    const childId = first.created![0].draftId;
    await actDeriveToPlatform(childId, ['bilibili']);
    const grand = await prisma.draft.findFirst({ where: { platform: 'bilibili', accountId: 'a1' } });
    expect(grand!.parentDraftId).toBe(d.draftId); // 挂到根，不是挂到 childId
  });

  it('空稿 / 没选平台 → 人话报错', async () => {
    const { actCreateDraft, actDeriveToPlatform } = await import('@/app/(app)/studio/actions');
    const empty = await actCreateDraft({ mode: 'blank' });
    expect((await actDeriveToPlatform(empty.draftId!, ['wechat'])).ok).toBe(false);
    const d = await actCreateDraft({ mode: 'paste', platform: 'douyin', text: MY_TEXT });
    expect((await actDeriveToPlatform(d.draftId!, [])).ok).toBe(false);
  });
});

describe('深度模式（两段式）', () => {
  it('idea + deep：跑两段，落一版成稿，diff 说明写明是两段式', async () => {
    const { actCreateDraft } = await import('@/app/(app)/studio/actions');
    const r = await actCreateDraft({ mode: 'idea', platform: 'douyin', text: '想聊聊我为什么把老客户砍了', deep: true });
    expect(r.ok).toBe(true);
    expect(r.stages).toBe(2);
    const draft = await prisma.draft.findUnique({ where: { id: r.draftId! }, include: { versions: true } });
    expect(draft!.versions).toHaveLength(1); // 大纲不单独占一版，只有成稿落库
    expect(draft!.versions[0].diffFromPrev).toContain('两段式');
  });

  it('不勾深度模式就是一次调用（stages=1），默认不替用户花两份额度', async () => {
    const { actCreateDraft } = await import('@/app/(app)/studio/actions');
    const r = await actCreateDraft({ mode: 'idea', platform: 'douyin', text: '一个想法' });
    expect(r.stages).toBe(1);
  });

  it('actDraft 深度模式：基于选题两段式生成', async () => {
    const { actDraft } = await import('@/app/(app)/studio/actions');
    const topic = await prisma.topicIdea.create({
      data: { accountId: 'a1', title: '砍掉老客户之后', angle: '算账视角', state: 'accepted' },
    });
    const r = await actDraft(null, { deep: true });
    expect(r.ok).toBe(true);
    expect(r.stages).toBe(2);
    const versions = await prisma.draftVersion.findMany({ where: { draft: { topicId: topic.id } } });
    expect(versions[0].diffFromPrev).toContain('深度模式');
    await prisma.topicIdea.delete({ where: { id: topic.id } }).catch(() => {});
  });
});
