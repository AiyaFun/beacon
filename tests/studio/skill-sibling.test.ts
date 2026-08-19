import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';

// 技能产出「另存为兄弟稿」。
//
// 修的是一个数据卫生 bug：在公众号稿上跑「知乎长文排版」再点「存为新版本」，
// 会把知乎正文写进公众号稿的版本线——既污染原稿（版本线要拿去学偏好），
// 又让这份产出永远进不了 draftFamily（「同一篇在哪个平台跑赢」里看不到它）。
//
// 打桩与 new-actions.test.ts 同款：session 固定、真 SQLite、不调 LLM
//（这条路径本来就不烧额度，内容是技能已经生成好的）。

const session = { memberId: 'm1', tenantId: 't1', workspaceId: 'w1', accountId: 'a1', memberName: '张三', role: 'owner', plan: 'pro' };
vi.mock('@/lib/session', () => ({ getSession: async () => session, getSessionOrNull: async () => session }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

async function base() {
  await prisma.tenant.upsert({ where: { id: 't1' }, create: { id: 't1', name: '测试租户', plan: 'pro' }, update: {} });
  await prisma.workspace.upsert({ where: { id: 'w1' }, create: { id: 'w1', tenantId: 't1', name: '主工作区' }, update: {} });
  await prisma.creatorAccount.upsert({
    where: { id: 'a1' },
    create: { id: 'a1', workspaceId: 'w1', name: '测试账号', platform: 'wechat' },
    update: {},
  });
}

beforeEach(async () => {
  session.role = 'owner';
  await base();
  await prisma.draftVersion.deleteMany({ where: { draft: { accountId: 'a1' } } });
  await prisma.draft.deleteMany({ where: { accountId: 'a1' } });
});

/** 建一篇公众号稿，带第 1 版正文 */
async function wechatDraft(id = 'd1', parentDraftId?: string) {
  await prisma.draft.create({
    data: { id, accountId: 'a1', title: '公众号原稿', platform: 'wechat', status: 'editing', parentDraftId },
  });
  await prisma.draftVersion.create({
    data: { draftId: id, seq: 1, authorType: 'human', content: '这是公众号原稿的正文。' },
  });
  return id;
}

const ZHIHU_OUT = '这是知乎长文排版技能生成的成品正文。';

describe('技能产出另存为兄弟稿', () => {
  it('跨平台技能：另起一条子稿，原稿的版本线一个字都不动', async () => {
    const { actSkillSaveAsSibling } = await import('@/app/(app)/studio/actions');
    await wechatDraft();

    const r = await actSkillSaveAsSibling('d1', ZHIHU_OUT, '知乎长文排版', 'zhihu');
    expect(r.ok).toBe(true);
    expect(r.platform).toBe('zhihu');

    // 原稿版本线没被动过——这正是这个功能存在的理由
    const origVersions = await prisma.draftVersion.findMany({ where: { draftId: 'd1' }, orderBy: { seq: 'asc' } });
    expect(origVersions).toHaveLength(1);
    expect(origVersions[0].content).toBe('这是公众号原稿的正文。');

    // 子稿：平台是技能的目标平台，认亲认到原稿，正文是技能产出
    const child = await prisma.draft.findUnique({ where: { id: r.draftId! } });
    expect(child?.platform).toBe('zhihu');
    expect(child?.parentDraftId).toBe('d1');
    expect(child?.title).toBe('公众号原稿'); // 同一篇内容的另一个平台版本，标题跟着走
    const childVersions = await prisma.draftVersion.findMany({ where: { draftId: r.draftId! } });
    expect(childVersions).toHaveLength(1);
    expect(childVersions[0].seq).toBe(1); // 子稿从第 1 版开始，不是顺着父稿的 seq
    expect(childVersions[0].content).toBe(ZHIHU_OUT);
  });

  it('在子稿上再跑技能：挂到同一个根，不许变成孙子', async () => {
    // draftFamily 只按 parentDraftId 聚合一层，挂错了这一版就从家族对比里消失
    const { actSkillSaveAsSibling } = await import('@/app/(app)/studio/actions');
    await wechatDraft('root');
    await prisma.draft.create({
      data: { id: 'kid', accountId: 'a1', title: '公众号原稿', platform: 'xiaohongshu', status: 'editing', parentDraftId: 'root' },
    });

    const r = await actSkillSaveAsSibling('kid', ZHIHU_OUT, '知乎长文排版', 'zhihu');
    expect(r.ok).toBe(true);
    const child = await prisma.draft.findUnique({ where: { id: r.draftId! } });
    expect(child?.parentDraftId).toBe('root'); // 不是 'kid'
  });

  it('同平台技能：拒绝，让用户走「存为新版本」', async () => {
    // 平台相同就不存在覆盖问题，再建一条兄弟稿只会让家族里多一条同平台重复稿
    const { actSkillSaveAsSibling } = await import('@/app/(app)/studio/actions');
    await wechatDraft();
    const r = await actSkillSaveAsSibling('d1', ZHIHU_OUT, '公众号排版', 'wechat');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('存为新版本');
    expect(await prisma.draft.count({ where: { accountId: 'a1' } })).toBe(1); // 什么都没建
  });

  it('generic 技能没有目标平台：拒绝，不许拿 generic 当平台键建稿', async () => {
    const { actSkillSaveAsSibling } = await import('@/app/(app)/studio/actions');
    await wechatDraft();
    const r = await actSkillSaveAsSibling('d1', ZHIHU_OUT, '通用润色', 'generic');
    expect(r.ok).toBe(false);
    expect(await prisma.draft.count({ where: { accountId: 'a1' } })).toBe(1);
  });

  it('空内容 / 别人的草稿：都不建稿', async () => {
    const { actSkillSaveAsSibling } = await import('@/app/(app)/studio/actions');
    await wechatDraft();
    expect((await actSkillSaveAsSibling('d1', '   ', '知乎长文排版', 'zhihu')).ok).toBe(false);
    expect((await actSkillSaveAsSibling('不存在的稿', ZHIHU_OUT, '知乎长文排版', 'zhihu')).ok).toBe(false);
    expect(await prisma.draft.count({ where: { accountId: 'a1' } })).toBe(1);
  });

  it('🔒 源码守卫：跨平台时「存为新版本」必须置灰，否则这个 bug 原样复活', async () => {
    // 按钮还在、只是多了一个新按钮的话，用户照样会点旧的那个——修了等于没修。
    const fs = await import('node:fs');
    const src = fs.readFileSync('app/(app)/studio/SkillPanel.tsx', 'utf8');
    const m = src.match(/onClick=\{\(\) => saveVersion\(result\)\}[\s\S]{0,200}?disabled=\{([^}]*)\}/);
    expect(m, '没找到「存为新版本」按钮的 disabled').toBeTruthy();
    expect(m![1]).toContain('crossPlatform');
    // crossPlatform 的判据本身：generic 不算跨平台（它没有目标平台）
    expect(src).toMatch(/crossPlatform\s*=[\s\S]{0,220}?!==\s*'generic'/);
  });
});
