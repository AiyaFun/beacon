import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';
import { normalizeProviderChoice, providerLabel } from '@/lib/llm/selectable';
import { createSchedule } from '@/lib/workflow/schedule-create';

// 按任务选模型（2026-09-11）：首页派活 / 一键任务卡 / 定时 / 流水线步骤都能指定模型渠道。
// 归一只有一处（normalizeProviderChoice）：别人的渠道 id 必须被拒，不能静默落回自动。

const ROOT = path.resolve(__dirname, '../..');
const code = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let tenantId: string; let otherTenant: string; let mine: string; let theirs: string;
beforeEach(async () => {
  const t = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const o = await prisma.tenant.create({ data: { name: 'O', plan: 'personal' } });
  tenantId = t.id; otherTenant = o.id;
  mine = (await prisma.modelProvider.create({ data: { tenantId, label: '我的 DeepSeek', vendor: 'deepseek', baseUrl: 'https://x', apiKeyEnc: 'enc', model: 'deepseek-chat', region: 'cn', routing: '{}' } })).id;
  theirs = (await prisma.modelProvider.create({ data: { tenantId: otherTenant, label: '别人的', vendor: 'deepseek', baseUrl: 'https://x', apiKeyEnc: 'enc', model: 'm', region: 'cn', routing: '{}' } })).id;
});

describe('normalizeProviderChoice', () => {
  it('空 / auto = 自动（null）', async () => {
    expect(await normalizeProviderChoice(tenantId, '')).toEqual({ ok: true, providerId: null });
    expect(await normalizeProviderChoice(tenantId, 'auto')).toEqual({ ok: true, providerId: null });
    expect(await normalizeProviderChoice(tenantId, undefined)).toEqual({ ok: true, providerId: null });
  });
  it('自己的渠道认；别人的渠道拒（不静默落回自动）；失效的拒', async () => {
    expect(await normalizeProviderChoice(tenantId, mine)).toEqual({ ok: true, providerId: mine });
    expect((await normalizeProviderChoice(tenantId, theirs)).ok).toBe(false);
    await prisma.modelProvider.update({ where: { id: mine }, data: { status: 'failed' } });
    expect((await normalizeProviderChoice(tenantId, mine)).ok).toBe(false);
  });
  it('标签：自动 / 渠道名 · 模型 / 已删除', async () => {
    expect(await providerLabel(tenantId, null)).toBe('自动');
    expect(await providerLabel(tenantId, mine)).toContain('我的 DeepSeek');
    expect(await providerLabel(tenantId, 'nope')).toContain('已删除');
  });
});

describe('落库与传递', () => {
  it('定时存下 providerId', async () => {
    // createSchedule 先判这台机器有没有在跑定时（lib/edition backgroundSchedulerRuns）
    vi.stubEnv('BEACON_QUEUE', 'local');
    const ws = await prisma.workspace.create({ data: { tenantId, name: 'W' } });
    const acc = await prisma.creatorAccount.create({ data: { workspaceId: ws.id, name: 'A', platform: 'douyin', personaCard: '{}' } });
    const m = await prisma.member.create({ data: { tenantId, name: 'me', role: 'owner' } });
    const tpl = await prisma.workflowTemplate.create({ data: { slug: `t-${Date.now()}`, name: 'T', steps: '[{"kind":"topic","count":3}]', tenantId } });
    await prisma.workflowInstall.create({ data: { tenantId, templateId: tpl.id } });
    const r = await createSchedule({ workspaceId: ws.id, accountId: acc.id, memberId: m.id, tenantId, templateId: tpl.id, atHour: 9, atMinute: 0, weekdays: [], providerId: mine });
    expect(r.ok).toBe(true);
    const row = await prisma.scheduledAgent.findUnique({ where: { id: (r as { id: string }).id } });
    expect(row?.providerId).toBe(mine);
  });

  it('🔒 源码：执行循环把 run.providerId 传给网关；定时把 providerId 交给派发与流水线；卡的选择可被定时覆盖', () => {
    const run = code('lib/agent/run.ts');
    expect(run).toMatch(/providerId: run\.providerId/);
    expect(run).toMatch(/providerId: opts\.providerId \?\? null/);
    const sched = code('lib/workflow/schedule.ts');
    expect(sched).toMatch(/providerIdOverride: r\.providerId/);
    expect(sched).toMatch(/providerId: r\.providerId/);
    expect(code('lib/agent/preset.ts')).toMatch(/input\.providerIdOverride \?\? preset\.providerId/);
    const wf = code('lib/workflow/run.ts');
    expect((wf.match(/ctx\.providerId/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(code('lib/workflow/handoff.ts')).toMatch(/providerId: ctx\.providerId/);
  });
});
