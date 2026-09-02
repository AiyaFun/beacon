import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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

const ROOT = path.resolve(__dirname, '../..');
import { BUILTIN_WORKFLOWS } from '@/lib/workflow/builtin';
import { BUILTIN_SKILLS } from '@/prisma/system-data';

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

describe('内置模板落库不许带进程内记忆', () => {
  it('连着调两次、中间清空库，第二次仍然要把模板写回去', () => {
    // 曾经给它加过「本进程已同步」的标记省那三次 upsert，结果 beforeEach 清库之后
    // 标记还在，从第二个用例起内置模板永远不再落库。这条用例就是当时红掉的那批的浓缩版：
    // 它跑在**别的用例已经调过 ensureBuiltinTemplates 之后**，能落库就说明没有残留记忆。
    const src = fs.readFileSync(path.join(ROOT, 'lib/workflow/market.ts'), 'utf8');
    expect(src, '又给 ensureBuiltinTemplates 加缓存标记了').not.toMatch(/builtinsSynced/);
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

  it('内置模板引用的技能 slug 必须真实存在（schema 合法 ≠ 跑得起来）', () => {
    // 「小红书日更三件套」的第二步曾经写着 slug 'xhs-note'，而内置技能表里只有 'xhs-format'。
    // 步骤 schema 照过（slug 只要是字符串就合法），模板在市场里看着一切正常，
    // 但每次跑到第二步都停在「找不到技能」——开箱即用的第一条模板一直是坏的。
    // 内置技能的 slug 是全局唯一键，自建技能恒为 custom-* 不可能补上这个洞。
    const builtinSkillSlugs = new Set(BUILTIN_SKILLS.map((s) => s.slug));
    for (const w of BUILTIN_WORKFLOWS) {
      for (const step of w.steps) {
        if (step.kind !== 'skill') continue;
        expect(
          builtinSkillSlugs.has(step.slug),
          `内置模板 ${w.slug} 引用了不存在的内置技能「${step.slug}」（现有：${[...builtinSkillSlugs].join(' / ')}）`,
        ).toBe(true);
      }
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
    const r = await createTemplate(tenantId, MEMBER, { name: '我的流水线', persona: '要跑封面流水线时派我', steps: [{ kind: 'cover' }] });
    expect(r.ok).toBe(true);
    const list = await listTemplates(tenantId);
    const mine = list.find((t) => t.name === '我的流水线')!;
    expect(mine.installed).toBe(true);
    expect(mine.isBuiltin).toBe(false);
  });

  it('别的租户看不到我建的模板', async () => {
    await createTemplate(tenantId, MEMBER, { name: '私有流水线', persona: '本租户私用', steps: [{ kind: 'cover' }] });
    const other = await prisma.tenant.create({ data: { name: 'O', plan: 'free' } });
    const list = await listTemplates(other.id);
    expect(list.find((t) => t.name === '私有流水线')).toBeUndefined();
  });

  it('🔒 职责说明必填：没写的智能体 AI 永远不会在对话里派它', async () => {
    // AI 助手靠 persona 决定「这句话该派谁」（lib/agent/tools.ts）。允许空职责 =
    // 卖一个「装了但最短调用路永久关闭」的智能体，用户只会得出「不好用」。
    const r = await createTemplate(tenantId, MEMBER, { name: '哑巴智能体', steps: [{ kind: 'cover' }] });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('职责');
  });

  it('导入不受职责必填限制：别人分享的 JSON 缺职责照收，靠卡片警示引导补写', async () => {
    const shared = JSON.stringify({ beaconWorkflow: 1, name: '别人分享的', steps: [{ kind: 'cover' }] });
    const r = await importTemplate(tenantId, MEMBER, shared);
    expect(r.ok, '导入被职责必填拦下 —— 分享链路断了').toBe(true);
  });

  it('步骤不合法时给出人话错误，而不是一段 zod issue', async () => {
    const r = await createTemplate(tenantId, MEMBER, { name: 'X', persona: '测坏步骤', steps: [{ kind: 'skill' }] });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('步骤配置不对');
  });

  it('导出不带租户信息（分享出去的东西不该带上你是谁）', async () => {
    const created = await createTemplate(tenantId, MEMBER, { name: '可分享', persona: '分享样例', steps: [{ kind: 'cover' }] });
    const json = await exportTemplate(tenantId, (created as { id: string }).id);
    expect(json).toBeTruthy();
    expect(json!).not.toContain(tenantId);
    expect(json!).not.toContain(MEMBER);
  });

  it('🔒 分享一圈职责不丢：导出带 persona，导入原样收下', async () => {
    // 2026-09-01 查出导出/导入两头都在丢 persona：分享出去的智能体到对方手里
    // 全是「永远不会被对话派单的哑巴」，而两边界面都不报任何错。
    const created = await createTemplate(tenantId, MEMBER, { name: '带职责的', persona: '写周报时派我', steps: [{ kind: 'cover' }] });
    const json = await exportTemplate(tenantId, (created as { id: string }).id);
    expect(json!).toContain('写周报时派我');
    const other = await prisma.tenant.create({ data: { name: 'P', plan: 'free' } });
    const r = await importTemplate(other.id, MEMBER, json!);
    expect(r.ok).toBe(true);
    const got = await prisma.workflowTemplate.findUnique({ where: { id: (r as { id: string }).id } });
    expect(got!.persona).toBe('写周报时派我');
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
