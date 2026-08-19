import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { parseSteps, stepsSchema, stepLabel, stepCostly } from '@/lib/workflow/steps';
import {
  ensureBuiltinTemplates,
  listTemplates,
  installTemplate,
  createTemplate,
  deleteTemplate,
  exportTemplate,
  importTemplate,
} from '@/lib/workflow/market';
import { BUILTIN_WORKFLOWS } from '@/lib/workflow/builtin';

// 模板市场。要钉住的是「别人给的模板不可信」这条：导入的 JSON 必须过同一套 schema，
// 且步骤类型是白名单——否则模板就成了一个可以被分享的任意执行通道。

let tenantId: string;
const MEMBER = 'member-1';

beforeEach(async () => {
  await prisma.workflowInstall.deleteMany();
  await prisma.workflowRun.deleteMany();
  await prisma.workflowTemplate.deleteMany();
  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  tenantId = tenant.id;
});

describe('步骤 schema', () => {
  it('只认白名单里的步骤类型', () => {
    expect(stepsSchema.safeParse([{ kind: 'shell', cmd: 'rm -rf /' }]).success).toBe(false);
    expect(stepsSchema.safeParse([{ kind: 'draft' }]).success).toBe(true);
  });

  it('坏 JSON / 坏形状一律当成空模板，不把页面打挂', () => {
    expect(parseSteps('这不是 json')).toEqual([]);
    expect(parseSteps('[{"kind":"nope"}]')).toEqual([]);
  });

  it('步数上限 10（模板不该变成无限流水线）', () => {
    const many = Array.from({ length: 11 }, () => ({ kind: 'cover' }));
    expect(stepsSchema.safeParse(many).success).toBe(false);
  });

  it('发布步不算「花额度」的步，其余都算', () => {
    expect(stepCostly({ kind: 'publish', platforms: ['wechat'] })).toBe(false);
    expect(stepCostly({ kind: 'cover' })).toBe(true);
  });

  it('步骤标签是人话，能直接摆在界面上', () => {
    expect(stepLabel({ kind: 'skill', slug: 'xhs-note' })).toContain('xhs-note');
    expect(stepLabel({ kind: 'publish', platforms: ['wechat', 'douyin'] })).toContain('wechat');
  });
});

describe('内置模板', () => {
  it('落库是幂等的（读的时候顺手做，不依赖种子脚本）', async () => {
    await ensureBuiltinTemplates();
    await ensureBuiltinTemplates();
    const rows = await prisma.workflowTemplate.findMany({ where: { isBuiltin: true } });
    expect(rows).toHaveLength(BUILTIN_WORKFLOWS.length);
  });

  it('内置模板的步骤全部合法（写错了会在市场里变成空模板）', () => {
    for (const w of BUILTIN_WORKFLOWS) {
      expect(stepsSchema.safeParse(w.steps).success, `${w.slug} 步骤不合法`).toBe(true);
    }
  });

  it('内置模板默认没装上（不替用户决定装什么）', async () => {
    const list = await listTemplates(tenantId);
    expect(list.every((t) => !t.isBuiltin || !t.installed)).toBe(true);
    const first = list[0];
    await installTemplate(tenantId, first.id);
    const after = await listTemplates(tenantId);
    expect(after.find((t) => t.id === first.id)!.installed).toBe(true);
  });
});

describe('自建 / 导入导出', () => {
  it('自建模板天然可用，不必再装一次', async () => {
    const r = await createTemplate(tenantId, MEMBER, { name: '我的流水线', steps: [{ kind: 'cover' }] });
    expect(r.ok).toBe(true);
    const list = await listTemplates(tenantId);
    const mine = list.find((t) => t.name === '我的流水线')!;
    expect(mine.installed).toBe(true);
    expect(mine.isBuiltin).toBe(false);
  });

  it('别的租户看不到我建的模板', async () => {
    await createTemplate(tenantId, MEMBER, { name: '私有流水线', steps: [{ kind: 'cover' }] });
    const other = await prisma.tenant.create({ data: { name: 'O', plan: 'free' } });
    const list = await listTemplates(other.id);
    expect(list.find((t) => t.name === '私有流水线')).toBeUndefined();
  });

  it('步骤不合法时给出人话错误，而不是一段 zod issue', async () => {
    const r = await createTemplate(tenantId, MEMBER, { name: 'X', steps: [{ kind: 'skill' }] });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('步骤配置不对');
  });

  it('导出不带租户信息（分享出去的东西不该带上你是谁）', async () => {
    const created = await createTemplate(tenantId, MEMBER, { name: '可分享', steps: [{ kind: 'cover' }] });
    const json = await exportTemplate(tenantId, (created as { id: string }).id);
    expect(json).toBeTruthy();
    expect(json!).not.toContain(tenantId);
    expect(json!).not.toContain(MEMBER);
  });

  it('导入的 JSON 同样过 schema：塞不进白名单外的步骤', async () => {
    const bad = JSON.stringify({ beaconWorkflow: 1, name: '坏模板', steps: [{ kind: 'shell', cmd: 'ls' }] });
    const r = await importTemplate(tenantId, MEMBER, bad);
    expect(r.ok).toBe(false);
  });

  it('缺版本标记的 JSON 不认（防止把任意 JSON 当模板导进来）', async () => {
    const r = await importTemplate(tenantId, MEMBER, JSON.stringify({ name: 'x', steps: [] }));
    expect(r.ok).toBe(false);
  });

  it('内置模板删不掉（它是全局行，删了会影响所有租户）', async () => {
    await ensureBuiltinTemplates();
    const builtin = await prisma.workflowTemplate.findFirst({ where: { isBuiltin: true } });
    const r = await deleteTemplate(tenantId, builtin!.id);
    expect(r.ok).toBe(false);
    expect(await prisma.workflowTemplate.count({ where: { isBuiltin: true } })).toBeGreaterThan(0);
  });
});
