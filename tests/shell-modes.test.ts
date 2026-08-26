import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NAV } from '@/lib/nav';
import { TASK_NAV } from '@/lib/shell';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/** 源码断言前先剥注释（本仓踩过三次「被自己的注释骗」） */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ══ 单壳合同（2026-08-26 用户拍板删工作台）═══════════════════════════════════
// 这个文件曾是「双壳对等合同」：两张导航表、外壳切换器、cookie/落库双持久化、
// 正反向对等守卫。多轮页面合并后两张表几乎重合，用户点破「好像都一样」并拍板
// 删掉工作台。现在它守的是：单壳不许悄悄长回双壳，以及仍然有效的布局性质。

describe('单壳：不许复辟', () => {
  it('lib/shell.ts 只是 re-export——第二张导航表不许再长出来', () => {
    const src = code('lib/shell.ts');
    expect(src).toMatch(/export \{ NAV as TASK_NAV \} from '@\/lib\/nav'/);
    expect(src, 'shell.ts 又开始自己定义导航了').not.toMatch(/items:\s*\[/);
    expect(src, '外壳切换机制回来了').not.toMatch(/SHELL_COOKIE|DEFAULT_SHELL|ShellMode/);
  });

  it('TASK_NAV 与 NAV 是同一个对象（不是内容相同的两份）', () => {
    expect(TASK_NAV).toBe(NAV);
  });

  it('切换器与阶段页签的文件已删，壳里也没有分支', () => {
    expect(fs.existsSync(path.join(ROOT, 'components/ShellSwitch.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'components/StageTabs.tsx'))).toBe(false);
    const shell = code('components/TenantShell.tsx');
    expect(shell, 'TenantShell 又在读外壳').not.toMatch(/currentShell/);
    expect(shell, 'TenantShell 又出现了双壳三元').not.toMatch(/taskdeck\s*\?/);
    // 首页与助手页同样不许再分支
    expect(code('app/(app)/page.tsx')).not.toMatch(/currentShell|taskdeck/);
    expect(code('app/(app)/assistant/page.tsx')).not.toMatch(/currentShell|taskdeck/);
  });
});

describe('导航自洽（原对等守卫的单表版本）', () => {
  const items = NAV.flatMap((g) => g.items);

  it('每个入口都指向真实存在的页面', () => {
    const groups = fs.readdirSync(path.join(ROOT, 'app'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('(')).map((d) => d.name);
    const routes = [...new Set(items.map((i) => i.href.split(/[#?]/)[0]))];
    const lost = routes.filter((r) => !groups.some((g) =>
      fs.existsSync(path.join(ROOT, r === '/' ? `app/${g}/page.tsx` : `app/${g}${r}/page.tsx`))));
    expect(lost, `这些地址没有 page.tsx：${lost.join('、')}`).toEqual([]);
  });

  it('同一个地址只出现一次', () => {
    const hrefs = items.map((i) => i.href);
    expect(hrefs).toEqual([...new Set(hrefs)]);
  });

  it('带锚点/带 view 的入口，目标必须真的存在', () => {
    for (const i of items.filter((x) => /[#?]/.test(x.href))) {
      const [route, frag] = i.href.split('#');
      const [p, query] = route.split('?');
      const groups = ['(app)', '(public)'];
      const file = groups.map((g) => (p === '/' ? `app/${g}/page.tsx` : `app/${g}${p}/page.tsx`))
        .find((f) => fs.existsSync(path.join(ROOT, f)));
      expect(file, `${p} 的 page.tsx 不存在`).toBeTruthy();
      const src = code(file!);
      if (frag) expect(src, `${p} 里没有 id="${frag}"`).toMatch(new RegExp(`id="${frag}"`));
      if (query) {
        const v = new URLSearchParams(query).get('view');
        expect(src, `${p} 没有认 view=${v} 的分支`).toMatch(new RegExp(`view === '${v}'`));
      }
    }
  });

  it('每组都写清自己是干什么的，且有图标', () => {
    for (const g of NAV) {
      expect(g.items.length, `${g.title || '主入口组'} 是空组`).toBeGreaterThan(0);
      expect(g.purpose.length, `${g.title || '主入口组'} 没说清为什么存在`).toBeGreaterThanOrEqual(8);
      expect(g.icon).toBeTruthy();
    }
  });

  it('主入口组：无标题、≤5 条（Doubao 式一列到底）', () => {
    const open = NAV.filter((g) => !g.collapsed);
    expect(open.length, '展开的应当只有主入口那一组').toBe(1);
    expect(open[0].title, '主入口组不该有标题——有标题就又变成分组了').toBe('');
    expect(open[0].items.length).toBeLessThanOrEqual(5);
    expect(NAV.filter((g) => g.collapsed).length, '其余分组都该默认收起').toBeGreaterThanOrEqual(2);
  });

  it('主入口与内容板块的每一条都有悬停提示（名字是动词短语，点进去是哪页要说清）', () => {
    for (const g of NAV.filter((x) => !x.pinBottom)) {
      const naked = g.items.filter((i) => !i.hint || i.hint.length < 6).map((i) => i.label);
      expect(naked, `这些入口没说清点进去是哪一页：${naked.join('、')}`).toEqual([]);
    }
  });

  it('必须收着「新任务」「任务记录」——少了任一条，这个模式就不成立', () => {
    const hrefs = items.map((i) => i.href);
    expect(hrefs).toContain('/assistant');
    expect(hrefs).toContain('/runs');
  });

  it('能力闸（requires）过滤真的发生：TaskSidebar 收 nav 参数，不自己 import', () => {
    const sidebar = code('components/TaskSidebar.tsx');
    expect(sidebar, 'TaskSidebar 直接引 TASK_NAV = 绕过了形态过滤').not.toMatch(/TASK_NAV/);
    expect(sidebar).toMatch(/\bnav,[\s\S]{0,200}?nav: NavGroup\[\]/);
    expect(code('components/TenantShell.tsx')).toMatch(/visibleTaskNav\(\)/);
  });
});

describe('外壳只有一份实现', () => {
  const groups = fs.readdirSync(path.join(ROOT, 'app'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('(')).map((d) => d.name);
  function groupOf(route: string): string | null {
    for (const g of groups) {
      const p = route === '/' ? `app/${g}/page.tsx` : `app/${g}${route}/page.tsx`;
      if (fs.existsSync(path.join(ROOT, p))) return g;
    }
    return null;
  }
  const routes = [...new Set(NAV.flatMap((g) => g.items.map((i) => i.href.split(/[#?]/)[0])))];

  it('入口所在的每个路由组，外壳都必须走 TenantShell（(public) 曾是盲区）', () => {
    const hosting = [...new Set(routes.map((r) => groupOf(r)!).filter(Boolean))];
    expect(hosting.length, '侧栏入口应当横跨多个路由组').toBeGreaterThanOrEqual(2);
    for (const g of hosting) {
      expect(code(`app/${g}/layout.tsx`), `app/${g}/layout.tsx 没走 TenantShell`).toMatch(/<TenantShell/);
    }
  });

  it('除 TenantShell 外，任何 layout 都不许自己渲染侧栏', () => {
    for (const g of groups) {
      const src = code(`app/${g}/layout.tsx`);
      for (const tag of ['<Sidebar', '<TaskSidebar']) {
        expect(src, `app/${g}/layout.tsx 直接渲染了 ${tag}`).not.toContain(tag);
      }
    }
  });
});

describe('首页：chat-first', () => {
  it('派活输入框在报告之前（说话优先于看板）', () => {
    const src = code('app/(app)/page.tsx');
    const home = src.indexOf('<TaskDeckHome');
    const report = src.indexOf('<BattleReport');
    expect(home, '首页没渲染派活组件').toBeGreaterThan(0);
    expect(report, '首页没渲染作战报告').toBeGreaterThan(0);
    expect(home, '派活框被压到报告后面').toBeLessThan(report);
    expect(fs.existsSync(path.join(ROOT, 'app/(app)/taskdeck')), '不许造 /taskdeck 专属页').toBe(false);
  });

  it('首页活动条只放没结束的，不再摆一份历史清单', () => {
    expect(code('app/(app)/page.tsx')).toMatch(/status === 'waiting' \|\| r\.status === 'running'/);
  });

  it('活动条的「等你处理」只对自己发起的那条说', () => {
    for (const f of ['app/(app)/page.tsx', 'app/api/runs/active/route.ts']) {
      expect(code(f), `${f} 没判「这条是不是我发起的」`).toMatch(/mine:\s*r\.memberId\s*\?\s*r\.memberId === s\.memberId/);
    }
    const home = code('components/TaskDeckHome.tsx');
    expect(home, '活动条没走 activeBadge').toMatch(/activeBadge\(r\)/);
    expect(home, '徽章文案不许在组件里另写一套').not.toMatch(/\?\s*'等你处理'\s*:/);
  });

  it('待办清单在单壳下仍有家（工作台删了不等于功能消失）', () => {
    const src = code('app/(app)/page.tsx');
    expect(src, '待办清单（TaskList）随工作台一起消失了').toMatch(/<TaskList/);
  });
});

describe('浮标助手：随身入口，但不许一个链接就开跑', () => {
  it('浮标接上了移交通道', () => {
    const src = code('components/GlobalAIAssistant.tsx');
    expect(src).toMatch(/looksActionable\(/);
    expect(src).toMatch(/\/assistant\?goal=/);
  });

  it('?goal= 只预填不自动跑——否则任意站点一个链接就能让登录用户发起付费执行', () => {
    const src = code('app/(app)/assistant/AgentPanel.tsx');
    const m = /useEffect\(\(\) => \{\s*if \(initialGoal\)([\s\S]{0,200}?)\}, \[initialGoal\]\)/.exec(src);
    expect(m, '没找到 initialGoal 的处理').toBeTruthy();
    expect(m![1], 'URL 参数直接触发了执行').not.toMatch(/actStartAgent/);
    expect(m![1]).toMatch(/setGoal/);
  });
});

describe('运行中心：能处理，不只是回看', () => {
  it('失败的工作流可以原地重跑', () => {
    expect(code('app/(app)/runs/page.tsx')).toMatch(/actRerunWorkflow/);
  });
  it('确认写操作不在这一页——它必须只给发起人', () => {
    expect(code('app/(app)/runs/page.tsx')).not.toMatch(/decidePendingCall|actConfirm/);
  });
});

describe('出口与布局', () => {
  it('账号区常驻侧栏底部：设置组 + 退出都在', () => {
    const shell = code('components/TenantShell.tsx');
    expect(shell).toMatch(/<SidebarUser/);
    expect(shell).toMatch(/settings=\{settingsGroup\}/);
    const user = code('components/SidebarUser.tsx');
    expect(user).toMatch(/退出登录/);
    expect(user, '设置组没有渲染进菜单').toMatch(/settings\.items\.map/);
  });

  it('🔒 手机端仍退得出去——侧栏在手机上整个 display:none', () => {
    const topbar = code('components/Topbar.tsx');
    expect(topbar, '顶栏没有给手机留退出').toMatch(/<form action=\{actLogout\} className="show-mobile">/);
    const css = code('app/globals.css');
    const escapeAt = css.indexOf('.sidebar, .sidebar-task');
    expect(escapeAt, '找不到文件末尾那段手机收尾覆盖').toBeGreaterThan(0);
    const desktopAt = css.indexOf('.show-mobile { display: none; }');
    expect(desktopAt).toBeGreaterThan(0);
    expect(escapeAt, '手机收尾段排在桌面规则之前，压不住').toBeGreaterThan(desktopAt);
    const inMobile = /\.show-mobile\s*\{([^}]*)\}/.exec(css.slice(escapeAt));
    expect(inMobile![1], '手机上退出按钮永远不显示').not.toMatch(/display:\s*none/);
    expect(css.slice(escapeAt), '收尾段没压住 .sidebar-task').toMatch(/\.sidebar,\s*\.sidebar-task\s*\{[^}]*display:\s*none/);
  });

  it('手机端导航走 visibleNav（形态过滤后的唯一导航）', () => {
    expect(code('components/Topbar.tsx')).toMatch(/<MobileNav nav=\{visibleNav\(\)\}/);
  });

  it('🔒 侧栏三段式：设置展开时不许把「最近」压塌', () => {
    const css = code('app/globals.css');
    expect(css).toMatch(/\.sidebar-scroll\s*\{[^}]*overflow-y:\s*auto/);
    expect(css).toMatch(/\.sidebar\s*\{[^}]*overflow:\s*hidden/);
    const rec = /\.task-recent\s*\{([^}]*)\}/.exec(css);
    expect(rec![1]).not.toMatch(/overflow-y:\s*auto|min-height:\s*0/);
    expect(css).toMatch(/\.sidebar-user\s*\{[^}]*flex-shrink:\s*0/);
    for (const f of ['components/TaskSidebar.tsx', 'components/Sidebar.tsx']) {
      if (fs.existsSync(path.join(ROOT, f))) {
        expect(code(f), `${f} 没有中间滚动层`).toMatch(/className="sidebar-scroll"/);
      }
    }
  });

  it('「下一步去哪儿」链路恒渲染（写完→查红线→发出去 不许断）', () => {
    expect(code('components/TenantShell.tsx')).toMatch(/<NextSteps nav=\{shellNav\} \/>/);
  });
});
