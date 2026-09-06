import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';

// bot 的形态补齐（2026-09-05，学 Grok Bot 市场的四块：Memories / Skills / Routines / Integrations）：
//   ② 技能带「什么时候用」并注进系统提示；③ 建议定时默认关、装上后问一次；
//   导出/导入把 mode + agentConfig 整份带走（此前职能 bot 导出即成空流水线）。

vi.mock('@/lib/jobs/queue', async (orig) => ({ ...(await orig<typeof import('@/lib/jobs/queue')>()), backgroundSchedulerRuns: () => true }));
vi.mock('@/lib/memory/core', () => ({ buildMemoryContext: async () => '' }));
const h = vi.hoisted(() => ({ calls: [] as { messages: { role: string; content: string }[] }[] }));
vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: async (_t: unknown, _fn: unknown, messages: { role: string; content: string }[]) => {
    h.calls.push({ messages });
    return { text: '好的', provider: 'scripted', model: 'scripted', mocked: false };
  },
}));

const { parseAgentConfig, BOT_SKILLS_MAX, BOT_ROUTINES_MAX } = await import('@/lib/agent/autonomous');
const { BUILTIN_WORKFLOWS, ROLE_BOT_SLUGS } = await import('@/lib/workflow/builtin');
const { BUILTIN_SKILLS } = await import('@/prisma/system-data');
const { ensureBuiltinTemplates, installTemplate, createTemplate, exportTemplate, importTemplate, listTemplates } = await import('@/lib/workflow/market');
const { enableRoutine, enabledRoutines } = await import('@/lib/workflow/routines');
const { createSchedule } = await import('@/lib/workflow/schedule-create');
const { listSkillsForTenant, installSkill } = await import('@/lib/skills');
const { startAgentRun } = await import('@/lib/agent/run');
const { settleAgentKicks } = await import('@/lib/agent/kick');

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const ROLE_BOTS = BUILTIN_WORKFLOWS.filter((w) => ROLE_BOT_SLUGS.includes(w.slug));

let tenantId = ''; let ws = ''; let memberId = ''; let accountId = '';
beforeEach(async () => {
  h.calls = [];
  await prisma.agentStep.deleteMany();
  await prisma.agentRun.deleteMany();
  await prisma.tenant.deleteMany();
  await prisma.contentSkill.deleteMany();
  await prisma.workflowTemplate.deleteMany({ where: { isBuiltin: true } });
  const t = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  tenantId = t.id;
  ws = (await prisma.workspace.create({ data: { tenantId, name: 'W' } })).id;
  memberId = (await prisma.member.create({ data: { tenantId, name: '张三', role: 'owner' } })).id;
  accountId = (await prisma.creatorAccount.create({ data: { workspaceId: ws, name: '我的号', platform: 'x', personaCard: '{}' } })).id;
});

describe('agentConfig 多出的两块', () => {
  it('技能没写「什么时候用」的不收；超上限截断；坏形状整段丢', () => {
    const cfg = parseAgentConfig(JSON.stringify({
      tools: ['a'],
      skills: [{ slug: 'x', when: '要 x 时' }, { slug: 'no-when' }, { when: '没 slug' }, 'junk', ...Array.from({ length: 20 }, (_, i) => ({ slug: `s${i}`, when: 'w' }))],
      routines: [{ title: 't', goal: 'g', atHour: 8 }, { title: 't2', goal: 'g', atHour: 24 }, { title: '', goal: 'g', atHour: 9 }, { title: 't3', goal: 'g', atHour: 9, weekdays: [1, 1, 9] }],
    }));
    expect(cfg.skills!.length).toBe(BOT_SKILLS_MAX);
    expect(cfg.skills![0]).toEqual({ slug: 'x', when: '要 x 时' });
    expect(cfg.routines).toEqual([{ title: 't', goal: 'g', atHour: 8 }, { title: 't3', goal: 'g', atHour: 9, weekdays: [1] }]);
    expect(parseAgentConfig(JSON.stringify({ tools: [], skills: 'x', routines: 1 }))).toEqual({ systemPrompt: '', tools: [] });
    expect(BOT_ROUTINES_MAX).toBeLessThanOrEqual(3);
  });

  it('🔒 职能 bot：写手的技能全是真实内置技能；带台账工具的 bot 才在提示里教它去重；建议定时的时刻合法', () => {
    const slugs = new Set(BUILTIN_SKILLS.map((s) => s.slug));
    const writer = ROLE_BOTS.find((b) => b.slug === 'bot-writer')!;
    expect(writer.agentConfig!.skills!.length).toBeGreaterThanOrEqual(3);
    for (const sk of writer.agentConfig!.skills!) {
      expect(slugs.has(sk.slug), `写手引用了不存在的技能「${sk.slug}」`).toBe(true);
      expect(sk.when.length).toBeGreaterThan(4);
    }
    for (const b of ROLE_BOTS) {
      const tools = b.agentConfig!.tools;
      const prompt = b.agentConfig!.systemPrompt;
      if (tools.includes('mark_seen')) expect(prompt, `${b.slug} 有 mark_seen 却没教它先去重`).toMatch(/mark_seen/);
      if (/mark_seen|ledger_write/.test(prompt)) expect(tools, `${b.slug} 的提示提到台账工具但白名单里没有`).toEqual(expect.arrayContaining(['ledger_read', 'ledger_write']));
      for (const r of b.agentConfig!.routines ?? []) {
        expect(r.atHour).toBeGreaterThanOrEqual(0); expect(r.atHour).toBeLessThanOrEqual(23);
        expect(r.goal.length).toBeGreaterThan(10);
      }
      // 建发布计划的 bot 不该带建议定时：到点无人在跟前，confirm_each 会永远卡在第一步
      if (tools.includes('create_publish_plan')) expect(b.agentConfig!.routines ?? []).toEqual([]);
    }
    expect(ROLE_BOTS.filter((b) => (b.agentConfig!.routines ?? []).length > 0).length).toBeGreaterThanOrEqual(2);
  });

  it('🔒 技能块注进系统提示：已装的带 skill_id，没装的标「未装」', async () => {
    await ensureBuiltinTemplates();
    const writer = await prisma.workflowTemplate.findFirstOrThrow({ where: { slug: 'bot-writer' } });
    // 测试库里没有种过内置技能（生产靠 sync-system-data），按 tests/skills 的做法手建一条
    await prisma.contentSkill.create({
      data: { slug: 'wechat-format', name: '微信公众号一键排版', description: '排版', emoji: '✨', platform: 'wechat', category: 'format', promptTemplate: '{{content}}', outputKind: 'html', isBuiltin: true, tenantId: null },
    });
    const all = await listSkillsForTenant(tenantId);
    const wechat = all.find((s) => s.slug === 'wechat-format')!;
    await installSkill(tenantId, wechat.id);
    await startAgentRun({ tenantId, workspaceId: ws, accountId, memberId, role: 'owner' }, '写一篇', { agentTemplateId: writer.id, authMode: 'unattended' });
    await settleAgentKicks();
    const sys = h.calls[0].messages[0].content;
    expect(sys).toContain('【你能用的技能】');
    expect(sys).toContain(`skill_id=${wechat.id}`);
    expect(sys).toMatch(/「xhs-format」（未装/);
  });
});

describe('导出 / 导入把自主型整份带走', () => {
  it('🔒 自建自主型：mode、白名单、技能、建议定时一圈不丢；老版本 1 的文件照收', async () => {
    const created = await createTemplate(tenantId, memberId, {
      name: '我的情报员', persona: '要盯人时派我', steps: [], mode: 'autonomous', requires: '先加竞对',
      agentConfig: { systemPrompt: '只读', tools: ['list_competitors', 'mark_seen'], skills: [{ slug: 'wechat-format', when: '排版时' }], routines: [{ title: '早报', goal: '盯一遍', atHour: 8 }] },
    });
    expect(created.ok, (created as { error?: string }).error).toBe(true);
    const id = (created as { id: string }).id;
    const row = await prisma.workflowTemplate.findUniqueOrThrow({ where: { id } });
    expect(row.mode).toBe('autonomous');
    expect(row.requires).toBe('先加竞对');
    const json = await exportTemplate(tenantId, id);
    const parsed = JSON.parse(json!);
    expect(parsed.beaconWorkflow).toBe(2);
    expect(parsed.mode).toBe('autonomous');
    expect(parsed.agentConfig.tools).toEqual(['list_competitors', 'mark_seen']);
    expect(parsed.agentConfig.skills[0].when).toBe('排版时');
    expect(json).not.toContain(tenantId);

    const other = await prisma.tenant.create({ data: { name: 'P', plan: 'free' } });
    const r = await importTemplate(other.id, memberId, json!);
    expect(r.ok, (r as { error?: string }).error).toBe(true);
    const got = await prisma.workflowTemplate.findUniqueOrThrow({ where: { id: (r as { id: string }).id } });
    expect(got.mode, '导入后退化成流水线').toBe('autonomous');
    const cfg = parseAgentConfig(got.agentConfig);
    expect(cfg.tools).toEqual(['list_competitors', 'mark_seen']);
    expect(cfg.skills).toEqual([{ slug: 'wechat-format', when: '排版时' }]);
    expect(cfg.routines).toEqual([{ title: '早报', goal: '盯一遍', atHour: 8 }]);
    expect(got.requires).toBe('先加竞对');
    // 老文件
    const old = await importTemplate(tenantId, memberId, JSON.stringify({ beaconWorkflow: 1, name: '老的', steps: [{ kind: 'cover' }] }));
    expect(old.ok).toBe(true);
  });

  it('🔒 内置职能 bot 导出的不是空流水线', async () => {
    await ensureBuiltinTemplates();
    const scout = await prisma.workflowTemplate.findFirstOrThrow({ where: { slug: 'bot-scout' } });
    const parsed = JSON.parse((await exportTemplate(tenantId, scout.id))!);
    expect(parsed.mode).toBe('autonomous');
    expect(parsed.agentConfig.tools).toContain('collect_competitor');
    expect(parsed.agentConfig.routines.length).toBeGreaterThan(0);
  });

  it('自主型没白名单也没人设 → 拒绝（那是个什么都不会的空壳）', async () => {
    const r = await createTemplate(tenantId, memberId, { name: '空壳', persona: 'x', steps: [], mode: 'autonomous', agentConfig: { tools: [] } });
    expect(r.ok).toBe(false);
  });
});

describe('建议定时：装上后问一次，开了才建，幂等', () => {
  it('🔒 开一条 → 一张卡 + 一条 task 定时；再开不重复；停掉再开是重新启用', async () => {
    await ensureBuiltinTemplates();
    const scout = (await listTemplates(tenantId)).find((t) => t.slug === 'bot-scout')!;
    const before = await enableRoutine({ tenantId, workspaceId: ws, accountId, memberId, templateId: scout.id, index: 0 });
    expect(before.ok, '没装就能开定时——到点派给一个未安装的 bot').toBe(false);
    await installTemplate(tenantId, scout.id);
    const r = await enableRoutine({ tenantId, workspaceId: ws, accountId, memberId, templateId: scout.id, index: 0 });
    expect(r.ok, (r as { error?: string }).error).toBe(true);
    const preset = await prisma.taskPreset.findFirstOrThrow({ where: { workspaceId: ws, agentTemplateId: scout.id } });
    expect(preset.title).toBe('每天早上盯一遍竞对与热榜');
    expect(preset.goal).toMatch(/mark_seen/);
    const sched = await prisma.scheduledAgent.findFirstOrThrow({ where: { workspaceId: ws, taskPresetId: preset.id } });
    expect(sched.targetKind).toBe('task');
    expect(sched.atHour).toBe(8);
    expect(sched.enabled).toBe(true);
    expect(await enabledRoutines(ws, [{ id: scout.id, agentConfig: scout.agentConfig }])).toEqual({ [scout.id]: [0] });

    await enableRoutine({ tenantId, workspaceId: ws, accountId, memberId, templateId: scout.id, index: 0 });
    expect(await prisma.taskPreset.count({ where: { workspaceId: ws } })).toBe(1);
    expect(await prisma.scheduledAgent.count({ where: { workspaceId: ws } })).toBe(1);

    await prisma.scheduledAgent.update({ where: { id: sched.id }, data: { enabled: false, failStreak: 3 } });
    expect(await enabledRoutines(ws, [{ id: scout.id, agentConfig: scout.agentConfig }])).toEqual({});
    await enableRoutine({ tenantId, workspaceId: ws, accountId, memberId, templateId: scout.id, index: 0 });
    const again = await prisma.scheduledAgent.findUniqueOrThrow({ where: { id: sched.id } });
    expect(again.enabled).toBe(true);
    expect(again.failStreak).toBe(0);
    expect(await prisma.scheduledAgent.count({ where: { workspaceId: ws } })).toBe(1);
    expect((await enableRoutine({ tenantId, workspaceId: ws, accountId, memberId, templateId: scout.id, index: 7 })).ok).toBe(false);
  });

  it('🔒 createSchedule 指一键任务：别的工作区的卡不认', async () => {
    const other = (await prisma.workspace.create({ data: { tenantId, name: 'O' } })).id;
    const p = await prisma.taskPreset.create({ data: { tenantId, workspaceId: other, title: 'x', goal: 'y' } });
    const r = await createSchedule({ tenantId, workspaceId: ws, accountId, memberId, targetKind: 'task', taskPresetId: p.id, atHour: 8, atMinute: 0, weekdays: [] });
    expect(r.ok).toBe(false);
    const ok = await createSchedule({ tenantId, workspaceId: other, accountId, memberId, targetKind: 'task', taskPresetId: p.id, atHour: 8, atMinute: 0, weekdays: [1] });
    expect(ok.ok).toBe(true);
  });

  it('🔒 界面：卡上有「开启」与「不用」，只在已装的自主型且有后台调度时问；list_agents 把技能与建议定时告诉模型', () => {
    const ui = read('app/(app)/workflows/WorkflowMarket.tsx');
    expect(ui).toContain('data-act="enable-routine"');
    expect(ui).toMatch(/canSchedule && t\.installed && t\.mode === 'autonomous'/);
    expect(ui).toContain('建议定时（默认关）');
    expect(ui).toContain('技能（什么时候用）');
    const page = strip(read('app/(app)/workflows/page.tsx'));
    expect(page).toMatch(/routineState=\{routineState\}/);
    expect(page).toMatch(/canSchedule=\{canSchedule\}/);
    const tools = strip(read('lib/agent/tools.ts'));
    expect(tools).toMatch(/技能: cfg\.skills\.map/);
    expect(tools).toMatch(/建议定时: cfg\.routines\.map/);
  });
});

describe('第二批（2026-09-05 下午）：首次开场、群里提定时、台账可见可改', () => {
  it('🔒 带台账工具的 bot 台账为空 → 系统提示明说「还是空的」并教它先问盯什么；不带台账工具的不注', async () => {
    await ensureBuiltinTemplates();
    const scout = await prisma.workflowTemplate.findFirstOrThrow({ where: { slug: 'bot-scout' } });
    await startAgentRun({ tenantId, workspaceId: ws, accountId, memberId, role: 'owner' }, '采一下', { agentTemplateId: scout.id, authMode: 'unattended' });
    await settleAgentKicks();
    const sys = h.calls[0].messages[0].content;
    expect(sys).toContain('【你的台账】还是空的');
    expect(sys).toMatch(/先问清要盯哪些号/);
    h.calls = [];
    const compliance = await prisma.workflowTemplate.findFirstOrThrow({ where: { slug: 'bot-compliance' } });
    await startAgentRun({ tenantId, workspaceId: ws, accountId, memberId, role: 'owner' }, '查一下', { agentTemplateId: compliance.id, authMode: 'unattended' });
    await settleAgentKicks();
    expect(h.calls[0].messages[0].content).not.toContain('【你的台账】');
  });

  it('🔒 群里 /智能体 绑到带建议定时的 bot 时提一句（默认关、去页面开），不做「回复 1 就开」', () => {
    const r = strip(read('lib/bot/router.ts'));
    expect(r).toMatch(/parseAgentConfig\(picked\.hit\.agentConfig\)\.routines/);
    expect(r).toContain('要开的话去');
    expect(r, '群里一句话就开定时=谁都能让全工作区每天多花一次额度').not.toMatch(/enableRoutine\(/);
  });

  it('🔒 台账在卡上：能看、能删单条、能记入、能清已见；action 只认租户看得见的 slug', async () => {
    const ui = read('app/(app)/workflows/WorkflowMarket.tsx');
    for (const act of ['ledger-delete', 'ledger-write', 'ledger-clear-seen']) expect(ui).toContain(`data-act="${act}"`);
    expect(ui).toMatch(/t\.installed && !readOnly && \(\s*<LedgerBlock/);
    const actions = strip(read('app/(app)/workflows/actions.ts'));
    expect(actions).toMatch(/async function visibleSlug/);
    expect(actions).toMatch(/if \(!\(await visibleSlug\(s\.tenantId, slug\)\)\) return \{ ok: false/);
    const page = strip(read('app/(app)/workflows/page.tsx'));
    expect(page).toMatch(/ledgerState=\{ledgerState\}/);
    // 读侧：ledgersByBot 按 slug 分组、seen 只计数不带内容；clearSeen 只删 seen 不动 kv
    const { ledgersByBot, clearSeen, ledgerSet, markSeen, ledgerGet } = await import('@/lib/agent/ledger');
    await ledgerSet(ws, 'bot-scout', '盯单', '@a');
    await markSeen(ws, 'bot-scout', ['u1', 'u2']);
    await ledgerSet(ws, 'bot-topic', '不做的方向', '带货');
    const got = await ledgersByBot(ws, ['bot-scout', 'bot-topic', 'bot-writer']);
    expect(got['bot-scout'].kv.map((e) => e.key)).toEqual(['盯单']);
    expect(got['bot-scout'].seen).toBe(2);
    expect(got['bot-topic'].seen).toBe(0);
    expect(got['bot-writer']).toBeUndefined();
    expect(await clearSeen(ws, 'bot-scout')).toBe(2);
    expect(await ledgerGet(ws, 'bot-scout', '盯单'), '清已见把 kv 也删了').toBe('@a');
  });
});
