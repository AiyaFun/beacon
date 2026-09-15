import { describe, it, expect, beforeEach } from 'vitest';
import { canAdvance, advanceRequirement, nextStage, WORK_STAGES } from '@/lib/workitem/stages';
import { prisma } from '@/lib/db';
import { createWorkItem, advanceWorkItem, acceptWorkItem, rejectWorkItem, linkWorkItem, getWorkItem, attachRun, syncFromRuns } from '@/lib/workitem/core';

// 内容工单（2026-09-11 P1）：一张工单可回溯选题、草稿、运行、发布；驳回必须有原因；返工不覆盖旧交付。

describe('阶段机（纯函数）', () => {
  it('只许前进一步，不许跳', () => {
    expect(canAdvance('topic', 'drafting')).toBe(true);
    expect(canAdvance('topic', 'review')).toBe(false);
    expect(canAdvance('drafting', 'topic')).toBe(false);
    expect(nextStage('retro')).toBeNull();
    expect(WORK_STAGES[0]).toBe('topic');
  });
  it('进审校要有草稿；已发布要有发布记录', () => {
    expect(advanceRequirement('review').field).toBe('draftId');
    expect(advanceRequirement('published').field).toBe('publishRecordId');
    expect(advanceRequirement('drafting').field).toBeNull();
  });
});

describe('工单流程（落库）', () => {
  let ws: string; let acc: string; let member: string; let draftId: string;
  beforeEach(async () => {
    await prisma.workItemEvent.deleteMany();
    await prisma.contentWorkItem.deleteMany();
    const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
    const w = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
    ws = w.id;
    const m = await prisma.member.create({ data: { tenantId: tenant.id, name: 'me', role: 'owner' } });
    member = m.id;
    const a = await prisma.creatorAccount.create({ data: { workspaceId: ws, name: 'A', platform: 'xiaohongshu', personaCard: '{}' } });
    acc = a.id;
    const d = await prisma.draft.create({ data: { accountId: acc, title: '稿', platform: 'xiaohongshu' } });
    draftId = d.id;
  });

  it('建单 → 起稿 → 挂草稿 → 审校 → 驳回（必须带原因）→ 返工计数 +1 → 再审校 → 验收', async () => {
    const r = await createWorkItem(ws, member, { title: '国庆选题', accountId: acc });
    expect(r.ok).toBe(true);
    const id = (r as { id: string }).id;
    expect((await advanceWorkItem(ws, id, member, 'drafting')).ok).toBe(true);
    // 没草稿进不了审校
    expect((await advanceWorkItem(ws, id, member, 'review')).ok).toBe(false);
    expect((await linkWorkItem(ws, id, member, { kind: 'draft', refId: draftId })).ok).toBe(true);
    expect((await advanceWorkItem(ws, id, member, 'review')).ok).toBe(true);
    // 驳回不带原因被拒
    expect((await rejectWorkItem(ws, id, member, '   ')).ok).toBe(false);
    expect((await rejectWorkItem(ws, id, member, '开头太平')).ok).toBe(true);
    let v = (await getWorkItem(ws, id))!;
    expect(v.stage).toBe('drafting');
    expect(v.reworkCount).toBe(1);
    expect(v.rejectReason).toBe('开头太平');
    // 返工不覆盖旧交付：草稿仍挂着
    expect(v.draftId).toBe(draftId);
    expect((await advanceWorkItem(ws, id, member, 'review')).ok).toBe(true);
    expect((await acceptWorkItem(ws, id, member)).ok).toBe(true);
    v = (await getWorkItem(ws, id))!;
    expect(v.stage).toBe('ready');
    expect(v.acceptedAt).toBeTruthy();
    expect(v.events.map((e) => e.kind)).toEqual(['created', 'stage', 'link', 'stage', 'reject', 'stage', 'accept']);
  });

  it('推进不能跳阶段；验收只在审校', async () => {
    const id = (await createWorkItem(ws, member, { title: 'x', accountId: acc, draftId }) as { id: string }).id;
    expect((await getWorkItem(ws, id))!.stage).toBe('drafting');
    expect((await advanceWorkItem(ws, id, member, 'ready')).ok).toBe(false);
    expect((await acceptWorkItem(ws, id, member)).ok).toBe(false);
  });

  it('派过的运行产物只补空位，不顶掉已挂的草稿', async () => {
    const id = (await createWorkItem(ws, member, { title: 'x', accountId: acc })) as { id: string };
    const run = await prisma.agentRun.create({ data: { workspaceId: ws, accountId: acc, memberId: member, goal: 'g', status: 'done' } });
    await prisma.agentArtifact.create({ data: { runId: run.id, kind: 'draft', refId: draftId, label: '新建草稿' } });
    await attachRun(ws, id.id, run.id, member);
    await syncFromRuns(ws, id.id);
    expect((await getWorkItem(ws, id.id))!.draftId).toBe(draftId);
    const other = await prisma.draft.create({ data: { accountId: acc, title: '另一篇', platform: 'xiaohongshu' } });
    const run2 = await prisma.agentRun.create({ data: { workspaceId: ws, accountId: acc, memberId: member, goal: 'g2', status: 'done' } });
    await prisma.agentArtifact.create({ data: { runId: run2.id, kind: 'draft', refId: other.id, label: '又一篇' } });
    await attachRun(ws, id.id, run2.id, member);
    await syncFromRuns(ws, id.id);
    expect((await getWorkItem(ws, id.id))!.draftId).toBe(draftId);
  });

  it('别的工作区动不了我的单', async () => {
    const id = (await createWorkItem(ws, member, { title: 'x', accountId: acc })) as { id: string };
    expect((await advanceWorkItem('other-ws', id.id, member, 'drafting')).ok).toBe(false);
  });
});
