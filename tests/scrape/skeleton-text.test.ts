import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { textShape, sanitizeSkeleton, serializeSkeleton, verifyAgainstSkeleton } from '@/lib/ingest/parser-learn';

// 骨架里的**文本层**（2026-08-29 补）。
//
// 【为什么单独立一个文件，而不是并进 recipe.test.ts】
// tests/scrape/recipe.test.ts 有 43 条守卫，**全部在「不许做什么」上**：不许远程端点、
// 不许点击、不许遍历标签、不许抢焦点……一条都没有在「做出来的东西有没有用」上。
// 于是下面这两个缺陷在 43 条全绿的情况下活了下来，而且两条都不报错：
//
//   ① 配方骨架产出的是 `text: [...]`（数组），而 sanitizeSkeleton 只认
//      `shape:string` / `text:string` —— **整层文本被丢掉**。模型看到的骨架一个字都没有，
//      于是永远提不出文本锚点，学出来的规则只剩改版最先碎的类名。
//   ② 客户端已经成形过一遍（NUM/CJK），服务端再成形一遍时把 'NUM' 当成英文单词
//      → 'EN'。症状与 parser-learn.ts 注释里那个「粉丝 328.3万 → 粉丝 EN万」的老 bug
//      **一模一样，成因却是另一个**（那次是链式 replace，这次是两次成形）。
//
// 所以这个文件里的每一条都**断言产出**，不断言源码里有没有某句话。
// 源码级断言在这两个缺陷面前是无效的：源码看起来完全正常。

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('文本成形是幂等的（客户端成形过一遍，服务端还会再来一遍）', () => {
  it('生文本正常成形', () => {
    expect(textShape('粉丝 328.3万')).toBe('粉丝 NUM万');
  });

  it('已经成形过的再过一次不变（改坏这条 → 粉丝 EN万）', () => {
    expect(textShape('粉丝 NUM万')).toBe('粉丝 NUM万');
    expect(textShape('NUM')).toBe('NUM');
    expect(textShape('CJK')).toBe('CJK');
    expect(textShape('EN')).toBe('EN');
  });

  it('真正的英文单词仍然被抹成 EN（幂等不能变成放行）', () => {
    expect(textShape('username')).toBe('EN');
    expect(textShape('NUMBER')).toBe('EN'); // 只有恰好等于 NUM/CJK/EN 才算记号
  });

  it('两端的成形函数必须同一口径（注释里写了「两边要一起改」）', () => {
    const client = read('extension/content/common.js');
    expect(client).toContain("en === 'NUM' || en === 'CJK' || en === 'EN' ? en : 'EN'");
  });
});

describe('骨架的文本层不许被丢掉', () => {
  // 采集配方那条路（lib/browser/local.ts 与 extension/tools/recipe-run.js）的产出形状
  const arrayShaped = {
    tag: 'div', cls: ['user-info'], attrs: ['data-id'],
    text: ['粉丝', 'NUM万'], children: [],
  };
  // 平台解析器那条路（extension/content/common.js）的产出形状
  const stringShaped = { tag: 'div', cls: ['user-info'], shape: '粉丝 NUM万', children: [] };

  it('旧版插件的数组形状：文本必须留下（这一条正是原来丢掉的那种）', () => {
    const s = serializeSkeleton(sanitizeSkeleton(arrayShaped));
    expect(s).toContain('粉丝');
    expect(s).toContain('NUM');
  });

  it('字符串形状：文本必须留下', () => {
    const s = serializeSkeleton(sanitizeSkeleton(stringShaped));
    expect(s).toContain('粉丝');
    expect(s).toContain('NUM');
  });

  it('两种形状学出来的锚点一样（口径不一致会让同一个配方在两条路上给出不同的数）', () => {
    const a = serializeSkeleton(sanitizeSkeleton(arrayShaped));
    const b = serializeSkeleton(sanitizeSkeleton(stringShaped));
    expect(verifyAgainstSkeleton(a, [], ['粉丝']).anchors).toEqual(['粉丝']);
    expect(verifyAgainstSkeleton(b, [], ['粉丝']).anchors).toEqual(['粉丝']);
  });

  it('文本锚点真的能过验证——不能只剩类名选择器', () => {
    const s = serializeSkeleton(sanitizeSkeleton(arrayShaped));
    const v = verifyAgainstSkeleton(s, ['.user-info'], ['粉丝']);
    expect(v.selectors).toEqual(['.user-info']);
    // 【这条是整个文件的重点】原来这里恒为空数组，而 pass 仍然为 true（选择器过了），
    // 所以「学会了 N 个字段」照常报成功——最难发现的一种坏。
    expect(v.anchors).toEqual(['粉丝']);
    expect(v.pass).toBe(true);
  });

  it('人名仍然不许当锚点（文本回来了，这道闸才真正开始起作用）', () => {
    const withName = { tag: 'div', cls: ['author'], text: ['张三'], children: [] };
    const s = serializeSkeleton(sanitizeSkeleton(withName));
    expect(verifyAgainstSkeleton(s, [], ['张三']).anchors).toEqual([]);
  });
});

describe('两端骨架产出的字段名', () => {
  it('本机浏览器那段产的是 shape 字符串，不是 text 数组', () => {
    const src = read('lib/browser/local.ts');
    expect(src).toContain("shape: own.slice(0, 3).join(' ')");
    expect(src).not.toMatch(/^\s*text: own\.slice/m);
  });

  it('插件执行器同上（两处口径必须一致）', () => {
    const src = read('extension/tools/recipe-run.js');
    expect(src).toContain("shape: own.slice(0, 3).join(' ')");
    expect(src).not.toMatch(/^\s*text: own\.slice/m);
  });

  it('服务端仍然认旧的数组形状（插件要过商店审核，老版本还在跑）', () => {
    const src = read('lib/ingest/parser-learn.ts');
    expect(src).toContain('Array.isArray(n.text)');
  });
});
