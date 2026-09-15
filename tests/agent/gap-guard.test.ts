import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';

// 执行器那道「说做不到要记缺口」的硬闸，用剧本模型端到端钉住：
//   ① 零工具调用的「抱歉我无法…建议您去页面…」→ 被打回一次，第二轮调 report_capability_gap 后照常 done，
//      时间线上留着缺口那一步（ops 页与运行页都从这一步读）；
//   ② 打回一次仍然摊手 → 不再打回、也**不判失败**（如实说做不到不是谎报），run 是 done；
//   ③ 正常交付不被误伤：一句「已添加」直接 done，时间线上没有打回记录。

const h = vi.hoisted(() => ({
  script: [] as { text?: string; toolCalls?: { id: string; name: string; arguments: string }[] }[],
  seen: [] as string[],
}));

vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async (_t: unknown, _fn: unknown, messages: { role: string; content?: unknown }[]) => {
    const last = messages[messages.length - 1];
    if (typeof last?.content === 'string') h.seen.push(last.content);
    const next = h.script.shift() ?? { text: '（剧本演完了）' };
    return { text: next.text ?? '', provider: 'scripted', model: 'scripted', mocked: false, ...(next.toolCalls ? { toolCalls: next.toolCalls } : {}) };
  },
}));
vi.mock('@/lib/memory/core', () => ({ buildMemoryContext: async () => '' }));

const { startAgentRun } = await import('@/lib/agent/run');
const { settleAgentKicks } = await import('@/lib/agent/kick');

const GAVE_UP = '抱歉，我无法直接执行这个操作。升级成员权限需要通过系统管理界面完成。建议您：1. 登录烽火台系统 2. 进入工作区管理页面';
const call = (name: string, args: Record<string, unknown>) => ({ id: `c_${name}`, name, arguments: JSON.stringify(args) });

let ctx: { tenantId: string; workspaceId: string; accountId: string; memberId: string; role: string };

beforeEach(async () => {
  h.script = [];
  h.seen = [];
  await prisma.agentStep.deleteMany();
  await prisma.agentRun.deleteMany();
  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const ws = await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'W' } });
  const account = await prisma.creatorAccount.create({ data: { workspaceId: ws.id, name: '我的号', platform: 'douyin', personaCard: '{}' } });
  const member = await prisma.member.create({ data: { tenantId: tenant.id, name: '张三', role: 'owner' } });
  ctx = { tenantId: tenant.id, workspaceId: ws.id, accountId: account.id, memberId: member.id, role: 'owner' };
});

async function runScript(goal: string) {
  const t = await startAgentRun(ctx, goal, { authMode: 'unattended' });
  await settleAgentKicks();
  const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: t.runId } });
  const steps = await prisma.agentStep.findMany({ where: { runId: t.runId }, orderBy: { seq: 'asc' } });
  return { row, steps };
}

describe('说做不到要记缺口', () => {
  it('① 摊手一次被打回；记了缺口之后照常 done，时间线上留着缺口那一步', async () => {
    h.script = [
      { text: GAVE_UP },
      { toolCalls: [call('report_capability_gap', { need: '把成员升级成管理员', missing: '没有改成员角色的工具', tool: 'set_member_role', params: 'member + role', manual: '设置 → 成员' })] },
      { text: '已记下缺口，开发会补上。现在可以到「设置 → 成员」手动改。' },
    ];
    const { row, steps } = await runScript('把工作区成员小王升级成管理员');
    expect(row.status).toBe('done');
    expect(steps.some((s) => s.kind === 'tool_result' && s.tool === '' && s.result.includes('没记下缺口')), '打回应留痕').toBe(true);
    const gap = steps.find((s) => s.kind === 'tool_call' && s.tool === 'report_capability_gap');
    expect(gap, '缺口那一步必须在时间线上（ops 页从这里读）').toBeTruthy();
    expect(JSON.parse(gap!.args)).toMatchObject({ tool: 'set_member_role' });
    // 打回那句话真的送到了模型面前，且把可用工具清单带上了（让它先查有没有能做的）
    expect(h.seen.some((m) => m.startsWith('【系统·做不到要记缺口】') && m.includes('report_capability_gap'))).toBe(true);
  });

  it('② 打回一次仍然摊手 → 不再打回、不判失败', async () => {
    h.script = [{ text: GAVE_UP }, { text: GAVE_UP }, { text: '（不该走到第三轮）' }];
    const { row, steps } = await runScript('把工作区成员小王升级成管理员');
    expect(row.status, '如实说做不到不是谎报，不能判 failed').toBe('done');
    expect(steps.filter((s) => s.result.includes('没记下缺口'))).toHaveLength(1);
    expect(h.script, '第二次摊手之后不该再叫模型').toHaveLength(1);
  });

  it('调过工具之后的收尾提到「示例」不算编数据（2026-09-10 真机误伤）', async () => {
    h.script = [
      { toolCalls: [call('list_drafts', { limit: 3 })] },
      { text: '统计好了：字数按空格分词只是示例结果，中文按字算会更准。' },
    ];
    const { row, steps } = await runScript('数一下草稿字数');
    expect(row.status).toBe('done');
    expect(steps.some((s) => s.result.includes('示例数据」冒充结果')), '真调了工具就不该被当成编数据打回').toBe(false);
  });

  it('③ 正常交付不误伤', async () => {
    h.script = [{ text: '我已经把你的 X 账号添加进来了，现在的账号：X @aiyafun' }];
    const { row, steps } = await runScript('加我的 X 账号');
    expect(row.status).toBe('done');
    expect(steps.some((s) => s.result.includes('没记下缺口'))).toBe(false);
  });
});
