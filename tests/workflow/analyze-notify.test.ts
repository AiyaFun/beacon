import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';

// 工作流的两种新步骤：analyze（出一份简报）与 notify（推到群里）。
// 它们合起来才让「每天看一眼数据 → 出简报 → 推到群」这类情报流水线拼得出来——
// 在此之前六种步骤全都围着草稿转，没有一种是「看一眼数据然后说人话」。
//
// 两条最容易长出静默错的地方，各钉一组：
//   ① **没接真模型时不许出简报**。llmComplete 会兜底编一段像模像样的文字，
//      把它存下来再推到群里，就是拿示例内容冒充结论。
//   ② **「一条都没发」有三种含义**：没配机器人 / 配了但没勾这个推送事件 / 发送失败。
//      只回一句「已推送」，用户会以为群里收到了。

const h = vi.hoisted(() => ({
  llm: { text: '这周你发了 3 条，B 站那条跑得最好。建议：把那条的开头拆解一下复用。', mocked: false },
  push: { sent: 0, failed: 0 },
  pushCalls: [] as { event: string; workspaceId: string }[],
}));

vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async () => ({ text: h.llm.text, provider: 'scripted', model: 'scripted', mocked: h.llm.mocked }),
}));

vi.mock('@/lib/bot', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/bot')>();
  return {
    ...real,
    pushEvent: async (workspaceId: string, event: string) => {
      h.pushCalls.push({ workspaceId, event });
      return h.push;
    },
  };
});

const { runWorkflow } = await import('@/lib/workflow/run');
const { createTemplate } = await import('@/lib/workflow/market');

let ctx: { tenantId: string; workspaceId: string; accountId: string; memberId: string };

beforeEach(async () => {
  h.llm = { text: '这周你发了 3 条，B 站那条跑得最好。建议：把那条的开头拆解一下复用。', mocked: false };
  h.push = { sent: 0, failed: 0 };
  h.pushCalls = [];
  await prisma.workflowRun.deleteMany();
  await prisma.workflowTemplate.deleteMany();
  await prisma.publishRecord.deleteMany();
  await prisma.notification.deleteMany();

  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  const account = await prisma.creatorAccount.create({
    data: { workspaceId: ws.id, name: '我的号', platform: 'bilibili', personaCard: '{}' },
  });
  const member = await prisma.member.create({ data: { tenantId: tenant.id, name: '张三', role: 'owner' } });
  ctx = { tenantId: tenant.id, workspaceId: ws.id, accountId: account.id, memberId: member.id };
});

async function runSteps(steps: unknown[]) {
  const t = await createTemplate(ctx.tenantId, ctx.memberId, { name: `T-${Math.random()}`, steps });
  if (!t.ok) throw new Error(t.error);
  return runWorkflow({ ...ctx, trigger: 'manual' }, t.id);
}

async function seedOneWork() {
  await prisma.publishRecord.create({
    data: {
      accountId: ctx.accountId,
      platform: 'bilibili',
      title: '一条跑得不错的视频',
      metrics: JSON.stringify({ views: 12000, likes: 800 }),
    },
  });
}

describe('analyze：出一份简报', () => {
  it('有数据时出简报，且不新采任何数据', async () => {
    await seedOneWork();
    const view = await runSteps([{ kind: 'analyze', target: 'performance' }]);
    expect(view.status).toBe('done');
    expect(view.logs[0].ok).toBe(true);
    expect(view.logs[0].message).toContain('简报已生成');
  });

  it('没有数据时不调模型、如实说没出（对着空数据写出来的一定是编的）', async () => {
    const view = await runSteps([{ kind: 'analyze', target: 'performance' }]);
    expect(view.status).toBe('failed');
    expect(view.logs[0].message).toContain('还没有发布记录');
  });

  it('没接真实模型时**不许**出简报（示例内容不能当结论）', async () => {
    await seedOneWork();
    h.llm = { text: '（示例）你的数据很棒！', mocked: true };

    const view = await runSteps([{ kind: 'analyze', target: 'performance' }]);
    expect(view.status).toBe('failed');
    expect(view.logs[0].message).toContain('示例内容不能当结论');
  });

  it('三种分析目标都能跑（没数据时各自给各自的原因）', async () => {
    for (const target of ['performance', 'rivals', 'readers']) {
      const view = await runSteps([{ kind: 'analyze', target }]);
      // 都没有数据，但原因要各说各的，不能一律「没有数据」
      expect(view.logs[0].message.length).toBeGreaterThan(6);
    }
  });
});

describe('notify：推到群里', () => {
  it('推成功时说清楚推给了几个', async () => {
    await seedOneWork();
    h.push = { sent: 2, failed: 0 };

    const view = await runSteps([{ kind: 'analyze', target: 'performance' }, { kind: 'notify' }]);
    expect(view.status).toBe('done');
    expect(view.logs[1].message).toContain('已推给 2 个');
    expect(h.pushCalls[0].event, '要用用户能在设置页勾上的那个事件').toBe('agent_done');
  });

  it('一条都没发出去时**必须说破**，不能只说「已推送」', async () => {
    await seedOneWork();
    h.push = { sent: 0, failed: 0 };

    const view = await runSteps([{ kind: 'analyze', target: 'performance' }, { kind: 'notify' }]);
    const msg = view.logs[1].message;
    expect(msg, '用户会以为群里收到了').not.toContain('已推给');
    // 没配 与 配了没勾 两种情况都要提到——用户要做的事不一样
    expect(msg).toMatch(/没配|没勾/);
  });

  it('发送失败与「压根没配」要分开说（用户要做的事不一样）', async () => {
    await seedOneWork();
    h.push = { sent: 0, failed: 3 };

    const view = await runSteps([{ kind: 'analyze', target: 'performance' }, { kind: 'notify' }]);
    expect(view.logs[1].message).toContain('发送失败');
  });

  it('无论群里推没推成，站内通知都要落一条（机器人可能一个都没配）', async () => {
    await seedOneWork();
    h.push = { sent: 0, failed: 0 };

    await runSteps([{ kind: 'analyze', target: 'performance' }, { kind: 'notify' }]);
    const n = await prisma.notification.count({ where: { workspaceId: ctx.workspaceId } });
    expect(n, '群里没收到、站内也没有，等于这一步白跑').toBeGreaterThan(0);
  });

  it('前面什么都没产出时如实失败，不推一条空消息', async () => {
    const view = await runSteps([{ kind: 'notify' }]);
    expect(view.status).toBe('failed');
    expect(h.pushCalls, '没内容就不该发').toHaveLength(0);
  });
});

describe('步骤账目', () => {
  it('notify 不算「花额度」的步（它只发一条消息）', async () => {
    const { stepCostly } = await import('@/lib/workflow/steps');
    expect(stepCostly({ kind: 'notify' })).toBe(false);
    // analyze 要把数据交给模型写成简报，算钱
    expect(stepCostly({ kind: 'analyze', target: 'performance' })).toBe(true);
  });

  it('新步骤的标签是人话，能直接摆在界面上', async () => {
    const { stepLabel } = await import('@/lib/workflow/steps');
    expect(stepLabel({ kind: 'analyze', target: 'readers' })).toContain('读者');
    expect(stepLabel({ kind: 'notify' })).toContain('群');
  });
});
