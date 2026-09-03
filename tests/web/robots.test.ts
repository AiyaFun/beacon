import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseRobots, isPathAllowed, BEACON_UA_TOKEN } from '@/lib/web/robots';

// robots 解析的单测。全部不碰网络：parseRobots/isPathAllowed 是纯函数。
//
// ⚠️ 写这份测试时按「假绿的六种形状」逐条自查过：每个 it 里都至少有一条
// **否定断言**（某个路径必须被拒），只写正面断言的话，把 isPathAllowed 改成
// `return true` 也能全绿——而那正是这道闸失效时的样子。

const G = (txt: string) => parseRobots(txt, BEACON_UA_TOKEN);

describe('parseRobots：分组', () => {
  it('连续多行 User-agent 共享同一组规则', () => {
    // 这是最容易写错的一处：按「一行 UA 一组」解析会让 beaconbot 落进空组，
    // 于是我们以为自己不受限，实际是被 Disallow 的。
    //
    // ⚠️ 顺序必须是 BeaconBot 在前、`*` 在后。反过来写（`*` 在前）这条测试是**假绿**的：
    // 一行一组时 Disallow 会挂到最后那个组，也就是 beaconbot 组，精确匹配照样命中它，
    // 结果一样、测试全绿、bug 还在。2026-08-24 的 mutation 验证就是这么抓出来的。
    const g = G(['User-agent: BeaconBot', 'User-agent: *', 'Disallow: /private'].join('\n'));
    expect(isPathAllowed(g, '/private/x')).toBe(false);
    expect(isPathAllowed(g, '/public/x')).toBe(true);
  });

  it('精确匹配我们的 UA 时，忽略 * 那一组', () => {
    const g = G(
      ['User-agent: *', 'Disallow: /', '', 'User-agent: BeaconBot', 'Disallow: /admin'].join('\n'),
    );
    expect(isPathAllowed(g, '/admin/x')).toBe(false); // 我们自己那组说不行
    expect(isPathAllowed(g, '/anything')).toBe(true); // `*` 的 Disallow:/ 不该套到我们头上
  });

  it('没有任何一组提到我们、也没有 * → 该站没管我们，放行', () => {
    const g = G(['User-agent: Googlebot', 'Disallow: /'].join('\n'));
    expect(g).toBeNull();
    expect(isPathAllowed(g, '/whatever')).toBe(true);
  });

  it('空的 Disallow 是「不禁止任何东西」，不是「禁止根路径」', () => {
    const g = G(['User-agent: *', 'Disallow:'].join('\n'));
    expect(isPathAllowed(g, '/')).toBe(true);
    expect(isPathAllowed(g, '/deep/path')).toBe(true);
  });

  it('行尾注释与组外指令不影响解析', () => {
    const g = G(
      ['Sitemap: https://x.com/sitemap.xml', 'User-agent: *  # 所有人', 'Disallow: /tmp # 临时目录'].join('\n'),
    );
    expect(isPathAllowed(g, '/tmp/a')).toBe(false);
    expect(isPathAllowed(g, '/ok')).toBe(true);
  });
});

describe('isPathAllowed：匹配优先级', () => {
  it('最长匹配优先——更长的 Allow 能从 Disallow 里挖出例外', () => {
    const g = G(['User-agent: *', 'Disallow: /a', 'Allow: /a/b'].join('\n'));
    expect(isPathAllowed(g, '/a/b/c')).toBe(true); // /a/b 更长，胜
    expect(isPathAllowed(g, '/a/z')).toBe(false); // 只命中 /a
  });

  it('长度相同时 Allow 胜过 Disallow', () => {
    const g = G(['User-agent: *', 'Disallow: /x', 'Allow: /x'].join('\n'));
    expect(isPathAllowed(g, '/x/1')).toBe(true);
    // 同时确认这不是「全放行」——换一个没被 Allow 的前缀仍要被拒
    const g2 = G(['User-agent: *', 'Disallow: /y'].join('\n'));
    expect(isPathAllowed(g2, '/y/1')).toBe(false);
  });

  it('支持 * 通配与 $ 行尾锚', () => {
    const g = G(['User-agent: *', 'Disallow: /*.pdf$'].join('\n'));
    expect(isPathAllowed(g, '/docs/a.pdf')).toBe(false);
    expect(isPathAllowed(g, '/docs/a.pdf.html')).toBe(true); // $ 锚住了，后面还有东西就不算
  });

  it('规则里的正则元字符按字面量处理，不改变语义', () => {
    // 真实站点里 `Disallow: /search?q=` 这种写法很常见。直接把整串塞进 RegExp，
    // `?` 会把前一个字符变成可选 —— /searc 也会被判成命中，而 /search?q=1 反而可能漏。
    const g = G(['User-agent: *', 'Disallow: /search?q='].join('\n'));
    expect(isPathAllowed(g, '/search?q=abc')).toBe(false);
    expect(isPathAllowed(g, '/searc')).toBe(true);
    expect(isPathAllowed(g, '/search')).toBe(true); // 没有 ?q= 的那一段就不该命中
  });

  it('路径带 query 时按「路径+query」整体比对', () => {
    const g = G(['User-agent: *', 'Disallow: /p?share=1'].join('\n'));
    expect(isPathAllowed(g, '/p?share=1')).toBe(false);
    expect(isPathAllowed(g, '/p?share=0')).toBe(true);
  });
});

describe('🔒 服务端抓取不许伪装成浏览器', () => {
  // 2026-08-24 合规审查：B 站适配器原来发 `user-agent: Mozilla/5.0` + 伪造 referer。
  // 伪装浏览器在反法诉讼里是「规避技术措施」的证据点，而我们抓的是公开数据、量极小，
  // 没有理由背这个。守卫钉住它别被改回去。
  const SRC = readFileSync(resolve(process.cwd(), 'lib/adapters/competitor-real.ts'), 'utf8');
  // 注释里提到 Mozilla 是在解释为什么不用它——只看**代码行**，否则这条守卫会被自己的注释骗。
  const codeLines = SRC.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));

  it('适配器里没有伪装浏览器的 User-Agent', () => {
    const bad = codeLines.filter((l) => /Mozilla|Chrome\/|AppleWebKit/.test(l));
    expect(bad, `发现疑似伪装 UA：\n${bad.join('\n')}`).toEqual([]);
  });

  it('适配器里没有伪造的 referer', () => {
    const bad = codeLines.filter((l) => /\breferer\s*:/i.test(l));
    expect(bad, `发现伪造 referer：\n${bad.join('\n')}`).toEqual([]);
  });

  // 「B 站请求带的是标识自己身份的 UA」那条 2026-09-02 随 BilibiliAdapter 一起删了：
  // 服务端不再向 api.bilibili.com 发任何请求（守卫在 tests/adapters/no-bilibili-server-fetch.test.ts）。
});

describe('🔒 safeFetch 默认遵守 robots', () => {
  const SRC = readFileSync(resolve(process.cwd(), 'lib/web/fetch.ts'), 'utf8');

  it('默认值是「遵守」，关掉必须显式传 false', () => {
    // 写成 `opts.respectRobots ?? true` 也对，但 `!== false` 更难被误改成默认关闭。
    // 断言的是语义：源码里必须出现一个「不等于 false 即为真」的判定，且要真的用上 checkRobots。
    expect(SRC).toMatch(/respectRobots\s*!==\s*false/);
    expect(SRC).toContain('checkRobots(current)');
  });

  it('robots 检查在重定向循环**内部**——每一跳都验', () => {
    // 只验起点的话，「跳转到 robots 禁止的路径」就能整个绕过去。
    const loopStart = SRC.indexOf('for (let hop = 0');
    const checkAt = SRC.indexOf('checkRobots(current)');
    const loopEnd = SRC.indexOf('throw new Error(\'重定向次数过多\');', loopStart);
    expect(loopStart).toBeGreaterThan(-1);
    expect(checkAt).toBeGreaterThan(loopStart);
    expect(checkAt).toBeLessThan(loopEnd);
  });
});
