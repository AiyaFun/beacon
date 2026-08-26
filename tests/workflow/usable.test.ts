import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { BUILTIN_WORKFLOWS } from '@/lib/workflow/builtin';
import { BUILTIN_SKILLS } from '@/prisma/system-data';
import { STEP_KINDS } from '@/lib/workflow/steps';
import { ensureBuiltinTemplates, listTemplates, preinstallBuiltinTemplates } from '@/lib/workflow/market';

// 「任务台上已有的智能体和技能，到底能不能用」——这一份就是那次盘查的固化。
//
// 盘查当时查出两件事，都属于「界面上有、点下去不动」那一类：
//   ① **全库 WorkflowInstall 一行都没有**：技能有预装（建人设时按平台装上），
//      智能体没有。于是产品自带的三条模板对每个用户都是「看得见、用不上」，
//      而 AI 的 list_agents 只列已装的，它会永远回答「这个团队还没装任何智能体」。
//   ② **两条内置智能体对新用户必然第一步失败**：它们从「最高分选题」起稿，
//      而新账号一条选题都没有。失败信息指了路，但用户是花了一次点击才知道的。

let tenantId: string;

beforeEach(async () => {
  await prisma.workflowInstall.deleteMany();
  await prisma.workflowTemplate.deleteMany();
  const t = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  tenantId = t.id;
});

describe('内置智能体：装上就能用', () => {
  it('预装之后，三条内置模板对 AI 都是可派的', async () => {
    const n = await preinstallBuiltinTemplates(tenantId);
    expect(n).toBe(BUILTIN_WORKFLOWS.length);

    const list = await listTemplates(tenantId);
    const installed = list.filter((t) => t.installed);
    // 不预装的话这里是 0——而 list_agents 只列已装的，AI 一个都派不动
    expect(installed.length).toBe(BUILTIN_WORKFLOWS.length);
  });

  it('已经装过（或手工卸载过）就不再自作主张装回去', async () => {
    await preinstallBuiltinTemplates(tenantId);
    // 用户手工卸载一条
    const one = await prisma.workflowInstall.findFirstOrThrow({ where: { tenantId } });
    await prisma.workflowInstall.update({ where: { id: one.id }, data: { enabled: false } });

    const again = await preinstallBuiltinTemplates(tenantId);
    expect(again, '第二次不该再装——那是替用户做决定').toBe(0);
    const still = await prisma.workflowInstall.findUniqueOrThrow({ where: { id: one.id } });
    expect(still.enabled, '用户卸载的又被装回去了').toBe(false);
  });

  it('建人设那条路真的会调它（不调的话这个机制等于不存在）', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.resolve(process.cwd(), 'app/(app)/persona/actions.ts'), 'utf8');
    // 【断言「真的调了」而不是「这个名字出现过」】第一版写的是 /preinstallBuiltinTemplates/，
    // 而 `const { preinstallBuiltinTemplates } = await import(...)` 那一行也含这个名字——
    // 把调用删掉、只留 import，守卫照样绿。那是「只验存在一处」那种假绿。
    expect(src, '建人设时装了技能却没装智能体——两边口径不对称')
      .toMatch(/await\s+preinstallBuiltinTemplates\(/);
    expect(src).toMatch(/await\s+preinstallSkillsForPlatforms\(/);
  });
});

describe('内置智能体：前置条件要在**点之前**说', () => {
  it('从选题起稿的那几条，都声明了前置条件', async () => {
    // 判据是「第一步是 draft 且前面没有 topic 步」——那种模板必然要求先有选题
    for (const w of BUILTIN_WORKFLOWS) {
      const firstTopic = w.steps.findIndex((s) => s.kind === 'topic');
      const firstDraft = w.steps.findIndex((s) => s.kind === 'draft');
      const needsExistingTopic = firstDraft >= 0 && (firstTopic < 0 || firstTopic > firstDraft);
      if (needsExistingTopic) {
        expect(w.requires, `${w.slug} 从已有选题起稿，却没写前置条件——用户会点完才知道跑不了`).toBeTruthy();
      }
    }
  });

  it('自己会先跑选题的那条，不该吓唬用户', async () => {
    const selfSufficient = BUILTIN_WORKFLOWS.find((w) => w.slug === 'topic-to-carousel');
    expect(selfSufficient?.steps[0].kind, '这条应当自己先跑一轮选题').toBe('topic');
    expect(selfSufficient?.requires ?? '', '它没有前置条件，别写').toBe('');
  });

  it('前置条件要落到库里并带给界面与 AI', async () => {
    await ensureBuiltinTemplates();
    const list = await listTemplates(tenantId);
    const daily = list.find((t) => t.slug === 'daily-xhs');
    expect(daily?.requires, '没落库 = 界面与 AI 都看不到').toBeTruthy();
    expect(daily?.requires).toContain('选题');
  });

  it('存量行也要补上（只写 create 不写 update 的话永远补不上）', async () => {
    await ensureBuiltinTemplates();
    // 模拟一条「加这个字段之前就存在」的旧行
    await prisma.workflowTemplate.updateMany({ where: { slug: 'daily-xhs' }, data: { requires: '' } });
    await ensureBuiltinTemplates();
    const row = await prisma.workflowTemplate.findFirstOrThrow({ where: { slug: 'daily-xhs' } });
    expect(row.requires, 'update 分支没带 requires——与当初 persona 栽的是同一个跟头').toBeTruthy();
  });
});

describe('内置技能与智能体：结构上真的能跑', () => {
  it('每条内置技能的模板都含 {{content}}（没有它技能无处安放输入）', () => {
    for (const s of BUILTIN_SKILLS) {
      expect(/\{\{\s*content\s*\}\}/.test(s.promptTemplate), `${s.slug} 的模板没有 {{content}}`).toBe(true);
    }
  });

  it('每条内置智能体的步骤类型都在白名单里', () => {
    for (const w of BUILTIN_WORKFLOWS) {
      for (const st of w.steps) {
        expect((STEP_KINDS as readonly string[]).includes(st.kind), `${w.slug} 有未知步骤 ${st.kind}`).toBe(true);
      }
    }
  });

  it('每条内置智能体都写了职责说明（空着 AI 永远派不动它）', () => {
    for (const w of BUILTIN_WORKFLOWS) {
      expect(w.persona, `${w.slug} 没写 persona`).toBeTruthy();
    }
  });
});
