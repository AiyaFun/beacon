import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NAV, reachableRoutes } from '@/lib/nav';
import { TASK_NAV, DEFAULT_SHELL, isShellMode, SHELL_LABEL, SHELL_HINT } from '@/lib/shell';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/**
 * 源码断言前先剥注释。第一版直接全文搜 `href="#"`，结果被**解释这件事的注释**判红——
 * 注释里写了「再放个 href="#" 只会制造假入口」。断言看的是代码在做什么，
 * 不是文件里出现过什么字符串（同「被自己的注释骗」那类假绿，只是这次是假红）。
 */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('任务台：换壳不是搬家', () => {
  const navHrefs = new Set(NAV.flatMap((g) => g.items.map((i) => i.href)));
  /** 锚点不是路由：/workflows#schedules 与 /workflows 是同一页，只是落到不同卡片 */
  const routeOf = (href: string) => href.split('#')[0];

  it('任务台的每个入口都指向工作台里已有的页面——一个新路由都不许造', () => {
    // 造 /agents /plugins 这类「任务台专属页」会立刻有两套真相源，
    // 而且 nav-layout 的孤儿页用例会把它判红（那个用例扫的是 app/(app) 下的 page.tsx）
    const strays = TASK_NAV.flatMap((g) => g.items.map((i) => i.href)).filter((h) => !navHrefs.has(routeOf(h)));
    expect(strays, `这些地址在工作台侧栏里不存在：${strays.join('、')}`).toEqual([]);
  });

  it('用了锚点的入口，那个锚点必须真的存在——否则点过去只是停在页面顶部', () => {
    // 「指路指到空页面」的变体：链接不 404、页面也正常，就是没跳到该看的地方
    // 2026-08-26 扁平化后 TASK_NAV 自己不再有锚点入口，但 AGENT_ROLES 与产物落点仍在用
    //（/extension#abilities）。改成两份导航一起扫，用例才继续有意义。
    const anchored = [...TASK_NAV, ...NAV].flatMap((g) => g.items).filter((i) => i.href.includes('#'));
    if (anchored.length === 0) return; // 两份都不用锚点了，这条自然退休
    for (const it of anchored) {
      const [route, hash] = it.href.split('#');
      const page = route === '/' ? 'app/(app)/page.tsx' : `app/(app)${route}/page.tsx`;
      expect(code(page), `${page} 里没有 id="${hash}"`).toMatch(new RegExp(`id="${hash}"`));
    }
  });

  it('任务台里同一个地址只出现一次', () => {
    const hrefs = TASK_NAV.flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs).toEqual([...new Set(hrefs)]);
  });

  it('每组都写清自己是干什么的，且有图标', () => {
    for (const g of TASK_NAV) {
      expect(g.items.length, `${g.title} 是空组`).toBeGreaterThan(0);
      expect(g.purpose.length, `${g.title} 没说清为什么存在`).toBeGreaterThanOrEqual(8);
      expect(g.icon, `${g.title} 没有图标`).toBeTruthy();
    }
  });

  it('侧栏名跟页面标题不一样的入口，必须有悬停提示说清点进去是哪一页', () => {
    // 任务台把 /settings 叫「定时任务」、/workflows 叫「智能体」。不写清楚的话
    // 用户点进去看到「运行设置」「工作流模板」，会以为自己点错了
    const byHref = new Map(NAV.flatMap((g) => g.items).map((i) => [i.href, i.label]));
    const renamed = TASK_NAV.flatMap((g) => g.items).filter((i) => byHref.get(i.href) !== i.label);
    expect(renamed.length, '任务台至少有几个入口是改过名的').toBeGreaterThan(0);
    const naked = renamed.filter((i) => !i.hint || i.hint.length < 6).map((i) => i.label);
    expect(naked, `这些入口改了名却没说点进去是哪一页：${naked.join('、')}`).toEqual([]);
  });

  it('任务台必须收进「新任务」「任务」——少了任一条，这个模式就不成立', () => {
    const hrefs = TASK_NAV.flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs).toContain('/assistant'); // 发起
    expect(hrefs).toContain('/runs'); // 回看
  });
});

describe('默认与容错', () => {
  it('DEFAULT_SHELL 是**没选过的人**的默认，不是凌驾于选择之上的默认', () => {
    // 工作台按阶段排、名字就是板块名，是这个产品原本的说明书，最适合第一次进来的人。
    // 但它只在「cookie 没有 + 成员记录也没有」时才生效——用户选过之后，
    // 选择永远优先（次序写在 lib/shell-server.ts 的 currentShell）
    expect(DEFAULT_SHELL).toBe('workbench');
  });

  it('cookie 是用户可写的：脏值一律回落默认，不许让布局崩', () => {
    expect(isShellMode('workbench')).toBe(true);
    expect(isShellMode('taskdeck')).toBe(true);
    expect(isShellMode('WORKBENCH')).toBe(false);
    expect(isShellMode('')).toBe(false);
    expect(isShellMode(undefined)).toBe(false);
    expect(isShellMode('<script>')).toBe(false);
  });

  it('两种模式都有名字和一句话说明（切换器的 title 靠它）', () => {
    for (const m of ['workbench', 'taskdeck'] as const) {
      expect(SHELL_LABEL[m]).toBeTruthy();
      expect(SHELL_HINT[m].length).toBeGreaterThanOrEqual(8);
    }
  });

  it('两句说明讲的必须是「按什么排」，不是「有什么功能」', () => {
    // 功能已经完全对等了。旧文案「一句话派活，**功能收进**智能体与技能」是上一版
    // 「任务台只留 9 个入口」时的实话，留着就成了一句劝退用户的谎话——
    // 他会以为切过去要损失板块，于是永远不试
    for (const m of ['workbench', 'taskdeck'] as const) {
      expect(SHELL_HINT[m], `${m} 的说明在暗示功能有多少`).not.toMatch(/收进|只/);
      expect(SHELL_HINT[m], `${m} 的说明没讲清按什么排`).toMatch(/排|列出/);
    }
  });

  it('首页形态不一样，切换器上就得说出来', () => {
    // 2026-08-21：任务台首页第一眼改成了派活输入框，工作台仍是今日概览。
    // 这是两种外壳之间**用户一眼能看到的最大差别**。切换器只字不提的话，
    // 用户切过去会发现首页整个变了而没人预告过——「藏」的定义是用户不知情。
    // 注意这条守的不是某句话的字面，是「两句说明各自都提到了自己的首页是什么」
    for (const m of ['workbench', 'taskdeck'] as const) {
      expect(SHELL_HINT[m], `${m} 的说明没提首页长什么样`).toMatch(/首页/);
    }
    expect(SHELL_HINT.taskdeck, '任务台的说明没提到那个输入框').toMatch(/输入框|派活/);
  });
});

describe('任务台首页：chat-first', () => {
  it('首页在任务台下把派活输入框放最前，工作台不受影响', () => {
    const src = code('app/(app)/page.tsx');
    expect(src, '首页没读外壳').toMatch(/currentShell/);
    expect(src, '首页没有任务台分支').toMatch(/taskdeck/);
    expect(src, '任务台下没渲染派活组件').toMatch(/TaskDeckHome/);
    // 零新路由：这仍然是 `/`，不是新造的 /taskdeck
    expect(
      fs.existsSync(path.join(ROOT, 'app/(app)/taskdeck')),
      '造了任务台专属页 = 两套真相源，且会被孤儿页用例判红',
    ).toBe(false);
  });

  it('首页活动条只放没结束的，不再摆一份历史清单', () => {
    // 侧栏钉着最近 6 条、运行中心是完整清单。首页再摆一份同源列表，
    // 只会让首屏变长而信息没变多
    const src = code('app/(app)/page.tsx');
    expect(src, '活动条没有按状态筛').toMatch(/status === 'waiting' \|\| r\.status === 'running'/);
  });

  // 【这一页是工作区级的，同事的运行也在列】那是刻意的（跨账号跨人都该看得见）。
  // 但「等你处理」只有发起人推得动——AI 执行的确认换个人点必定报错。
  // 不分辨的话，同事看到的是一张写着「等你处理」、点过去却什么也做不了的卡；
  // /runs 不放确认按钮防的正是这件事。
  it('活动条的「等你处理」只对自己发起的那条说', () => {
    // 两个数据源都要判：首屏那份是服务端快照，之后每 15 秒换成接口那份。
    // 只判一处的话，第一眼是对的、15 秒后变了（或者反过来）
    for (const f of ['app/(app)/page.tsx', 'app/api/runs/active/route.ts']) {
      expect(code(f), `${f} 没判「这条是不是我发起的」`).toMatch(/mine:\s*r\.memberId\s*\?\s*r\.memberId === s\.memberId/);
    }
    // 徽章文案本身走纯函数（lib/runs/badge），行为断言在 tests/runs-center.test.ts。
    // 这里只钉「组件真的用了它」——早先这条写成扫源码找 `r.mine`，
    // 而把文案改回「谁都是等你处理」之后，**旁边 className 里那个 r.mine 还在**，
    // 于是守卫照过不误（「只验存在一处」的假绿，mutation 当场抓到）。
    const home = code('components/TaskDeckHome.tsx');
    expect(home, '活动条没走 activeBadge').toMatch(/activeBadge\(r\)/);
    expect(home, '徽章文案不许在组件里另写一套').not.toMatch(/\?\s*'等你处理'\s*:/);
  });

  it('派活入口在任务台首页与助手页都在，功能不因外壳而少', () => {
    // 工作台用户仍然能派活——只是入口在 /assistant 而不是首页
    const home = code('app/(app)/page.tsx');
    // 正则要容忍换行与括号：早先写死成单行 `taskdeck && <TaskDeckHome`，
    // 给组件多传一个 prop 换了行就红——那钉的是**写法**，不是「任务台才渲染派活框」这个意图
    expect(home).toMatch(/taskdeck\s*&&\s*\(?\s*<TaskDeckHome/);
    const assistant = code('app/(app)/assistant/page.tsx');
    expect(assistant, '只 import 了没渲染').toMatch(/<AssistantTabs/);
  });
});

describe('浮标助手：随身入口，但不许一个链接就开跑', () => {
  it('浮标接上了移交通道（此前它只能聊天，说了不算）', () => {
    const src = code('components/GlobalAIAssistant.tsx');
    expect(src, '判据要用本地规则，不能让模型吐控制标记').toMatch(/looksActionable\(/);
    expect(src, '没有去执行那一侧的出口').toMatch(/\/assistant\?goal=/);
  });

  it('?goal= **只预填不自动跑**——否则任意站点一个链接就能让登录用户发起付费执行', () => {
    const src = code('app/(app)/assistant/AgentPanel.tsx');
    // 找到处理 initialGoal 的那个 effect，断言它只 setGoal、不开跑
    const m = /useEffect\(\(\) => \{\s*if \(initialGoal\)([\s\S]{0,200}?)\}, \[initialGoal\]\)/.exec(src);
    expect(m, '没找到 initialGoal 的处理').toBeTruthy();
    expect(m![1], 'URL 参数直接触发了执行：刷新一次就再花一次钱').not.toMatch(/actStartAgent/);
    expect(m![1]).toMatch(/setGoal/);
  });
});

describe('运行中心：能处理，不只是回看', () => {
  it('失败的工作流可以原地重跑', () => {
    const src = code('app/(app)/runs/page.tsx');
    expect(src).toMatch(/actRerunWorkflow/);
  });

  it('确认写操作**不在**这一页——它必须只给发起人', () => {
    // listRuns 是工作区级、刻意不按人过滤（同事看得到你的运行）。
    // 在这一页渲染确认按钮，要么给同事渲一张点了必报错的卡，
    // 要么就得绕开「只有发起人能确认」那条安全口径
    const src = code('app/(app)/runs/page.tsx');
    expect(src, '确认按钮跑到运行中心来了').not.toMatch(/actDecideAgentStep/);
    // 但要给一条能走到确认的路
    expect(src, '等确认的那条没给出口').toMatch(/去确认/);
  });
});

describe('客户端/服务端边界', () => {
  it("lib/shell.ts 不许碰 next/headers——它被客户端组件 import，一碰就 Build Error", () => {
    // tsc 全绿、单测全绿，只有真机打开页面才报错（2026-08-19 真机抓到过一次）
    expect(code('lib/shell.ts')).not.toMatch(/next\/headers/);
    expect(code('lib/shell-server.ts')).toMatch(/next\/headers/);
  });

  it('客户端组件只从 lib/shell 取常量，不碰服务端那半边', () => {
    const sw = code('components/ShellSwitch.tsx');
    expect(sw).toMatch(/'use client'|"use client"/);
    expect(sw).toMatch(/from '@\/lib\/shell'/);
    expect(sw).not.toMatch(/shell-server/);
  });

  it('服务端读 cookie 只走 lib/shell-server', () => {
    // Topbar 2026-08-26 起不再读外壳（切换器搬去了侧栏账号区），只剩 TenantShell 这一处
    for (const f of ['components/TenantShell.tsx']) {
      expect(code(f), `${f} 应从 shell-server 取 currentShell`).toMatch(/currentShell.*from '@\/lib\/shell-server'/s);
    }
  });
});

describe('出口必须在视野内——否则「用户自选的精简模式」就变成「功能被藏起来了」', () => {
  it('切换器常驻在外壳上（2026-08-26 从顶栏搬到侧栏底部的账号区）', () => {
    // 守的是**出口在视野内**，不是它挂在哪一根横梁上：账号区随侧栏常驻、一直可点。
    // 不许被塞进「设置里的一个开关」——那样任务台就是个走不出去的房间。
    const user = code('components/SidebarUser.tsx');
    expect(user, '账号区里没有切换器').toMatch(/<ShellSwitch mode=/);
    // 而账号区必须真的被两种外壳都渲染出来，否则上面那条只是在验一个没人用的组件
    const shellSrc = code('components/TenantShell.tsx');
    expect(shellSrc).toMatch(/<SidebarUser/);
    expect(shellSrc, '任务台没挂账号区').toMatch(/<TaskSidebar[^>]*footer=\{userFooter\}/s);
    expect(shellSrc, '工作台没挂账号区').toMatch(/<Sidebar nav=\{nav\} footer=\{userFooter\}/);
    // 出口不许只存在于设置页
    expect(code('app/(app)/settings/page.tsx')).not.toMatch(/<ShellSwitch/);
  });

  it('🔒 手机端仍退得出去——侧栏在手机上整个 display:none', () => {
    // globals.css 记着的旧伤：「顶栏右侧（通知铃 + 退出）必须始终在屏内」。
    // 把退出搬进侧栏账号区之后，手机上那一块根本不渲染，所以顶栏必须留一个
    // show-mobile 的退出——否则手机用户退不出登录，而这不会报任何错。
    const topbar = code('components/Topbar.tsx');
    expect(topbar, '顶栏没有给手机留退出').toMatch(/<form action=\{actLogout\} className="show-mobile">/);
    // ⚠️ 这条第一版写成一个大正则（@media…[\s\S]*?….show-mobile…display:(?!none)），
    // mutation 当场证明是**假绿**：懒量词会跨过手机段，被文件后面那条桌面同名规则兜住，
    // 把 display:none 改进去照样绿。改成结构化取段——先切到手机媒体段，再看**段内第一条**。
    // ⚠️ 必须剥注释再判（本仓第三次踩「探测器被自己的注释骗」）：那段收尾覆盖的注释里
    // 逐字写着 `.show-mobile{display:none}` 在解释为什么要压它，不剥的话正则先命中注释。
    // 定位也不能靠注释里的标记词——剥掉之后它就没了；改用只在收尾段出现的那条选择器。
    const css = code('app/globals.css');
    const escapeAt = css.indexOf('.sidebar, .sidebar-task');
    expect(escapeAt, '找不到文件末尾那段手机收尾覆盖').toBeGreaterThan(0);
    // 【顺序本身就是判据】同权重看先后：桌面那条 .show-mobile{display:none} 必须排在前面，
    // 手机这条才压得住。把手机段挪到桌面规则之前，按钮就永远不显示——而这不会报错。
    const desktopAt = css.indexOf('.show-mobile { display: none; }');
    expect(desktopAt, '找不到桌面那条 .show-mobile').toBeGreaterThan(0);
    expect(escapeAt, '手机收尾段排在桌面规则之前，压不住').toBeGreaterThan(desktopAt);
    const inMobile = /\.show-mobile\s*\{([^}]*)\}/.exec(css.slice(escapeAt));
    expect(inMobile, '手机收尾段里没有 .show-mobile 规则').toBeTruthy();
    expect(inMobile![1], '手机上 .show-mobile 仍是 display:none —— 退出按钮永远不显示').not.toMatch(/display:\s*none/);
    // 侧栏在手机上必须真的不出现：.sidebar-task 的 display:flex 在文件后面，
    // 不在收尾段里一起压住的话，任务台侧栏会占掉大半个手机屏（真机 436px 实测过）
    expect(css.slice(escapeAt), '收尾段没压住 .sidebar-task').toMatch(/\.sidebar,\s*\.sidebar-task\s*\{[^}]*display:\s*none/);
  });

  it('手机端恒给全量导航——切换器 hide-mobile，给任务台导航会把人困死', () => {
    const topbar = code('components/Topbar.tsx');
    // 手机上没有切换器，若 MobileNav 也只给 TASK_NAV 的 8 个入口，
    // 用户既看不到别的板块、也没有任何地方能切回工作台
    expect(topbar).toMatch(/<MobileNav nav=\{visibleNav\(\)\}/);
    expect(topbar).not.toMatch(/<MobileNav nav=\{TASK_NAV\}/);
    // 切换器确实是 hide-mobile（上面那条断言的前提没了的话，这条会提醒重新想一遍）
    expect(code('components/ShellSwitch.tsx')).toMatch(/hide-mobile/);
  });

  it('任务台侧栏底部有真的能切回去的出口（2026-08-26 从一句说明改成可点的切换器）', () => {
    // 原来这里是一段纯文本说明（「想按阶段排就在右上角切回工作台」）。用户 2026-08-26
    // 要求删掉它——**它已经在说假话**：切换器那时早就从右上角搬到了侧栏账号区。
    // 现在守的是更强的性质：底部有一个**点得动**的出口，而不是一句描述出口在哪的话。
    const src = code('components/TaskSidebar.tsx');
    expect(src, '侧栏底部没有账号区那一块').toMatch(/footer/);
    expect(code('components/SidebarUser.tsx'), '账号区里没有切换器').toMatch(/<ShellSwitch mode=/);
    // 指向 # 的假链接点了没反应，比没有更糟——这条一直有效
    expect(src).not.toMatch(/href="#"/);
    // 而且不许退回「只写一句话告诉用户出口在别处」：那正是刚删掉的东西
    expect(src, '又写回了一句描述出口在哪的文案').not.toMatch(/右上角|task-escape/);
  });

  it('🔒 侧栏三段式：设置展开时不许把「最近」压塌', () => {
    // 真机截图暴露的：整根侧栏是一个 flex 列，而只有 .task-recent 带
    // min-height:0 + overflow-y:auto，于是它成了唯一能被压缩的那一段——
    // 「设置」一展开（9 项），最近被挤成两行高的小滚动条，看上去像界面坏了。
    const css = code('app/globals.css');
    // 滚的必须是中间那一层，不是「最近」自己
    expect(css, '没有中间滚动层').toMatch(/\.sidebar-scroll\s*\{[^}]*overflow-y:\s*auto/);
    expect(css, '.sidebar 自己还在滚，中间层就滚不起来').toMatch(/\.sidebar\s*\{[^}]*overflow:\s*hidden/);
    const rec = /\.task-recent\s*\{([^}]*)\}/.exec(css);
    expect(rec, '找不到 .task-recent').toBeTruthy();
    expect(rec![1], '「最近」又自己带上了滚动/可压缩，它会重新变成被挤扁的那一个')
      .not.toMatch(/overflow-y:\s*auto|min-height:\s*0/);
    // 账号区不参与压缩：它是退出与切外壳的唯一出口，挤没了等于走不出去
    expect(css, '账号区没锁住高度').toMatch(/\.sidebar-user\s*\{[^}]*flex-shrink:\s*0/);
    // 结构上也要真的分成两层，否则上面的 CSS 是写给不存在的元素的
    for (const f of ['components/TaskSidebar.tsx', 'components/Sidebar.tsx']) {
      expect(code(f), `${f} 没有中间滚动层`).toMatch(/className="sidebar-scroll"/);
    }
  });

  it('任务台丢了阶段页签，但不许把「下一步去哪儿」一起丢掉', () => {
    // NEXT_STEPS 那条链路（写完→查合规→发布→贴链接回流数据）是这个产品最值钱的东西之一。
    // 它原本只长在 StageTabs 里，而任务台不渲染 StageTabs——换个壳就整条消失
    const layout = code('components/TenantShell.tsx');
    expect(layout).toMatch(/shell === 'taskdeck' && <NextSteps/);
    const src = code('components/NextSteps.tsx');
    expect(src).toMatch(/nextSteps\(/);
    // 任务台里没有「阶段」，所以不该像页签那样过滤掉同组的——旁边没有那一排板块可指
    expect(src).not.toMatch(/group\.items\.some/);
  });

  it('切回工作台后阶段页签要回来，任务台下不渲染', () => {
    const layout = code('components/TenantShell.tsx');
    expect(layout).toMatch(/shell === 'workbench' && <StageTabs/);
  });

  it('工作台下不为任务列表白查五张表', () => {
    const layout = code('components/TenantShell.tsx');
    expect(layout).toMatch(/shell === 'taskdeck' \? \(await listRuns/);
  });
});

describe('外壳只有一份实现——点进任何一个入口都不该换壳', () => {
  // 2026-08-20 真机抓到：cookie 是 taskdeck，点任务台「找料 → 看热点」进 /hotlists，
  // 侧栏当场变回工作台的七阶段，再点下一个又变回任务台。
  // 真因不在任务台这边——/hotlists 属于 (public) 路由组（它要允许游客先逛后注册），
  // 而那个 layout 给登录用户**自己抄了一份外壳**、写死 Sidebar + StageTabs，
  // 从来没读过 currentShell()。抄的那份还漏了演示横幅/到期横幅/全局助手三样。
  //
  // 此前的守卫全都只盯 app/(app)/layout.tsx，(public) 是它的盲区。下面这几条改成
  // **从侧栏的 href 反推该查哪些文件**，以后往任何新路由组里放板块都会被这里拦住。
  const groups = fs
    .readdirSync(path.join(ROOT, 'app'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('('))
    .map((d) => d.name);

  /** 这个地址的 page.tsx 落在哪个路由组 */
  function groupOf(route: string): string | null {
    for (const g of groups) {
      const p = route === '/' ? `app/${g}/page.tsx` : `app/${g}${route}/page.tsx`;
      if (fs.existsSync(path.join(ROOT, p))) return g;
    }
    return null;
  }

  const routes = [...new Set([...NAV, ...TASK_NAV].flatMap((g) => g.items.map((i) => i.href.split('#')[0])))];

  it('侧栏里每个入口都找得到自己的 page.tsx——找不到的话下面两条在空转', () => {
    const lost = routes.filter((r) => !groupOf(r));
    expect(lost, `这些地址没有对应的 page.tsx：${lost.join('、')}`).toEqual([]);
  });

  it('这些入口所在的每个路由组，外壳都必须走 TenantShell', () => {
    const hosting = [...new Set(routes.map((r) => groupOf(r)!))];
    // 侧栏的入口确实横跨不止一个组（/hotlists 在 (public)）——只剩一个组时这条会退化成
    // 「(app) 用了 TenantShell」，那正是它抓不住上面那个 bug 的原因，所以先钉死前提
    expect(hosting.length, '侧栏入口应当横跨多个路由组').toBeGreaterThanOrEqual(2);
    for (const g of hosting) {
      expect(code(`app/${g}/layout.tsx`), `app/${g}/layout.tsx 没走 TenantShell = 自己拼了一套外壳`).toMatch(
        /<TenantShell/,
      );
    }
  });

  it('除 TenantShell 外，任何 layout 都不许自己渲染侧栏或阶段页签', () => {
    // 拼第二份的后果不是报错，是**静默换壳**：用户选的那套在某几页上不生效
    for (const g of groups) {
      const src = code(`app/${g}/layout.tsx`);
      for (const tag of ['<Sidebar', '<TaskSidebar', '<StageTabs']) {
        expect(src, `app/${g}/layout.tsx 直接渲染了 ${tag}，外壳出现第二份实现`).not.toContain(tag);
      }
    }
  });

  it('唯一那份实现是按用户选的外壳分支，不是写死一种', () => {
    const src = code('components/TenantShell.tsx');
    expect(src).toMatch(/currentShell\(/);
    expect(src).toMatch(/shell === 'taskdeck'\s*\n?\s*\? <TaskSidebar/);
  });

  it('登录用户在哪个组里都看得到演示/到期横幅与全局助手', () => {
    // 抄那份外壳时漏掉的正是这三样：演示访客在 /hotlists 上看不到「以下数据均为示例」，
    // 会把示例热榜当成真的
    const src = code('components/TenantShell.tsx');
    for (const tag of ['<DemoBanner', '<ExpiryBanner', '<GlobalAIAssistant']) {
      expect(src, `TenantShell 少了 ${tag}`).toContain(tag);
    }
  });
});

describe('任务台主区：输入框必须上屏第一眼', () => {
  it('/assistant 在任务台下不渲染整块 PageHead——主角不能被压到标题与徽章后面', () => {
    // 任务台承诺的是「说一句话让它干活」。第一屏却是标题 + 三个徽章 + 一行 Mock 说明 +
    // 两个页签，输入框在第二屏起点——承诺没兑现。零新路由：换的是外面那层壳给不给标题区
    const src = code('app/(app)/assistant/page.tsx');
    expect(src, '助手页没读外壳').toMatch(/currentShell/);
    // 2026-08-26 全站页头统一成 HubHeader（一行式）后，这里认的组件名跟着换。
    // 守的性质不变：完整头只给工作台分支，任务台分支是压成一行的轻头
    expect(src, '页头没有按外壳分支').toMatch(/taskdeck \?[\s\S]{0,600}<HubHeader/);
  });

  it('停在「等你确认」的执行必须回得来——这是这轮修的死胡同', () => {
    const src = code('app/(app)/assistant/page.tsx');
    // ① 深链带 runId 进来要能读回那次运行
    expect(src, '没接 ?run= 深链').toMatch(/searchParams/);
    // ② 就算用户没走深链，页面自己也要把「有一条在等你」说出来。
    //    少了这条，用户只有在运行中心翻到那一行才回得来，而在此之前他会以为「AI 没做那件事」
    expect(src, "没查 awaiting_confirm").toMatch(/awaiting_confirm/);
    // ③ 只查发起人自己的：别人替他点确认 = 用他的权限做他没同意的事
    expect(src, '恢复提示没按发起人过滤').toMatch(/memberId: s\.memberId/);
  });

  it('侧栏那份任务列表点得开各自那件事，不是统统丢回 /runs', () => {
    const src = code('components/TaskSidebar.tsx');
    expect(src, '任务行没有用自己的 href').toMatch(/href=\{r\.href\}/);
    // 完整清单仍在运行中心，底部那条链接不许一起删掉
    expect(src).toMatch(/href="\/runs"/);
  });

  it('「问一句」答完之后的移交按钮：判据是本地规则，不是让模型吐标记', () => {
    // 模型会把标记、占位符、元信息原样抄给用户（提示词泄漏那三次），
    // 而这里的收益只是一个按钮显不显示——不值得为它开一条「模型输出里混控制信号」的通道
    const chat = code('app/(app)/assistant/Chat.tsx');
    expect(chat).toMatch(/looksActionable\(/);
    expect(chat, '没有把这句话交给执行那一侧').toMatch(/onHandoff\(/);
    const tabs = code('app/(app)/assistant/AssistantTabs.tsx');
    // 两侧都挂着、用 hidden 藏：卸载重挂等于把刚才那段流式回答扔了，
    // 而移交恰恰发生在读完那段回答之后
    expect(tabs).toMatch(/hidden=\{mode !== 'chat'\}/);
    expect(tabs).toMatch(/hidden=\{mode !== 'agent'\}/);
  });
});

describe('两种模式功能必须完全对等——这是 2026-08-20 推翻的那条取舍', () => {
  // 上一版任务台只列 9 个入口，热点/竞对/内容资讯库/选题/工坊/数据 全都没有，
  // 理由写的是「模式是用户自选的，顶栏能一键切回工作台，所以不算藏」。
  // 用户当场否掉：**换个壳不该少一半功能**。那条理由的错误在于——用户选的是
  // 「我喜欢这种排法」，不是「我愿意放弃一半板块」。
  const taskItems = TASK_NAV.flatMap((g) => g.items);
  // 「到得了」= 侧栏有这一条 **或** 某一条声明 covers 了它（首页本体就是那份报告、
  // 页顶标签一键切过去）。2026-08-26 扁平化后本周作战/智能体不再单列，靠 covers 证明可达。
  const taskRoutes = reachableRoutes(TASK_NAV);

  it('NAV 里的每一个板块，任务台都能到', () => {
    const missing = NAV.flatMap((g) => g.items).filter((i) => !taskRoutes.has(i.href));
    expect(missing.map((i) => `${i.label}(${i.href})`), '任务台里到不了这些板块').toEqual([]);
  });

  it('反过来也不许多出工作台没有的东西——那就是第二套真相源', () => {
    const navRoutes = reachableRoutes(NAV);
    const strays = [...taskRoutes].filter((h) => !navRoutes.has(h));
    expect(strays).toEqual([]);
  });

  it('能力闸（requires）必须原样带过来，否则企业版点进去撞错误页', () => {
    // /billing 在企业版被 visibleNav 过滤掉。任务台自己抄一份清单，
    // 漏抄 requires 的话那边就成了一个点进去必定报错的入口
    const byHref = new Map(NAV.flatMap((g) => g.items).map((i) => [i.href, i]));
    for (const it of taskItems) {
      const src = byHref.get(it.href.split('#')[0]);
      expect(it.requires, `${it.label} 的 requires 与工作台不一致`).toBe(src?.requires);
    }
    // 而且过滤要真的发生：TaskSidebar 收 nav 参数，不许自己 import TASK_NAV
    const sidebar = code('components/TaskSidebar.tsx');
    expect(sidebar, 'TaskSidebar 直接引 TASK_NAV = 绕过了形态过滤').not.toMatch(/TASK_NAV/);
    // 签名 2026-08-26 换成多行（多了 footer 参数），所以认「解构里收 nav」这个性质，
    // 不认某一行的字面写法
    expect(sidebar, 'TaskSidebar 没有从外面收 nav').toMatch(/\bnav,[\s\S]{0,200}?nav: NavGroup\[\]/);
    expect(code('components/TenantShell.tsx')).toMatch(/visibleTaskNav\(\)/);
  });

  it('极简感靠折叠，不靠删：天天用的两组展开，其余默认收起', () => {
    // 收起 ≠ 藏起来——分组标题始终可见、点一下就开、进到组里的页面自动展开
    //（NavList 已有这套机制，见 components/Sidebar.tsx）。
    // 全都展开的话侧栏就是三十来行，任务台的意义没了；全都收起的话第一屏什么都干不了。
    //
    // 2026-08-25 重排：任务台不再照搬工作台的阶段结构，工具从「5 个阶段组」收成
    // 「一个更多工具抽屉 + 设置」（见 lib/shell.ts 文件头）。所以折叠组从 5 降到 2——
    // 展开的仍只有干活+班底这条没变，折叠数下限相应改成 2。
    const open = TASK_NAV.filter((g) => !g.collapsed);
    // 2026-08-26 扁平化：主入口组不再有标题（title:'' → 不渲染组头，Doubao 式一列到底）
    expect(open.length, '展开的应当只有主入口那一组').toBe(1);
    expect(open[0].title, '主入口组不该有标题——有标题就又变成分组了').toBe('');
    expect(open[0].items.length, '主入口应当克制在 5 条以内').toBeLessThanOrEqual(5);
    expect(TASK_NAV.filter((g) => g.collapsed).length, '其余分组都该默认收起').toBeGreaterThanOrEqual(2);
  });

  it('改了名的入口全都写清楚点进去是哪一页', () => {
    // 任务台把板块名换成了动词短语（竞对监控 → 看同行）。这是它和工作台的**全部**区别，
    // 但也正因如此，不写 hint 的话用户会以为这是另一个功能
    const byHref = new Map(NAV.flatMap((g) => g.items).map((i) => [i.href, i.label]));
    const renamed = taskItems.filter((i) => byHref.get(i.href) !== i.label);
    // 2026-08-26 抽屉多轮合并（情报/做内容/记忆素材各收成一条）后改名条目自然变少，
    // 下限相应降。守的仍是「确实存在一批改名入口、且个个有 hint」，不是具体数量
    expect(renamed.length, '任务台至少有一批入口是改过名的').toBeGreaterThanOrEqual(5);
    const naked = renamed.filter((i) => !i.hint || i.hint.length < 6).map((i) => i.label);
    expect(naked, `这些入口改了名却没说点进去是哪一页：${naked.join('、')}`).toEqual([]);
  });
});

describe('「用户选哪种就用哪种」：选择要跟着人走，不是跟着浏览器', () => {
  it('读的次序是 cookie → 成员记录 → 默认', () => {
    // cookie 在最前面：切换要**当场生效**，不能等一次落库往返。
    // 成员记录兜底：只靠 cookie 的话，「我选的默认」其实只是「这台机器这个浏览器的默认」，
    // 换台电脑、清一次缓存，用户就被拉回他没选的那一套
    const src = code('lib/shell-server.ts');
    expect(src).toMatch(/cookies\(\)/);
    expect(src, 'currentShell 没读成员记录').toMatch(/memberShell/);
    expect(src.indexOf('SHELL_COOKIE'), 'cookie 必须排在成员记录之前').toBeLessThan(src.indexOf('memberShell'));
    // 布局要把成员那一列取出来传进去，否则参数永远是 undefined，落库等于白做
    expect(code('components/TenantShell.tsx')).toMatch(/shellMode: true/);
    expect(code('components/TenantShell.tsx')).toMatch(/currentShell\(member\?\.shellMode\)/);
  });

  it('切换器两件事都做：写 cookie（当场生效）+ 落库（跟着人走）', () => {
    const src = code('components/ShellSwitch.tsx');
    expect(src).toMatch(/document\.cookie/);
    // 断言**调用**而不是 import：只搜名字的话，把调用删掉、import 留着照样绿
    //（试过，是假绿——同 [[beacon-fake-green-tests]] 的「只验存在一处」）
    expect(src, '切换没落库 = 换台设备就丢').toMatch(/await actSetShellMode\(/);
  });

  it('落库失败不许打断切换——这是纯偏好，不参与鉴权', () => {
    const src = code('app/(app)/actions.ts');
    const fn = src.slice(src.indexOf('export async function actSetShellMode'));
    expect(fn).toMatch(/try \{/);
    expect(fn).toMatch(/catch/);
    // 脏值不许落库：这一列会被 isShellMode 读回来，写进去脏字符串只是让它每次都回落默认
    expect(fn, '没校验就写库').toMatch(/isShellMode\(mode\)/);
  });

  it('演示租户不落库——演示访客共用同一行 Member，写进去会改掉所有人的默认', () => {
    // 真机撞出来的：演示成员是固定 id 的共享行。一个访客切到任务台，
    // 所有还没有 cookie 的访客下次进来也变成任务台——一次跨用户的偏好串台。
    // 不落库不影响他自己：cookie 已经写好了，他这一趟看到的就是他选的那套
    const src = code('app/(app)/actions.ts');
    const fn = src.slice(src.indexOf('export async function actSetShellMode'));
    expect(fn, '没挡演示租户').toMatch(/isDemoTenant\(s\.tenantId\)/);
    expect(fn.indexOf('isDemoTenant'), '闸必须在写库之前').toBeLessThan(fn.indexOf('prisma.member.update'));
  });

  it('两份 schema 都加了 Member.shellMode，且有对应的迁移', () => {
    // 加列漏迁移是这个项目的部署盲区之一：本地 db push 全绿，生产 42703
    for (const f of ['prisma/schema.prisma', 'prisma/schema.postgres.prisma']) {
      expect(read(f), `${f} 里没有 shellMode`).toMatch(/shellMode\s+String\?/);
    }
    const sql = read('prisma/postgres/16-shell-mode.sql');
    expect(sql).toMatch(/ALTER TABLE "Member" ADD COLUMN IF NOT EXISTS "shellMode"/);
  });
});
