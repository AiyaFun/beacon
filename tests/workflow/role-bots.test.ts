import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';
import { BUILTIN_WORKFLOWS, ROLE_BOT_SLUGS } from '@/lib/workflow/builtin';
import { ensureBuiltinTemplates, listTemplates, adoptNewBuiltins, installTemplate, uninstallTemplate } from '@/lib/workflow/market';
import { availableTools } from '@/lib/agent/run';
import { parseAgentConfig } from '@/lib/agent/autonomous';

// 按职能分的机器人（2026-09-05，用户点名「不同职能的 bot」）。
// 它们是自主型内置模板：职责说明给人和模型看，**工具白名单才是职能的边界**。
const ROLE_BOTS = BUILTIN_WORKFLOWS.filter((w) => ROLE_BOT_SLUGS.includes(w.slug));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

let tenantId = '';
beforeEach(async () => {
  await prisma.tenant.deleteMany();
  await prisma.workflowTemplate.deleteMany({ where: { isBuiltin: true } });
  tenantId = (await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } })).id;
});

describe('职能 bot 的形状', () => {
  it('至少 6 个，全部自主型、有职责说明、白名单非空', () => {
    expect(ROLE_BOTS.length).toBeGreaterThanOrEqual(6);
    for (const b of ROLE_BOTS) {
      expect(b.mode, `${b.slug} 不是自主型`).toBe('autonomous');
      expect(b.persona.length, `${b.slug} 没有职责说明——AI 永远派不了它`).toBeGreaterThan(20);
      expect(b.agentConfig?.tools.length ?? 0, `${b.slug} 白名单为空 = 没有职能边界`).toBeGreaterThan(0);
      expect(b.steps).toEqual([]);
    }
  });

  it('🔒 白名单里的每个工具都真实存在（写错名字 = 这个 bot 少一项能力却没人知道）', () => {
    const all = new Set(availableTools('owner', []).map((t) => t.name));
    for (const b of ROLE_BOTS) for (const t of b.agentConfig!.tools) {
      expect(all.has(t), `${b.slug} 的白名单里有不存在的工具「${t}」`).toBe(true);
    }
  });

  it('🔒 三个高危工具不进任何职能 bot：run_shell / write_file / run_agent', () => {
    for (const b of ROLE_BOTS) for (const bad of ['run_shell', 'write_file', 'run_agent']) {
      expect(b.agentConfig!.tools, `${b.slug} 带了 ${bad}`).not.toContain(bad);
    }
  });

  it('职能边界互相分开：情报员不能建发布计划，发布官不能选题，出图师不能写稿', () => {
    const by = (slug: string) => ROLE_BOTS.find((b) => b.slug === slug)!.agentConfig!.tools;
    expect(by('bot-scout')).not.toContain('create_publish_plan');
    expect(by('bot-scout')).not.toContain('create_draft');
    expect(by('bot-publisher')).not.toContain('generate_topics');
    expect(by('bot-publisher')).not.toContain('create_draft');
    expect(by('bot-designer')).not.toContain('create_draft');
    expect(by('bot-compliance')).not.toContain('create_publish_plan');
    // 发布官建计划必须停下来等用户
    expect(ROLE_BOTS.find((b) => b.slug === 'bot-publisher')!.agentConfig!.defaultAuthMode).toBe('confirm_each');
  });

  it('职责说明写的是触发场景（用户会怎么开口），不是夸能力', () => {
    for (const b of ROLE_BOTS) expect(b.persona, `${b.slug} 的职责说明没写用户会怎么开口`).toMatch(/用户说「/);
  });
});

describe('落库与接入', () => {
  it('mode 与 agentConfig 落库，且存量行也补上（只写 create 的话老部署永远是流水线型）', async () => {
    await ensureBuiltinTemplates();
    await prisma.workflowTemplate.updateMany({ where: { slug: 'bot-scout' }, data: { mode: 'pipeline', agentConfig: null } });
    await ensureBuiltinTemplates();
    const row = await prisma.workflowTemplate.findFirstOrThrow({ where: { slug: 'bot-scout' } });
    expect(row.mode).toBe('autonomous');
    expect(parseAgentConfig(row.agentConfig).tools).toContain('collect_competitor');
  });

  it('老租户自动接入新内置：装过东西的租户会拿到新 bot；主动卸载过的不复活', async () => {
    await ensureBuiltinTemplates();
    const list0 = await listTemplates(tenantId);
    // 这个租户从没装过任何东西 → 不算老租户，什么都不自动装（新租户走 preinstall）
    expect(list0.filter((t) => t.installed && t.isBuiltin)).toHaveLength(0);
    const daily = list0.find((t) => t.slug === 'daily-xhs')!;
    await installTemplate(tenantId, daily.id);
    const n = await adoptNewBuiltins(tenantId);
    expect(n, '装过东西的租户没接到新 bot').toBeGreaterThanOrEqual(ROLE_BOTS.length);
    const scout = (await listTemplates(tenantId)).find((t) => t.slug === 'bot-scout')!;
    expect(scout.installed).toBe(true);
    // 主动卸载 → 再 adopt 不复活
    await uninstallTemplate(tenantId, scout.id);
    await adoptNewBuiltins(tenantId);
    expect((await listTemplates(tenantId)).find((t) => t.slug === 'bot-scout')!.installed).toBe(false);
  });

  it('🔒 群机器人绑定职能 bot 时，白名单真的接进运行（不只是把职责拼进提示）', () => {
    const d = strip(read('lib/bot/dispatch.ts'));
    expect(d, '没把 agentConfig.tools 当 toolAllowlist 传给 startAgentRun').toMatch(/toolAllowlist: cfg\.tools/);
    expect(d).toMatch(/authMode: cfg\.defaultAuthMode/);
    const r = strip(read('lib/bot/router.ts'));
    expect(r, 'router 查智能体没带 mode/agentConfig，dispatch 拿不到白名单').toMatch(/select: \{ id: true, name: true, persona: true, mode: true, agentConfig: true \}/);
  });
});
