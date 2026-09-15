import { describe, it, expect } from 'vitest';
import { composeHandoffGoal, deliverableSatisfied } from '@/lib/workflow/handoff';
import { BUILTIN_WORKFLOWS, ROLE_BOT_SLUGS } from '@/lib/workflow/builtin';
import { parseSteps, stepsSchema, stepLabel, stepCostly } from '@/lib/workflow/steps';
import { AGENT_TOOLS } from '@/lib/agent/tools';

// 固定角色接力（2026-09-11 P2）：子运行最多一层；权限不扩大；上一跳无合格产物则下一跳不启动。

describe('交付判定', () => {
  it('没跑完不算；answer 要有实质内容；产物类要真的登记过', () => {
    expect(deliverableSatisfied('answer', { status: 'failed', answer: 'x'.repeat(50) }, []).ok).toBe(false);
    expect(deliverableSatisfied('answer', { status: 'done', answer: '短' }, []).ok).toBe(false);
    expect(deliverableSatisfied('answer', { status: 'done', answer: '这是一段足够长的交付说明，够二十个字了吧应该够了' }, []).ok).toBe(true);
    expect(deliverableSatisfied('draft', { status: 'done', answer: '' }, [{ kind: 'topic', refId: 't' }]).ok).toBe(false);
    const r = deliverableSatisfied('draft', { status: 'done', answer: '' }, [{ kind: 'draft', refId: 'd1' }]);
    expect(r.ok).toBe(true);
    expect(r.draftId).toBe('d1');
    expect(deliverableSatisfied('topic', { status: 'done', answer: '' }, [{ kind: 'topic', refId: 't' }]).ok).toBe(true);
  });
  it('上一跳的交付原样进下一跳的目标', () => {
    const g = composeHandoffGoal({ goal: '写稿' }, { draftId: 'd1', briefs: [{ title: '情报', text: '热点 A' }] });
    expect(g).toContain('d1');
    expect(g).toContain('热点 A');
    expect(g).toContain('read_draft');
  });
});

describe('三条内置接力模板', () => {
  const relays = BUILTIN_WORKFLOWS.filter((w) => w.category === 'relay');
  it('有三条，全是流水线，每一跳都指向一个真实存在的职能 bot', () => {
    expect(relays).toHaveLength(3);
    for (const r of relays) {
      expect(r.mode ?? 'pipeline').toBe('pipeline');
      const steps = parseSteps(JSON.stringify(r.steps));
      expect(steps.length).toBeGreaterThanOrEqual(2);
      for (const s of steps) {
        expect(s.kind).toBe('handoff');
        if (s.kind === 'handoff') {
          expect(ROLE_BOT_SLUGS, `${r.slug} 的一跳指向了不存在的 bot ${s.bot}`).toContain(s.bot);
          expect(s.maxCalls).toBeGreaterThan(0);
          expect(stepLabel(s)).toContain(s.bot);
          expect(stepCostly(s)).toBe(true);
        }
      }
    }
  });
  it('🔒 发布不进接力：没有一跳把活派给发布官（建发布计划要人点头，后台没人在场）', () => {
    for (const r of relays) for (const s of r.steps) if (s.kind === 'handoff') expect(s.bot).not.toBe('bot-publisher');
  });
  it('🔒 只嵌一层：职能 bot 的白名单里没有 run_agent，孙运行派不出来', () => {
    const bots = BUILTIN_WORKFLOWS.filter((w) => ROLE_BOT_SLUGS.includes(w.slug));
    for (const b of bots) expect(b.agentConfig?.tools ?? []).not.toContain('run_agent');
    expect(AGENT_TOOLS.some((t) => t.name === 'run_agent')).toBe(true);
  });
  it('步骤 schema 认识 handoff，且拒绝没有 bot/goal 的写法', () => {
    expect(stepsSchema.safeParse([{ kind: 'handoff', bot: 'bot-topic', goal: '选题' }]).success).toBe(true);
    expect(stepsSchema.safeParse([{ kind: 'handoff', goal: '选题' }]).success).toBe(false);
  });
});
