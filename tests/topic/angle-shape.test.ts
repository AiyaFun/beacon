import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PersonaCard } from '@/lib/persona';

// 精排 prompt 里的「答案结构约束」，以及它落回 ScoredTopic 的规矩。
//
// 要守的东西分三层：
//   1. prompt 里确实有形状要求，且五种形状各自的硬判据（对比维度/条目数/步骤边界…）都在；
//   2. 它不许和「关联度闸」打架——顺序在关联度之后，且 relevant=false 时不再逼它纠结结构；
//   3. 「优先沿用账号擅长的结构」这句只在真有指纹/基线时注入（同 evidence 那条的教训：
//      无条件注入 = 模型凭空断言账号擅长什么）。
//
// 这里 stub 的是 LLM 网关，不是 prisma：要看的是「我们发出去的 system prompt 长什么样」
// 和「回包被怎么收口」，两头都不需要库。

vi.mock('@/lib/llm/gateway', () => ({
  llmComplete: vi.fn(async () => ({
    text: JSON.stringify({
      relevant: true,
      angleShape: 'comparison',
      angle: '对比公立园 / 私立园 / 托育三类，按学费、接送成本、师生比三个维度算总账',
      scores: { traffic: 70, personaFit: 70, cost: 60, monetization: 50, compliance: 90, differentiation: 70 },
      rationale: '与人设方向一致。',
    }),
    provider: 'real-x',
    model: 'x-1',
    mocked: false,
  })),
}));

import {
  finePrompt,
  normalizeAngleShape,
  ANGLE_SHAPES,
  ANGLE_SHAPE_LABELS,
} from '@/lib/topic/scoring';
import { llmComplete } from '@/lib/llm/gateway';

const persona: PersonaCard = {
  identity: '前端工程师',
  audience: '前端新人',
  valueProp: '把复杂工具链讲明白',
  niche: '前端工程化',
  canDo: ['构建优化'],
  cantDo: [],
  tone: '干货',
  platforms: ['bilibili'],
} as PersonaCard;

const cand = { title: '前端工程化实践', heat: 0.5, sourceType: 'hot' as const };

const lastSystem = () => {
  const calls = vi.mocked(llmComplete).mock.calls;
  return (calls[calls.length - 1][2] as { role: string; content: string }[])[0].content;
};

/** 让下一次（且只有下一次）精排拿到指定回包 */
const replyOnce = (obj: unknown) =>
  vi.mocked(llmComplete).mockResolvedValueOnce({
    text: typeof obj === 'string' ? obj : JSON.stringify(obj),
    provider: 'real-x',
    model: 'x-1',
    mocked: false,
  });

beforeEach(() => {
  vi.mocked(llmComplete).mockClear();
});

describe('答案结构约束 · prompt 侧', () => {
  it('五种形状连同各自的硬判据都进了 system prompt', async () => {
    await finePrompt(null, cand, persona, '');
    const system = lastSystem();
    for (const s of ANGLE_SHAPES) {
      expect(system, `缺形状：${s}`).toContain(`${ANGLE_SHAPE_LABELS[s]}（angleShape="${s}"）`);
    }
    // 判据本身也要在——只列出分类名而不说「对比型必须给维度」，等于什么都没约束
    expect(system).toContain('至少两个对比维度');
    expect(system).toContain('必须给出条目数');
    expect(system).toContain('从哪一步开始、到哪一步为止');
    expect(system).toContain('它是什么，更要说清它不是什么');
    expect(system).toContain('结论方向');
    // 空转式角度被点名否掉
    expect(system).toContain('「从XX角度切入」');
  });

  it('🔒 形状清单由 ANGLE_SHAPES 生成，不许在 prompt 里另抄一份枚举', async () => {
    // 数条目数而不是逐个 includes：手抄的那份一旦和常量条数不一致（少一个、多一个），
    // 这里当场红。逐个 includes 做不到这件事——它的循环本身就来自常量。
    await finePrompt(null, cand, persona, '');
    const bullets = lastSystem().match(/（angleShape="/g) ?? [];
    expect(bullets).toHaveLength(ANGLE_SHAPES.length);
    // 输出 JSON 的取值示例也必须覆盖全集 + other
    expect(lastSystem()).toContain(`"angleShape":"${[...ANGLE_SHAPES, 'other'].join('|')}"`);
  });

  it('🔒 结构约束排在关联度闸之后（顺序反了就是又一条「逼模型硬造」的压力）', async () => {
    await finePrompt(null, cand, persona, '');
    const system = lastSystem();
    const gate = system.indexOf('relevant=false 是被鼓励的正确答案');
    const shape = system.indexOf('先判定这个角度属于下面哪一种答案结构');
    expect(gate).toBeGreaterThan(-1);
    expect(shape).toBeGreaterThan(-1);
    expect(shape).toBeGreaterThan(gate);
  });

  it('🔒 relevant=false 时明确豁免结构判定，并留了 other 这个退出通道', async () => {
    await finePrompt(null, cand, persona, '');
    const system = lastSystem();
    expect(system).toContain('relevant=false 时不必判定结构');
    expect(system).toContain('不属于以上任何一种，angleShape 填 "other"');
  });
});

describe('答案结构约束 · 条件注入（无指纹/基线时必须整条消失）', () => {
  it('有 extraContext → 注入「优先沿用账号已验证的结构」', async () => {
    await finePrompt(null, cand, persona, '', '风格指纹：擅长清单型拆解\n数据基线：B站均播 1.2 万');
    expect(lastSystem()).toContain('优先沿用那一种');
  });

  it('🔒 无 extraContext → 这句一个字都不许出现（否则模型会凭空断言账号擅长某种结构）', async () => {
    await finePrompt(null, cand, persona, '');
    const system = lastSystem();
    expect(system).not.toContain('优先沿用那一种');
    expect(system).not.toContain('擅长某种结构');
    // 但形状要求本身照常在——条件注入的是「偏好」，不是整段约束
    expect(system).toContain('先判定这个角度属于下面哪一种答案结构');
  });

  it('🔒 extraContext 只有空白字符也算没有', async () => {
    await finePrompt(null, cand, persona, '', '   \n  ');
    expect(lastSystem()).not.toContain('优先沿用那一种');
  });
});

describe('答案结构约束 · 回包收口', () => {
  it('模型给了合法 slug → 原样落到 ScoredTopic.angleShape', async () => {
    const s = await finePrompt(null, cand, persona, '');
    expect(s.angleShape).toBe('comparison');
  });

  it('模型改口说中文标签 → 也认，归一到 slug', async () => {
    replyOnce({ relevant: true, angleShape: '清单型', angle: '拆成 6 个坑', scores: { traffic: 1, personaFit: 1, cost: 1, monetization: 1, compliance: 1, differentiation: 1 }, rationale: 'x' });
    const s = await finePrompt(null, cand, persona, '');
    expect(s.angleShape).toBe('list');
  });

  it('🔒 other / 集合外的值 / 字段缺席 → 一律 undefined，绝不落到某个默认形状', async () => {
    for (const raw of ['other', '其他', '叙事型', '', 42, null]) {
      replyOnce({ relevant: true, angleShape: raw, angle: '某个角度', scores: { traffic: 1, personaFit: 1, cost: 1, monetization: 1, compliance: 1, differentiation: 1 }, rationale: 'x' });
      const s = await finePrompt(null, cand, persona, '');
      expect(s.angleShape, `不该认的值被认了：${String(raw)}`).toBeUndefined();
    }
    // 整个字段缺席（老模型 / 不认识这个 schema）
    replyOnce({ relevant: true, angle: '某个角度', scores: { traffic: 1, personaFit: 1, cost: 1, monetization: 1, compliance: 1, differentiation: 1 }, rationale: 'x' });
    const s = await finePrompt(null, cand, persona, '');
    expect(s.angleShape).toBeUndefined();
    expect(s.angle).toBe('某个角度'); // 少一个字段不许影响其余字段
  });

  it('🔒 relevant=false 时丢掉结构判定（被否掉的题不该带一个像模像样的形状标签）', async () => {
    replyOnce({ relevant: false, angleShape: 'comparison', angle: '硬凑的角度', scores: { traffic: 1, personaFit: 1, cost: 1, monetization: 1, compliance: 1, differentiation: 1 }, rationale: '与账号无关' });
    const s = await finePrompt(null, cand, persona, '');
    expect(s.relevant).toBe(false);
    expect(s.angleShape).toBeUndefined();
  });

  it('🔒 angle 缺席走占位文案时不贴形状标签（不给空壳盖章）', async () => {
    replyOnce({ relevant: true, angleShape: 'list', scores: { traffic: 1, personaFit: 1, cost: 1, monetization: 1, compliance: 1, differentiation: 1 }, rationale: 'x' });
    const s = await finePrompt(null, cand, persona, '');
    expect(s.angle).toBe('差异化切入角（待补充）');
    expect(s.angleShape).toBeUndefined();
  });

  it('🔒 JSON 整个解析失败 → 不抛、照常回默认分，angleShape 缺席', async () => {
    replyOnce('抱歉，我无法以 JSON 格式回答这个问题。');
    const s = await finePrompt(null, cand, persona, '');
    expect(s.scores.traffic).toBe(60);
    expect(s.rationale).toContain('默认分');
    expect(s.angleShape).toBeUndefined();
  });
});

// 「单条重新评分」是 finePrompt 的第二个调用方，且它是 update 不是 create。
// 这条只能做源码级守卫：actRescoreTopic 要真跑得起 session + RBAC + 账号上下文，
// 成本远高于它能证明的东西。守的是一个很具体的洞——
// update 里 `undefined` 的语义是「这一列别动」，漏写或写成 `scored.angleShape` 都会让
// 重评分之后旧的形状标签留在库里，配着一个已经换掉的角度。
describe('🔒 单条重新评分也要覆盖 angleShape（源码级）', () => {
  it('actRescoreTopic 的 update 里写了 angleShape，且显式 ?? null', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../app/(app)/topics/actions.ts'),
      'utf8',
    );
    // 只看 actRescoreTopic 这一段，别被文件里别处的 topicIdea.update 蒙混过去
    const fn = src.slice(src.indexOf('export async function actRescoreTopic'));
    const body = fn.slice(0, fn.indexOf('\nexport ') === -1 ? fn.length : fn.indexOf('\nexport '));
    expect(body).toContain('prisma.topicIdea.update');
    expect(body).toMatch(/angleShape:\s*scored\.angleShape\s*\?\?\s*null/);
  });
});

describe('normalizeAngleShape 直测', () => {
  it('大小写与首尾空白不敏感', () => {
    expect(normalizeAngleShape(' Comparison ')).toBe('comparison');
    expect(normalizeAngleShape('LIST')).toBe('list');
    expect(normalizeAngleShape(' 流程型 ')).toBe('process');
  });

  it('非字符串一律 undefined', () => {
    for (const v of [undefined, null, 0, {}, [], true]) expect(normalizeAngleShape(v)).toBeUndefined();
  });

  it('全集都能自证：slug 与中文标签都能归一回自己', () => {
    for (const s of ANGLE_SHAPES) {
      expect(normalizeAngleShape(s)).toBe(s);
      expect(normalizeAngleShape(ANGLE_SHAPE_LABELS[s])).toBe(s);
    }
  });
});
