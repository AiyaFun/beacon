import { describe, it, expect, beforeAll, vi } from 'vitest';

// W-6 草稿会诊：智囊团从「只评选题方向」扩到「评已成稿的正文」。
// 会诊本身要烧 LLM，这里 stub 网关，锁的是链路与红线：材料带正文、落 draftRef、
// 采纳的改稿意见**不进选题池**。
vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: vi.fn(async () => ({
    text: JSON.stringify({ suggestion: '把开头第一句换成结论', rationale: '前三秒抓不住人' }),
    provider: 'real-x',
    model: 'x-1',
    mocked: false,
  })),
}));
vi.mock('@/lib/session', () => ({
  getSession: vi.fn(async () => {
    throw new Error('no session'); // convene 内部 try/catch → tenantId=null，走平台自用记账
  }),
}));

import { prisma } from '@/lib/db';
import { convene } from '@/lib/advisor/panel';
import { llmComplete } from '@/lib/llm/gateway';

let workspaceId = '';
let accountId = '';
let draftId = '';

beforeAll(async () => {
  const tenant = await prisma.tenant.create({ data: { name: 'draft-review-test' } });
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
  // 只留 3 席，控制这条测试的并发发言数
  await prisma.advisorPersona.createMany({
    data: ['expert_data_analyst', 'audience_core_fan', 'expert_contrarian'].map((key) => ({
      accountId,
      key,
      name: key,
      role: key.startsWith('audience') ? 'audience' : 'expert',
      stance: 's',
      focus: '[]',
    })),
  });
  const draft = await prisma.draft.create({
    data: { accountId, title: '深蹲教学初稿', platform: 'douyin', status: 'editing' },
  });
  draftId = draft.id;
  await prisma.draftVersion.create({
    data: { draftId, seq: 1, authorType: 'ai', content: '今天聊聊深蹲。很多人第一步就做错了……' },
  });
});

describe('W-6 草稿会诊', () => {
  it('正文进会诊材料，人物被要求给修改意见而不是新选题', async () => {
    const sessionId = await convene(accountId, workspaceId, '开头留不住人', draftId);
    const session = await prisma.advisorSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.draftRef).toBe(draftId);
    expect(session.trigger).toBe('draft_review');
    expect(session.summary).toContain('深蹲教学初稿');

    const prompt = String(vi.mocked(llmComplete).mock.calls.at(-1)?.[2]?.[1]?.content ?? '');
    expect(prompt).toContain('今天聊聊深蹲'); // 正文确实摆上桌
    expect(prompt).toContain('修改意见');
    expect(prompt).not.toContain('给出 1 条你最想推荐的选题方向');

    const opinions = await prisma.advisorOpinion.count({ where: { sessionId } });
    expect(opinions).toBe(3);
  });

  it('草稿不存在或没有正文时明确报错，不开空会诊', async () => {
    const empty = await prisma.draft.create({
      data: { accountId, title: '空草稿', platform: 'douyin', status: 'editing' },
    });
    await expect(convene(accountId, workspaceId, undefined, empty.id)).rejects.toThrow('先生成一版初稿');
    await expect(convene(accountId, workspaceId, undefined, 'not-exist')).rejects.toThrow();
    const sessions = await prisma.advisorSession.count({ where: { accountId, draftRef: empty.id } });
    expect(sessions).toBe(0);
  });

  it('选题会诊不受影响：draftRef 为 null、议题走原分支', async () => {
    const sessionId = await convene(accountId, workspaceId, '五一蹭什么热点');
    const session = await prisma.advisorSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.draftRef).toBeNull();
    expect(session.trigger).not.toBe('draft_review');
    const prompt = String(vi.mocked(llmComplete).mock.calls.at(-1)?.[2]?.[1]?.content ?? '');
    expect(prompt).toContain('给出 1 条你最想推荐的选题方向');
  });
});
