import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
/** 源码断言前先剥注释——本仓踩过三次「探测器被自己的注释骗」 */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// 2026-08-26 用户逐条指出的「点了没效果」的入口。守的都是**同一个性质**：
// 界面上出现的东西，点下去要真的有东西。

describe('空市场不许摆在那儿当死入口', () => {
  it('🔒 市场目录为空时整张卡不渲染', () => {
    // 生产 /market/index.json 的 entries 目前是 []，而那张卡照样渲染出
    //「技能市场 · 装上就能用」+「看看市场里有什么」——点下去转一圈告诉你一条都没有。
    const src = code('app/(app)/skills/page.tsx');
    expect(src, '没有服务端探目录').toMatch(/fetchCatalog\(\)/);
    expect(src, '没有按「目录非空」判定').toMatch(/marketHasEntries/);
    // 判据必须是**条数**，不是「请求成功」——成功地返回一个空列表仍然是空市场
    expect(src).toMatch(/catalog\.entries\.length > 0/);
    // 而且卡片真的被这个条件包住了
    expect(src).toMatch(/\{marketHasEntries && \([\s\S]{0,400}?id="market"/);
  });
});

describe('侧栏「最近」：一件事只占一行', () => {
  it('🔒 同类同名的重复运行收成一条，带次数', () => {
    // 真机截图：6 条里只有 2 件事——「去采一个竞对」重复 4 次、「抖音·这不科学」2 次。
    // 同一个模板连跑 3 遍就占满整个列表，真正不同的那几件被挤没了。
    const src = code('components/TaskSidebar.tsx');
    expect(src, '没有按「类型+标题」去重').toMatch(/\$\{r\.kind\}\|\$\{r\.title\}/);
    expect(src, '渲染的还是原始 recent，去重白做了').toMatch(/rows\.map\(/);
    expect(src, '没把重复次数显示出来').toMatch(/times > 1/);
  });

  it('🔒 工作流运行不许再落到「有哪些模板」那个泛页面', () => {
    // 点 6 条不同的行全都落在同一个模板列表页上，看不到**这一次**跑了什么，
    // 用户的原话是「最近的内容都是没有效果的」。运行中心才有每一步的结果。
    const src = code('lib/runs/index.ts');
    const wf = src.slice(src.indexOf("kind: 'workflow'"), src.indexOf("kind: 'workflow'") + 700);
    expect(wf, '工作流运行的落点仍是 /workflows').not.toMatch(/href: '\/workflows'/);
    expect(wf).toMatch(/href: '\/runs'/);
  });
});

describe('能力不许住在插件页里', () => {
  it('🔒 /extension 不再渲染能力清单，它在班底页的第三个标签', () => {
    // 用户原话：「为什么能力是跳转到插件去了」。能力是 AI 的工具集，
    // 跟「装浏览器扩展」是两件事，混在一页会让人以为要先装插件才有 AI 能力。
    const ext = code('app/(app)/extension/page.tsx');
    expect(ext, '插件页还在渲染能力清单').not.toMatch(/<AgentTools/);
    const skills = code('app/(app)/skills/page.tsx');
    expect(skills, '班底页没接过能力清单').toMatch(/<AgentTools/);
    expect(skills, '没有 view=abilities 分支').toMatch(/view === 'abilities'/);
  });

  it('🔒 改能力开关要让新宿主页也失效', () => {
    // 不加 revalidatePath('/skills')：开关点了、切页回来还是旧状态（「点了没反应」的经典形状）
    const act = code('app/(app)/extension/actions.ts');
    const toggle = act.slice(act.indexOf('actToggleAgentTool'), act.indexOf('actCancelBrowserTask'));
    expect(toggle, 'actToggleAgentTool 没让 /skills 失效').toMatch(/revalidatePath\('\/skills'\)/);
  });
});

describe('首页那个框：文案必须跟着真实行为', () => {
  it('🔒 不许再承诺「我去办」——它现在只是把话带过去预填', () => {
    // 「文案与实际行为对不上」是本仓反复出现的一类缺陷。这一框的真实行为是
    // 跳到 /assistant?goal= 预填，**用户在那边按开始才真的跑**。
    // 写「说一句话，我去办」（旧文案）会让人以为回车就开跑；
    // 写「它会先答你」也不对——落点是执行那一侧，不是对话。
    const src = code('components/TaskDeckHome.tsx');
    const copy = src.slice(src.indexOf('<h1'), src.indexOf('</textarea>') > 0 ? src.indexOf('</textarea>') : src.length);
    expect(copy, '又写回了「我去办」这种直接开跑的承诺').not.toMatch(/我去办/);
    expect(copy, '文案没说清是在那边才开始跑').toMatch(/新任务|按开始|预填/);
  });
});

describe('列表里的开关：只动被点的那一个', () => {
  it('🔒 点一个能力开关，不许整排变灰', () => {
    // 用户 2026-08-26 原话：「点能力的开关，直接整排暗了再关闭和开」。
    // 根因：useTransition 的 pending 是**整个组件共享的一个布尔**，
    // 拿它 disable 每一行的 checkbox，点任意一个开关 33 行会一起变灰再一起恢复。
    // 与模板市场 busyId 那次是同一个坑（tests/workflow/market-ui.test.ts 钉着那条）。
    const src = code('app/(app)/extension/AgentTools.tsx');
    const box = /<input[\s\S]*?type="checkbox"[\s\S]*?\/>/.exec(src);
    expect(box, '找不到那个 checkbox').toBeTruthy();
    expect(box![0], 'disabled 里又用上了共享的 pending —— 整排会一起变灰')
      .not.toMatch(/\bpending\b/);
    expect(box![0], '没有按「是不是这一行」判定').toMatch(/busy === t\.name/);
    // 失败那一行必须解禁，否则它会永远卡在灰的
    const fn = src.slice(src.indexOf('function toggle('), src.indexOf('const on ='));
    expect(fn, 'busy 没有在 await 回来后立刻清掉').toMatch(/await actToggleAgentTool[^;]*;\s*\n\s*setBusy\(''\);/);
  });
});

describe('运行中心：按钮不许自己指自己', () => {
  it('🔒 href 指回 /runs 的行不渲染「去运行中心」', () => {
    // 2026-08-26 真机截图：浏览器任务落点改成 /runs 后，用户**在运行中心里**看到
    // 「去运行中心 →」——原地跳转，点了以为坏了（原话「点击后完成无法跑得动」）。
    const src = code('app/(app)/runs/page.tsx');
    expect(src, '跳转按钮没有排除指回本页的行').toMatch(/r\.href\.split\(\/\[#\?\]\/\)\[0\] !== '\/runs'/);
    // 等浏览器领活的行要有真出口（检查插件），不是什么按钮都没有
    expect(src, '等浏览器领活的行没有给出口').toMatch(/href="\/extension"/);
  });
});
