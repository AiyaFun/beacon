import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyAgainstSkeleton, selectorTokens } from '@/lib/ingest/parser-learn';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// 解析自学习闭环（2026-08-26 用户授权「可以自我学习，不要因为网页改了无法抓取」）。
// 自动上线的安全全靠这几条性质，逐条钉死。

const SKELETON = `div.author-card[data-e2e-follow] > span.count-item "粉丝" NUM万 span.count-item "获赞" NUM`;

describe('骨架静态验证：编造的候选过不了机器闸', () => {
  it('🔒 骨架里不存在的类名被逐条剔除，存在的留下', () => {
    const r = verifyAgainstSkeleton(
      SKELETON,
      ['.made-up-class .fans', '.author-card .count-item', '[data-e2e-follow]'],
      ['粉丝', '订阅者'],
    );
    expect(r.selectors).toEqual(['.author-card .count-item', '[data-e2e-follow]']);
    expect(r.anchors).toEqual(['粉丝']);
    expect(r.pass).toBe(true);
  });

  it('🔒 全是编造 → 不通过（自动上线的门就此关死）', () => {
    const r = verifyAgainstSkeleton(SKELETON, ['.fake-a', '.fake-b'], ['订阅者']);
    expect(r.pass).toBe(false);
  });

  it('🔒 纯标签选择器（div > span）不算通过——改版最先碎的就是结构猜测', () => {
    const r = verifyAgainstSkeleton(SKELETON, ['div > span'], []);
    expect(r.pass).toBe(false);
  });

  it('selectorTokens 只抽 ≥3 字符的类名/属性/id（短 token 全是误配源）', () => {
    expect(selectorTokens('.ab .count-item [data-e2e-follow] #x')).toEqual(['count-item', 'data-e2e-follow']);
  });
});

describe('🔒 自动采纳链路的三道闸都在', () => {
  const learn = code('lib/ingest/parser-learn.ts');

  it('propose 入库前先过骨架验证（人工路径同样受益）', () => {
    const seg = learn.slice(learn.indexOf('async function proposeSelectors'), learn.indexOf('async function activateRule'));
    expect(seg, 'proposeSelectors 没走 verifyAgainstSkeleton').toMatch(/verifyAgainstSkeleton\(incident\.skeleton/);
    expect(seg, '验证不过还在入库').toMatch(/if \(!verified\.pass\)/);
  });

  it('冷却闸：人工回滚过的字段 24h 内不再自动', () => {
    const seg = learn.slice(learn.indexOf('async function autoAdoptIncident'));
    expect(seg).toMatch(/reviewedBy: \{ not: 'auto' \}/);
    expect(seg).toMatch(/24 \* 3600_000/);
  });

  it('自动上线必须留痕告警，且告警里带回滚指路', () => {
    const seg = learn.slice(learn.indexOf('async function autoAdoptIncident'));
    expect(seg).toMatch(/sendOpsAlert/);
    expect(seg).toMatch(/一键回滚/);
  });

  it('route 只在同指纹**第一次**触发自动采纳（重复上报不重复烧诊断）且不阻塞响应', () => {
    const route = code('app/api/ingest/parser/route.ts');
    expect(route).toMatch(/if \(r\.created\) void autoAdoptIncident/);
  });
});
