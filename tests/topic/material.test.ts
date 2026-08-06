import { describe, it, expect } from 'vitest';
import { bestMaterialFor, enrichWithMaterial } from '@/lib/topic/sources/material';
import type { MaterialEntry } from '@/lib/material';
import type { Candidate } from '@/lib/topic/scoring';

// 素材唤醒（lib/topic/sources/material.ts）。
// 素材是差异化的唯一不可复制来源，所以这里锁两件事：
// **不改来源只追加证据**（它回答「你能怎么做得不一样」，不是「为什么推它」），
// 以及**口头禅不参与**（那是语气资产，拿它论证选题等于把风格当论据）。

const mat = (over: Partial<MaterialEntry> = {}): MaterialEntry => ({
  type: 'experience',
  content: '我在第一家公司做过三年前端构建工具链，踩过最深的坑是把 webpack 配置当成了业务代码在维护。',
  tags: ['前端工程化'],
  ...over,
});

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  title: '前端构建优化又火了',
  heat: 0.8,
  sourceType: 'douyin',
  ...over,
});

describe('bestMaterialFor 匹配', () => {
  it('标签命中即算相关（标签是用户自己打的主题词）', () => {
    const m = mat({ content: '完全无关的一段文字内容', tags: ['前端构建优化'] });
    expect(bestMaterialFor('前端构建优化又火了', [m])).toBeTruthy();
  });

  it('正文共享 ≥2 个 2-gram 也算相关', () => {
    const m = mat({ tags: [] });
    expect(bestMaterialFor('前端构建工具链怎么选', [m])).toBeTruthy();
  });

  it('标签命中优先于正文命中', () => {
    const byTag = mat({ content: '毫不相干的内容', tags: ['前端构建优化'] });
    const byBody = mat({ content: '前端构建优化的一点经验', tags: [] });
    const hit = bestMaterialFor('前端构建优化又火了', [byBody, byTag]);
    expect(hit!.material.tags).toEqual(['前端构建优化']);
  });

  it('毫不相关 → null', () => {
    expect(bestMaterialFor('明星八卦大瓜', [mat()])).toBeNull();
  });

  it('口头禅不参与：语气资产不是选题依据', () => {
    const c = mat({ type: 'catchphrase', content: '前端构建优化这件事我常说：先跑通再优化', tags: ['前端构建优化'] });
    expect(bestMaterialFor('前端构建优化又火了', [c])).toBeNull();
  });

  it('单字标签不算命中（"我""的"这类会到处误命中）', () => {
    const m = mat({ content: '毫不相干的内容', tags: ['我'] });
    expect(bestMaterialFor('我今天很开心', [m])).toBeNull();
  });
});

describe('enrichWithMaterial 追加证据', () => {
  it('命中 → 追加一句「只有你能讲」，并带上素材摘要', () => {
    const [c] = enrichWithMaterial([cand()], [mat()]);
    expect(c.evidence).toContain('亲身经历');
    expect(c.evidence).toContain('webpack');
    expect(c.evidence).toContain('只有你能把这段讲出来');
  });

  it('**不改来源、不改队列**——它回答的是「怎么做得不一样」，不是「为什么推它」', () => {
    const [c] = enrichWithMaterial([cand({ sourceType: 'gap', queue: 'today' })], [mat()]);
    expect(c.sourceType).toBe('gap');
    expect(c.queue).toBe('today');
  });

  it('已有证据 → 追加而非覆盖（两句都是事实，都该让用户看到）', () => {
    const [c] = enrichWithMaterial([cand({ evidence: '原有的抢跑证据。' })], [mat()]);
    expect(c.evidence).toContain('原有的抢跑证据。');
    expect(c.evidence).toContain('亲身经历');
  });

  it('不新增候选、不删候选', () => {
    const out = enrichWithMaterial([cand(), cand({ title: '完全无关的娱乐话题' })], [mat()]);
    expect(out).toHaveLength(2);
    expect(out[1].evidence).toBeUndefined();
  });

  it('素材库为空或只有口头禅 → 原样返回', () => {
    expect(enrichWithMaterial([cand()], [])[0].evidence).toBeUndefined();
    const only = [mat({ type: 'catchphrase' })];
    expect(enrichWithMaterial([cand()], only)[0].evidence).toBeUndefined();
  });

  it('长素材只截取开头做提示（完整内容留到创作阶段用）', () => {
    const long = mat({ content: '前端构建优化'.repeat(40), tags: [] });
    const [c] = enrichWithMaterial([cand()], [long]);
    expect(c.evidence!.length).toBeLessThan(140);
    expect(c.evidence).toContain('…');
  });

  it('案例与观点也算数，标签按类型如实叫法', () => {
    const [a] = enrichWithMaterial([cand()], [mat({ type: 'case' })]);
    expect(a.evidence).toContain('真实案例');
    const [b] = enrichWithMaterial([cand()], [mat({ type: 'opinion' })]);
    expect(b.evidence).toContain('既有观点');
  });
});
