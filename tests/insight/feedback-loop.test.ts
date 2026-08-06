import { describe, it, expect, beforeAll } from 'vitest';
import { prisma } from '@/lib/db';
import {
  learnFromPerformance,
  learnFromAbandonedDrafts,
  angleTrackRecordBlock,
  REVIEW_MARK,
} from '@/lib/insight/learn';
import { toJson } from '@/lib/json';

// 方案二期（回流）：P1-3 表现回写选题 / W-5 数据校准人物战绩 / W-4 搁置草稿信号。
// 这三条以前全是断的——数据只往前流，不回头。这里锁的就是「回头那一段」。

let workspaceId = '';
let accountId = '';

// 建一条基线：同平台 4 篇均 1000 播放（MIN_PEERS=3，够下结论）
async function seedBaseline(views = 1000, n = 4) {
  for (let i = 0; i < n; i++) {
    await prisma.publishRecord.create({
      data: {
        accountId,
        platform: 'douyin',
        title: `基线${i}`,
        metrics: toJson({ views, likes: 10 }),
        publishedAt: new Date(Date.now() - (i + 5) * 86400000),
      },
    });
  }
}

beforeAll(async () => {
  const tenant = await prisma.tenant.create({ data: { name: 'loop-test' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'ws' } });
  const account = await prisma.creatorAccount.create({
    data: {
      workspaceId: ws.id,
      name: 'a',
      platform: 'douyin',
      personaCard: JSON.stringify({ identity: '健身教练', niche: '健身', canDo: [], cantDo: [], platforms: ['douyin'] }),
    },
  });
  workspaceId = ws.id;
  accountId = account.id;
  await seedBaseline();
});

describe('P1-3 发布表现回写选题（激活 reviewed）', () => {
  it('回流后选题落 reviewed，rationale 带复盘段且含真实倍率', async () => {
    const topic = await prisma.topicIdea.create({
      data: { accountId, title: '深蹲教学', angle: '反常识切入', rationale: '精排原文', state: 'drafting' },
    });
    const rec = await prisma.publishRecord.create({
      data: { accountId, topicId: topic.id, platform: 'douyin', title: '深蹲教学', metrics: toJson({ views: 3000 }) },
    });

    await learnFromPerformance(accountId, workspaceId, rec.id);

    const after = await prisma.topicIdea.findUnique({ where: { id: topic.id } });
    expect(after?.state).toBe('reviewed');
    expect(after?.rationale).toContain('精排原文'); // 原文保留
    expect(after?.rationale).toContain(REVIEW_MARK);
    expect(after?.rationale).toContain('300%'); // 3000 / 1000
    expect(after?.rationale).toContain('跑赢');
  });

  it('多次回流只保留一段复盘（不把 rationale 撑成流水账），且结论随新数据翻案', async () => {
    const topic = await prisma.topicIdea.create({
      data: { accountId, title: '拉伸误区', angle: '误区盘点', rationale: '精排原文', state: 'accepted' },
    });
    const rec = await prisma.publishRecord.create({
      data: { accountId, topicId: topic.id, platform: 'douyin', title: '拉伸误区', metrics: toJson({ views: 200 }) },
    });
    await learnFromPerformance(accountId, workspaceId, rec.id); // T+48h：跑输

    // T+7d 长尾起来了，同一条记录数据被更新后再回流
    await prisma.publishRecord.update({ where: { id: rec.id }, data: { metrics: toJson({ views: 4000 }) } });
    await learnFromPerformance(accountId, workspaceId, rec.id);

    const after = await prisma.topicIdea.findUnique({ where: { id: topic.id } });
    const marks = after!.rationale!.split(REVIEW_MARK).length - 1;
    expect(marks).toBe(1); // 只有一段
    expect(after?.rationale).toContain('跑赢'); // 新结论覆盖旧结论
    expect(after?.rationale).not.toContain('跑输');
    expect(after?.rationale?.startsWith('精排原文')).toBe(true);
  });

  it('用户否决过的选题不被数据翻案成 reviewed', async () => {
    const topic = await prisma.topicIdea.create({
      data: { accountId, title: '被否决的', angle: 'x', state: 'rejected', rejectReason: '不想做' },
    });
    const rec = await prisma.publishRecord.create({
      data: { accountId, topicId: topic.id, platform: 'douyin', title: '被否决的', metrics: toJson({ views: 9000 }) },
    });
    await learnFromPerformance(accountId, workspaceId, rec.id);
    const after = await prisma.topicIdea.findUnique({ where: { id: topic.id } });
    expect(after?.state).toBe('rejected');
    expect(after?.rationale ?? '').not.toContain(REVIEW_MARK);
  });
});

describe('P1-3 消费端：切入角历史战绩块', () => {
  it('单篇不下结论，同一切入角满 2 篇才进块，并给出相对基线的百分比', async () => {
    const t1 = await prisma.topicIdea.create({
      data: { accountId, title: '打卡挑战1', angle: '30天打卡挑战', state: 'published' },
    });
    await prisma.publishRecord.create({
      data: { accountId, topicId: t1.id, platform: 'douyin', title: '挑战1', metrics: toJson({ views: 2000 }) },
    });
    const only1 = await angleTrackRecordBlock(accountId);
    expect(only1).not.toContain('30天打卡挑战');

    const t2 = await prisma.topicIdea.create({
      data: { accountId, title: '打卡挑战2', angle: '30天打卡挑战', state: 'published' },
    });
    await prisma.publishRecord.create({
      data: { accountId, topicId: t2.id, platform: 'douyin', title: '挑战2', metrics: toJson({ views: 2000 }) },
    });
    const block = await angleTrackRecordBlock(accountId);
    expect(block).toContain('30天打卡挑战');
    expect(block).toContain('2 篇');
    expect(block).toMatch(/\d+%/);
  });

  it('账号没有任何发布归因时返回空串（不喂占位噪声）', async () => {
    const other = await prisma.creatorAccount.create({
      data: { workspaceId, name: 'empty', platform: 'douyin' },
    });
    expect(await angleTrackRecordBlock(other.id)).toBe('');
  });
});

describe('W-5 发布数据校准智囊团人物战绩', () => {
  async function seedAdvisorTopic(views: number, title: string) {
    const session = await prisma.advisorSession.create({ data: { accountId, trigger: 'manual', status: 'done' } });
    const opinion = await prisma.advisorOpinion.create({
      data: {
        sessionId: session.id,
        personaKey: 'expert_data_analyst',
        personaName: '数据分析师',
        personaRole: 'expert',
        stance: '只看数据',
        suggestion: '做一期训练数据复盘',
        adopted: true,
      },
    });
    // 人物 key 必须与 opinion.personaKey 对得上才校准得到；账号级唯一，多次调用复用同一行
    const persona = await prisma.advisorPersona.upsert({
      where: { accountId_key: { accountId, key: 'expert_data_analyst' } },
      update: {},
      create: {
        accountId,
        key: 'expert_data_analyst',
        name: '数据分析师',
        role: 'expert',
        stance: '只看数据',
        adoptedCount: 1,
      },
    });
    const topic = await prisma.topicIdea.create({
      data: { accountId, title, angle: '数据复盘', state: 'published', sourceType: 'advisor', sourceRef: opinion.id },
    });
    const rec = await prisma.publishRecord.create({
      data: { accountId, topicId: topic.id, platform: 'douyin', title, metrics: toJson({ views }) },
    });
    return { persona, rec };
  }

  it('提案发布跑赢基线 → 人物 learnedNotes 记 data_proven 且权重上调', async () => {
    const { persona, rec } = await seedAdvisorTopic(5000, '数据复盘篇');
    const before = await prisma.advisorPersona.findUnique({ where: { id: persona.id } });

    await learnFromPerformance(accountId, workspaceId, rec.id);

    const after = await prisma.advisorPersona.findUnique({ where: { id: persona.id } });
    const notes = JSON.parse(after!.learnedNotes) as { verdict: string; text: string }[];
    expect(notes.some((n) => n.verdict === 'data_proven')).toBe(true);
    expect(notes[notes.length - 1].text).toContain('跑赢账号基线');
    expect(after!.weight).toBeGreaterThan(before!.weight);
  });

  it('同一篇多次回流不堆重复条目，翻案时替换旧结论', async () => {
    const { persona, rec } = await seedAdvisorTopic(200, '低走篇');
    await learnFromPerformance(accountId, workspaceId, rec.id); // 跑输
    await prisma.publishRecord.update({ where: { id: rec.id }, data: { metrics: toJson({ views: 6000 }) } });
    await learnFromPerformance(accountId, workspaceId, rec.id); // 长尾跑赢

    const after = await prisma.advisorPersona.findUnique({ where: { id: persona.id } });
    const notes = (JSON.parse(after!.learnedNotes) as { verdict: string; text: string }[]).filter((n) =>
      n.text.includes('《低走篇》'),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0].verdict).toBe('data_proven');
  });

  it('非 advisor 来源的选题不碰任何人物战绩', async () => {
    const persona = await prisma.advisorPersona.findFirst({ where: { accountId, key: 'expert_data_analyst' } });
    const before = persona!.learnedNotes;
    const topic = await prisma.topicIdea.create({
      data: { accountId, title: '热点来源', angle: 'x', state: 'published', sourceType: 'hot', sourceRef: 'hot-1' },
    });
    const rec = await prisma.publishRecord.create({
      data: { accountId, topicId: topic.id, platform: 'douyin', title: '热点来源', metrics: toJson({ views: 8000 }) },
    });
    await learnFromPerformance(accountId, workspaceId, rec.id);
    const after = await prisma.advisorPersona.findFirst({ where: { accountId, key: 'expert_data_analyst' } });
    expect(after!.learnedNotes).toBe(before);
  });
});

describe('W-4 搁置草稿 → 切入角落地难', () => {
  const old = new Date(Date.now() - 30 * 86400000);

  it('长期未完成且账号已转做别的 → 标记 abandoned 并写入落地难偏好', async () => {
    const topic = await prisma.topicIdea.create({
      data: { accountId, title: '硬核解剖长文', angle: '解剖学硬核长文', state: 'drafting' },
    });
    const draft = await prisma.draft.create({
      data: { accountId, topicId: topic.id, title: '硬核解剖长文', platform: 'douyin', status: 'editing' },
    });
    await prisma.draft.update({ where: { id: draft.id }, data: { updatedAt: old } });
    // 「转做别的」的证据：这之后有新发布（基线数据的 publishedAt 都比 old 新）

    const r = await learnFromAbandonedDrafts(workspaceId);
    expect(r.marked).toBeGreaterThanOrEqual(1);

    const after = await prisma.draft.findUnique({ where: { id: draft.id } });
    expect(after?.status).toBe('abandoned');
    const mem = await prisma.memoryEntry.findFirst({
      where: { accountId, type: 'preference', content: { contains: '解剖学硬核长文' } },
    });
    expect(mem?.content).toContain('落地难');
  });

  it('第二次跑不再重复计入（已标记 abandoned，不刷 hitCount）', async () => {
    const r = await learnFromAbandonedDrafts(workspaceId);
    expect(r.marked).toBe(0);
  });

  it('账号整体停更（这之后没做任何别的）时不归咎于切入角', async () => {
    const quiet = await prisma.creatorAccount.create({
      data: { workspaceId, name: 'quiet', platform: 'douyin' },
    });
    const topic = await prisma.topicIdea.create({
      data: { accountId: quiet.id, title: '停更选题', angle: '停更切入角', state: 'drafting' },
    });
    const draft = await prisma.draft.create({
      data: { accountId: quiet.id, topicId: topic.id, title: '停更选题', platform: 'douyin', status: 'editing' },
    });
    await prisma.draft.update({ where: { id: draft.id }, data: { updatedAt: old } });

    await learnFromAbandonedDrafts(workspaceId);

    const after = await prisma.draft.findUnique({ where: { id: draft.id } });
    expect(after?.status).toBe('editing'); // 未标记
    const mem = await prisma.memoryEntry.findFirst({
      where: { accountId: quiet.id, content: { contains: '停更切入角' } },
    });
    expect(mem).toBeNull();
  });
});
