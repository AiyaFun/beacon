import { describe, it, expect } from 'vitest';
import { normalizeHotFit } from '@/lib/topic/combine';

// 热点结合分析此前只判 `angles` 存不存在就整包放行。模型返回的是「合法 JSON 但形状不对」时
// （angles 是字符串数组、production 是对象、risk 是对象），前端 .map() / JSX 渲染当场炸。
describe('normalizeHotFit · LLM 返回结构运行时收口', () => {
  it('形状正确的返回原样通过，并裁到 4 条切入角 / 6 条建议', () => {
    const r = normalizeHotFit(
      {
        fit: 77,
        verdict: '值得做',
        angles: Array.from({ length: 6 }, (_, i) => ({ angle: `角${i}`, why: `因${i}` })),
        production: Array.from({ length: 8 }, (_, i) => `建议${i}`),
        risk: '注意版权',
      },
      '热点A',
    );
    expect(r).not.toBeNull();
    expect(r!.fit).toBe(77);
    expect(r!.verdict).toBe('值得做');
    expect(r!.angles).toHaveLength(4);
    expect(r!.production).toHaveLength(6);
    expect(r!.risk).toBe('注意版权');
    expect(r!.hotTitle).toBe('热点A');
  });

  it('angles 是字符串数组 → 没有一条合法切入角 → 返回 null 交给启发式兜底', () => {
    expect(normalizeHotFit({ angles: ['只是文本', '又一条'] }, 'x')).toBeNull();
  });

  it('angles 里混着非法项：只保留 angle 为非空字符串的对象', () => {
    const r = normalizeHotFit(
      { angles: ['文本', null, { angle: '', why: 'x' }, { angle: '合法', why: 42 }, { angle: '  也合法  ' }] },
      'x',
    );
    expect(r!.angles).toEqual([
      { angle: '合法', why: '' },
      { angle: '也合法', why: '' },
    ]);
  });

  it('production 是对象 / 含非字符串项 → 过滤成字符串数组，绝不把非数组交给 .map()', () => {
    expect(normalizeHotFit({ angles: [{ angle: 'a' }], production: {} }, 'x')!.production).toEqual([]);
    expect(normalizeHotFit({ angles: [{ angle: 'a' }], production: ['ok', 1, null, { x: 1 }, ' '] }, 'x')!.production).toEqual(['ok']);
  });

  it('risk / verdict 是对象或缺失 → 换成缺省句而不是把对象塞进 JSX', () => {
    const r = normalizeHotFit({ angles: [{ angle: 'a' }], risk: { level: 'high' }, verdict: ['x'] }, 'x')!;
    expect(typeof r.risk).toBe('string');
    expect(r.risk.length).toBeGreaterThan(0);
    expect(typeof r.verdict).toBe('string');
    expect(r.verdict.length).toBeGreaterThan(0);
  });

  it('fit 越界 / 非数字 → 夹到 0-100 或用缺省 60', () => {
    expect(normalizeHotFit({ angles: [{ angle: 'a' }], fit: 999 }, 'x')!.fit).toBe(100);
    expect(normalizeHotFit({ angles: [{ angle: 'a' }], fit: -5 }, 'x')!.fit).toBe(0);
    expect(normalizeHotFit({ angles: [{ angle: 'a' }], fit: '82' }, 'x')!.fit).toBe(82);
    expect(normalizeHotFit({ angles: [{ angle: 'a' }], fit: 'abc' }, 'x')!.fit).toBe(60);
  });

  it('顶层不是对象（数组 / null / 字符串）→ null', () => {
    expect(normalizeHotFit(null, 'x')).toBeNull();
    expect(normalizeHotFit([{ angle: 'a' }], 'x')).toBeNull();
    expect(normalizeHotFit('{"angles":[]}', 'x')).toBeNull();
    expect(normalizeHotFit({}, 'x')).toBeNull();
  });
});
