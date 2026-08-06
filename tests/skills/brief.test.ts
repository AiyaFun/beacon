import { describe, it, expect } from 'vitest';
import { buildSkillBriefBlock } from '@/lib/skills/brief';

// 参数卡 → prompt 块。两条约定：
// 1) 什么都没选就返回空串（与账号上下文各块同一约定：绝不注入占位噪声）；
// 2) 「保持/不限」这类默认档不写进 prompt——写了等于给模型一个它本来没有的默认行为。

describe('技能参数卡', () => {
  it('未传参数返回空串', () => {
    expect(buildSkillBriefBlock(undefined, [])).toBe('');
  });

  it('全是默认档也返回空串', () => {
    expect(buildSkillBriefBlock({ length: 'keep', tone: 'keep' }, [])).toBe('');
  });

  it('篇幅/语气/平台各自成行', () => {
    const b = buildSkillBriefBlock({ platform: 'douyin', length: 'short', tone: 'punchy' }, []);
    expect(b).toContain('抖音');
    expect(b).toContain('更短');
    expect(b).toContain('更冲');
  });

  it('点名的素材写进 prompt，并声明优先于账号素材库', () => {
    const b = buildSkillBriefBlock({ materialIds: ['m1'] }, [{ type: 'experience', content: '三个月增肌十斤' }]);
    expect(b).toContain('三个月增肌十斤');
    expect(b).toContain('优先');
  });

  it('用户补充要求有长度上限，不给注入超长内容的机会', () => {
    const b = buildSkillBriefBlock({ extra: 'x'.repeat(500) }, []);
    expect(b.length).toBeLessThan(400);
  });
});
