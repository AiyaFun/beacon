import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 「一个宽子项把整页横向撑开」的源码级守卫。
//
// 【为什么是源码级】jsdom 不做布局，量不出 min-content，渲染态测试证不了这件事。
// 而它在真机上非常刺眼：2026-08-20 量到 /extension 的 body.scrollWidth = 2861px
//（视口 1265px），整页可以左右拖——侧栏、顶栏、所有卡片全部错位。
//
// 【机制】CSS Grid 的 `1fr` 展开是 `minmax(auto, 1fr)`，而 `auto` 的**下界是内容最小宽度**。
// 于是格子里只要有一段 `white-space: nowrap` 的长文本，这一列就会涨到那段文本的宽度，
// 把 grid、卡片、页面依次撑开。两道防线缺一不可：
//   ① `.grid > * { min-width: 0 }` —— 结构上的兜底，任何一个宽子项都撑不开外面那层；
//   ② 要读完整的长文本不许套上单行省略号的类 —— 那是病因，不修的话文字仍然读不全。
const CSS = readFileSync(join(__dirname, '..', '..', 'app', 'globals.css'), 'utf8');
const read = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8');

describe('栅格子项不许把整页撑开', () => {
  it('.grid > * 有 min-width: 0', () => {
    // .grid-asym-left / .grid-asym-right 早就为同一个原因加过这条，
    // 普通的 .grid-2 ~ .grid-6 一直漏着，直到 /extension 上撞出 2861px 的 body
    expect(CSS.replace(/\s+/g, ' ')).toMatch(/\.grid > \* \{ min-width: 0;? \}/);
  });

  it('.grid-N 都是 1fr 展开——这条用例的前提没了就该重新想一遍', () => {
    // 如果哪天改成了固定 px 或 auto，上面那条 min-width 的意义会变，别让它变成一条没人懂的遗留
    expect(CSS).toMatch(/\.grid-2 \{ grid-template-columns: repeat\(2, 1fr\); \}/);
  });
});

describe('要读完整的长文本，不许套单行省略号的类', () => {
  it('.run-main 仍然是「单行标题 + 省略号」——它是给运行中心那种一行标题写的', () => {
    // 这条是下一条的前提：.run-main 本身没问题，问题是**借用它来放整段说明**
    expect(CSS).toMatch(/\.run-main \.small \{[^}]*white-space: nowrap/);
  });

  it('AI 能力清单用自己的 .tool-main，不借 .run-main', () => {
    const src = read('app/(app)/extension/AgentTools.tsx');
    // 借了的话：说明被省略号截断（读不到这个能力到底能干嘛）+ 整页横向溢出
    expect(src, 'AgentTools 又借回 .run-main 了').not.toMatch(/className="run-main"/);
    expect(src).toMatch(/className="tool-main"/);
    expect(CSS.replace(/\s+/g, ' '), '.tool-main 没定义 min-width:0 + flex:1').toMatch(
      /\.tool-main \{[^}]*min-width: 0;[^}]*flex: 1;/,
    );
    // 而且它不许把 nowrap 抄一遍
    expect(CSS).not.toMatch(/\.tool-main \.small \{[^}]*nowrap/);
  });
});

describe('分工梯按「格子多宽」排，不按「窗口多宽」', () => {
  it('用 auto-fit + minmax，不写死列数配视口断点', () => {
    // 这块梯子会出现在宽窄差很多的容器里：助手页是整幅宽，采集助手页里它在 .grid-2
    // 的一格中只有 475px。按视口断点排的话，宽屏下那一格里就是四条 100px 的窄柱，
    // 每个字单独一行——媒体查询问的是「窗口多宽」，这里要问的是「我这个格子多宽」
    expect(CSS).toMatch(/\.role-ladder \{[^}]*repeat\(auto-fit, minmax\(\d+px, 1fr\)\)/);
    expect(CSS, '不该再靠视口断点排分工梯').not.toMatch(/@media[^{]*\{ \.role-ladder \{/);
  });
});
