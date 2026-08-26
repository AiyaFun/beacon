import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stepSchema } from '@/lib/workflow/steps';
import { BUILTIN_WORKFLOWS } from '@/lib/workflow/builtin';

describe('模板写了给哪个平台写，就得真按那个平台写', () => {
  // 【真机撞到的】WorkflowStep 一直有 platform 字段、模板也填了、UI 也渲染了，
  // 但 run.ts 调 resolveDraftTarget 时**没把它传下去**，于是一律退回人设主平台
  // （人设没填 = douyin）。后果不只是标签错：初稿提示词第一句是
  // 「为「抖音」平台创作一篇初稿文案」，「小红书日更三件套」的第一步
  // 写出来的是一篇抖音文案，第二步才被小红书排版技能接手。
  it('run.ts 把 step.platform 传进 resolveDraftTarget', () => {
    const src = readFileSync(join(process.cwd(), 'lib/workflow/run.ts'), 'utf8');
    const call = src.slice(src.indexOf('await resolveDraftTarget({'));
    const args = call.slice(0, call.indexOf('});'));
    expect(args).toMatch(/platform:\s*step\.platform/);
  });

  it('新建草稿时用调用方指定的平台，但不覆盖已有草稿的平台', () => {
    const src = readFileSync(join(process.cwd(), 'lib/studio/draft-core.ts'), 'utf8');
    const line = src.slice(src.indexOf('const platform = ('), src.indexOf('as PlatformKey;', src.indexOf('const platform = (')));
    // 顺序是硬要求：已有草稿 > 调用方指定 > 人设默认。
    // 反过来的话，工作流会把用户在创作工坊里已经定成公众号的稿子改掉。
    expect(line.indexOf('draft?.platform')).toBeGreaterThanOrEqual(0);
    expect(line.indexOf('draft?.platform')).toBeLessThan(line.indexOf('input.platform'));
    expect(line.indexOf('input.platform')).toBeLessThan(line.indexOf('persona.platforms[0]'));
  });

  it('平台名写错会被挡下来，而不是静默退回抖音', () => {
    expect(stepSchema.safeParse({ kind: 'draft', platform: 'xiaohongshu' }).success).toBe(true);
    expect(stepSchema.safeParse({ kind: 'draft', platform: 'xhss' }).success).toBe(false);
    expect(stepSchema.safeParse({ kind: 'publish', platforms: ['wechat'] }).success).toBe(true);
    expect(stepSchema.safeParse({ kind: 'publish', platforms: ['wxpub'] }).success).toBe(false);
  });

  it('内置模板里写的平台名全是系统认识的', () => {
    for (const w of BUILTIN_WORKFLOWS) {
      for (const st of w.steps) {
        const r = stepSchema.safeParse(st);
        expect(r.success, `${w.slug} 的步骤 ${JSON.stringify(st)} 不合法`).toBe(true);
      }
    }
  });
});
