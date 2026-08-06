import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { invalidateDfaCache } from '@/lib/compliance/engine';

// 编辑器内联标注的数据来源：actCoachDiagnose 现在把敏感词命中也一并返回。
// 这里守的是**偏移口径**——命中位置必须相对「调用方传进来的那个字符串」，
// 而不是内部 trim 过的 body。差一个前导换行，色块就会盖在隔壁的词上，
// 而且是那种「看起来像随机偏移」、极难从截图里定位的 bug。

const session = { memberId: 'm1', tenantId: 't1', workspaceId: 'w1', accountId: 'a1', memberName: '张三', role: 'owner', plan: 'pro' };
vi.mock('@/lib/session', () => ({ getSession: async () => session, getSessionOrNull: async () => session }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

beforeEach(async () => {
  await prisma.tenant.upsert({ where: { id: 't1' }, create: { id: 't1', name: '测试租户', plan: 'pro' }, update: {} });
  await prisma.workspace.upsert({ where: { id: 'w1' }, create: { id: 'w1', tenantId: 't1', name: '主工作区' }, update: {} });
  await prisma.creatorAccount.upsert({
    where: { id: 'a1' },
    create: { id: 'a1', workspaceId: 'w1', name: '测试账号', platform: 'douyin' },
    update: {},
  });
  await prisma.sensitiveWord.deleteMany({ where: { word: '国家级测试词' } });
  await prisma.sensitiveWord.create({
    data: { word: '国家级测试词', tier: 'legal', action: 'block', enabled: true, suggestion: '（换个说法）' },
  });
  invalidateDfaCache(); // 词库写入后必须立刻失效，否则本用例读到的是上一个文件建的树
});

// 至少 30 字才会触发前端诊断；这里也用足够长的正文，避免和长度相关的分支纠缠
const TAIL = '我们做这件事已经很久了，今天想把过程完整讲一遍，希望对你有点用处，看完可以留言聊聊。';

describe('actCoachDiagnose · 内联标注的偏移口径', () => {
  it('返回敏感词命中，且 start/end 能直接在传入的原文上切出那个词', async () => {
    const { actCoachDiagnose } = await import('@/app/(app)/studio/actions');
    const text = `这是一个国家级测试词的例子。${TAIL}`;
    const r = await actCoachDiagnose(text, 'douyin');
    expect('error' in r).toBe(false);
    if ('error' in r) return;

    const hit = r.compliance.hits.find((h) => h.word === '国家级测试词');
    expect(hit).toBeTruthy();
    expect(text.slice(hit!.start, hit!.end)).toBe('国家级测试词');
    expect(r.compliance.riskLevel).toBe('block');
  });

  it('正文前面有空行时偏移整体补回来——这是高亮错位的根因', async () => {
    const { actCoachDiagnose } = await import('@/app/(app)/studio/actions');
    const text = `\n\n  这是一个国家级测试词的例子。${TAIL}`;
    const r = await actCoachDiagnose(text, 'douyin');
    if ('error' in r) throw new Error(r.error);

    const hit = r.compliance.hits.find((h) => h.word === '国家级测试词')!;
    // 关键断言：直接用返回的偏移去切**原始 text**，必须正好是那个词
    expect(text.slice(hit.start, hit.end)).toBe('国家级测试词');
  });

  it('套话命中同样按原文口径，两类命中可以画在同一段文字上而不互相错位', async () => {
    const { actCoachDiagnose } = await import('@/app/(app)/studio/actions');
    const text = `\n众所周知，这是一个国家级测试词的例子。${TAIL}`;
    const r = await actCoachDiagnose(text, 'douyin');
    if ('error' in r) throw new Error(r.error);

    for (const h of r.humanize.hits) {
      expect(text.slice(h.start, h.end), `套话「${h.word}」偏移错位`).toBe(h.word);
    }
    for (const h of r.compliance.hits) {
      expect(text.slice(h.start, h.end), `敏感词「${h.word}」偏移错位`).toBe(h.word);
    }
    expect(r.humanize.hits.some((h) => h.word === '众所周知')).toBe(true);
  });

  it('没有前导空白时不做多余位移（lead=0 走原对象，不该悄悄改数）', async () => {
    const { actCoachDiagnose } = await import('@/app/(app)/studio/actions');
    const text = `众所周知，${TAIL}`;
    const r = await actCoachDiagnose(text, 'douyin');
    if ('error' in r) throw new Error(r.error);
    const hit = r.humanize.hits.find((h) => h.word === '众所周知')!;
    expect(hit.start).toBe(0);
  });

  it('干净正文返回空命中与 pass，前端据此不画任何标注', async () => {
    const { actCoachDiagnose } = await import('@/app/(app)/studio/actions');
    const r = await actCoachDiagnose(`上周我把跟了三年的老客户砍了。${TAIL}`, 'douyin');
    if ('error' in r) throw new Error(r.error);
    expect(r.compliance.hits).toEqual([]);
    expect(r.compliance.riskLevel).toBe('pass');
  });
});
