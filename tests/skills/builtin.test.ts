import { describe, it, expect } from 'vitest';
import { BUILTIN_SKILLS } from '@/prisma/system-data';
import { renderSkillTemplate } from '@/lib/skills/render';
import { SKILL_OUTPUT_KINDS } from '@/lib/skills';

// 内置技能模板的静态守卫。
//
// 【为什么值一个测试】这里曾有一个不会报错的真 bug：账号上下文（{{context}}）被接进了
// actRunSkill，而**五个内置技能模板一个都没用这个占位符**——于是每次运行技能都白查一次库、
// 白跑一次向量召回，产出的成品比初稿更像 AI 写的，且没有任何地方会红。
// 这条用例把「接了线就必须有人用」钉死。

describe('内置技能模板', () => {
  it('每个模板都吃到正文与账号上下文', () => {
    for (const s of BUILTIN_SKILLS) {
      expect(s.promptTemplate, `${s.slug} 缺 {{content}}`).toContain('{{content}}');
      expect(s.promptTemplate, `${s.slug} 缺 {{context}}（账号风格样本/口头禅/素材进不去）`).toContain('{{context}}');
      expect(s.promptTemplate, `${s.slug} 缺 {{brief}}（参数卡失效）`).toContain('{{brief}}');
    }
  });

  it('每个文本模板都带去 AI 味的语感要求', () => {
    for (const s of BUILTIN_SKILLS) {
      // 图像技能（AI 封面）产出的是图不是文，语感/去套话规则不适用——它的模板只负责抽封面要素。
      if (s.outputKind === 'image') continue;
      expect(s.promptTemplate, `${s.slug} 没有语感要求`).toContain('套话');
    }
  });

  it('slug 唯一、输出形态合法、字段齐全', () => {
    const slugs = BUILTIN_SKILLS.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of BUILTIN_SKILLS) {
      expect(SKILL_OUTPUT_KINDS).toContain(s.outputKind as (typeof SKILL_OUTPUT_KINDS)[number]);
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.platform.length).toBeGreaterThan(0);
    }
  });

  it('渲染后不残留任何占位符（模板里没有拼错的 {{xxx}}）', () => {
    for (const s of BUILTIN_SKILLS) {
      const out = renderSkillTemplate(s.promptTemplate, {
        content: 'C', title: 'T', persona: 'P', context: 'X', brief: 'B',
      });
      expect(out, `${s.slug} 有未知占位符`).not.toMatch(/\{\{\s*\w+\s*\}\}/);
    }
  });
});
