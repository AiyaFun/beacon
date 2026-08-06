import { describe, it, expect } from 'vitest';
import { readPersona, emptyPersona } from '@/lib/persona';

// 根因回归（分片1·问题①）：库里 personaCard 默认值是 '{}'——合法 JSON，
// 旧实现 parseJson('{}') 成功、不走 fallback，返回残缺对象（canDo/cantDo/platforms 全 undefined），
// 下游 personaPromptBlock 的 `p.canDo.join` 对 undefined 直接 TypeError，新用户点「生成今日推荐」全程 500。
// 修法：合并到 emptyPersona() 之上，字段永远齐全（数组默认 []）。

describe('readPersona · 空/半张卡都得到字段齐全的人设', () => {
  it('库默认 "{}" → 数组字段默认 []，下游裸调用 .join 不再崩', () => {
    const p = readPersona('{}');
    expect(p.canDo).toEqual([]);
    expect(p.cantDo).toEqual([]);
    expect(p.platforms).toEqual([]);
    expect(() => p.canDo.join('、')).not.toThrow();
  });

  it('半张卡 → 已填字段保留，缺的补默认', () => {
    const p = readPersona(JSON.stringify({ identity: '博主', canDo: ['选题拆解'] }));
    expect(p.identity).toBe('博主');
    expect(p.canDo).toEqual(['选题拆解']);
    expect(p.cantDo).toEqual([]);
    expect(p.platforms).toEqual([]);
    expect(p.audience).toBe('');
  });

  it('非法 JSON / 空串 → 完整的空人设，不抛', () => {
    expect(readPersona('not json at all')).toEqual(emptyPersona());
    expect(readPersona('')).toEqual(emptyPersona());
  });

  it('JSON 是 null / 数组 / 数字等非对象 → 完整的空人设，不抛', () => {
    expect(readPersona('null')).toEqual(emptyPersona());
    expect(readPersona('[1,2,3]')).toEqual(emptyPersona());
    expect(() => readPersona('42')).not.toThrow();
    expect(readPersona('42')).toEqual(emptyPersona());
  });

  it('完整卡片原样透出', () => {
    const full = {
      identity: 'a', audience: 'b', valueProp: 'c',
      canDo: ['x'], cantDo: ['y'], tone: 't', platforms: ['douyin'], niche: 'n',
    };
    expect(readPersona(JSON.stringify(full))).toEqual(full);
  });
});
