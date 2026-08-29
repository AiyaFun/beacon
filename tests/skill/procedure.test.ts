import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toolTraceOf, renderGuidance } from '@/lib/skill/distill';
import type { ChatMessage } from '@/lib/llm/types';

// 流程技能（2026-08-29）：把跑通的一次任务提炼成可复用做法。
//
// 三条硬规矩全在这里钉死。它们的共同点是——**照直觉写都会出事，而且不会报错**：
//   ① 步骤让模型总结 → 它会编出没调过的工具，那份「步骤」将来是执行指引
//   ② 白名单照抄用户当时的权限 → 技能变成提权通道
//   ③ 自己写步骤执行器 → 把授权三档、预算闸、确认闸全部重做一遍，必漏

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const src = read('lib/skill/distill.ts');

describe('工具轨迹只认真实调用', () => {
  it('按首次出现排序、去重', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: '采一轮竞对' },
      { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'list_competitors', arguments: '{}' }] },
      { role: 'tool', content: '[]', toolCallId: '1' },
      { role: 'assistant', content: '', toolCalls: [
        { id: '2', name: 'collect_competitor', arguments: '{}' },
        { id: '3', name: 'list_competitors', arguments: '{}' },
      ] },
      { role: 'assistant', content: '好了' },
    ];
    expect(toolTraceOf(msgs)).toEqual(['list_competitors', 'collect_competitor']);
  });

  it('没调过工具就是空轨迹（纯聊天不该被存成技能）', () => {
    expect(toolTraceOf([{ role: 'assistant', content: '你好' }])).toEqual([]);
  });
});

describe('规矩①：步骤不许由模型编', () => {
  it('步骤以真实轨迹为准，模型只贡献 why', () => {
    // 这一行是整条规矩的落点：trace.map 而不是 ann.steps
    expect(src).toContain('const steps: ProcedureStep[] = trace.map((tool) => ({ tool, why: whyOf.get(tool) ?? \'\' }));');
  });

  it('没调过工具直接拒绝提炼', () => {
    expect(src).toContain("if (trace.length === 0) return { ok: false, error: '这次没调用任何工具，没有做法可提炼' };");
  });

  it('示例模型的产出不当真', () => {
    expect(src).toContain('if (!r.mocked)');
  });
});

describe('规矩②：绝不扩权', () => {
  it('白名单存的是实际用过的工具（天然是来源运行权限的子集）', () => {
    expect(src).toContain('toolAllowlist: JSON.stringify(trace)');
  });

  it('重放时再与当前用户权限求一次交集', () => {
    expect(src).toContain('const mine = new Set(availableTools(role, disabledTools).map((t) => t.name));');
    expect(src).toContain('const allow = wanted.filter((t) => mine.has(t));');
  });

  it('交集为空时拒绝跑，而不是放开跑', () => {
    // 若这里写成「交集空 = 不限制」，技能就成了提权通道
    expect(src).toContain("return { ok: false, error: '这个技能用到的工具你都没有权限，跑不了' };");
  });
});

describe('规矩③：重放不另起执行引擎', () => {
  it('走 startAgentRun，把步骤当指引传进去', () => {
    expect(src).toContain('const turn = await startAgentRun(ctx, skill.goal, {');
    expect(src).toContain('agentSystemPrompt: renderGuidance(skill.name, steps),');
  });

  it('没有自己实现的步骤循环（那会绕过所有闸门）', () => {
    // 只要出现「遍历 steps 逐个执行工具」的形状就是重做了执行引擎
    expect(src).not.toMatch(/for\s*\(.*of\s+steps\)[\s\S]{0,200}(executeCall|runTool|tool\.run)/);
  });

  it('指引是建议不是命令——现场变了要让模型自己调整', () => {
    expect(renderGuidance('采竞对', [{ tool: 'list_competitors', why: '先看有哪些' }]))
      .toContain('按实际情况调整');
  });
});

describe('落库与隔离', () => {
  it('两份 schema 都有 ProcedureSkill（只改一份 = 生产构建才报错）', () => {
    for (const f of ['prisma/schema.prisma', 'prisma/schema.postgres.prisma']) {
      expect(read(f), `${f} 缺 ProcedureSkill`).toContain('model ProcedureSkill');
    }
  });

  it('RLS 名单里有它（02-rls.sql 是权威，闸门按它比）', () => {
    expect(read('prisma/postgres/02-rls.sql')).toContain("'ProcedureSkill'");
  });

  it('删除按 workspaceId 圈定（跨工作区删不掉）', () => {
    expect(read('app/(app)/skills/procedure-actions.ts'))
      .toContain('where: { id: skillId, workspaceId: s.workspaceId }');
  });

  it('只有跑完的执行才给「存成技能」按钮', () => {
    expect(read('app/(app)/assistant/AgentPanel.tsx'))
      .toContain("{turn.status === 'done' && turn.mine && <SaveAsSkillButton runId={turn.runId} />}");
  });
});
