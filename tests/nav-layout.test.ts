import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NAV, HELP_ROUTES, NEXT_STEPS, nextSteps, navPathLabel, activeHref, groupOf, stageHref, reachableRoutes } from '@/lib/nav';

// 信息架构守卫：侧栏是这个产品的说明书，它乱了，功能再好也找不到。
//
// 2026-08-19 按工作流阶段重排了导航（看情报 → 定选题 → 做内容 → 看效果）。
// 这一组用例钉住的是**重排之后不许再退回去**的那几条，以及重排暴露出来的两个真 bug：
//   · 「工具」组曾塞了 11 项（装插件、账单、帮助全在一起）——分组规模要有上限；
//   · 侧栏用 startsWith 判高亮，打开 /settings/keys 时「接入与密钥」与「运行设置」一起亮。

const ROOT = path.resolve(__dirname, '..');

describe('分组：一个阶段一组，别再长成杂物抽屉', () => {
  // 「设置与支持」是低频例外：装一次就不再动，板块多但不影响天天走的那条路。
  const LOW_FREQ = '设置与支持';

  it('展开组 ≤5 项；折叠组是抽屉，容量不设上限', () => {
    // 单壳化（2026-08-26）后组语义变了：主入口是扁平一列（≤5 条守在 shell-modes），
    // 「内容板块」「设置」是折叠抽屉——抽屉的意义就是装下低频多件，数量不是问题，
    // 摊开才是。所以只守「不折叠的组不许超载」。
    const oversized = NAV.filter((g) => !g.collapsed && g.items.length > 5)
      .map((g) => `${g.title || '主入口'}(${g.items.length})`);
    expect(oversized, `这些展开组超载了：${oversized.join('、')}`).toEqual([]);
  });

  it('收起的组就是那两个抽屉：内容板块、设置', () => {
    expect(NAV.filter((g) => g.collapsed).map((g) => g.title)).toEqual(['内容板块', '设置']);
  });

  it('每个阶段都有图标与落地页', () => {
    for (const g of NAV) {
      expect(g.icon, `${g.title} 没有图标`).toBeTruthy();
      // 落地页 = 这个阶段第一个可见板块。写死常量的话，企业版过滤掉计费后会指到一个不存在的入口
      expect(stageHref(g)).toBe(g.items[0].href);
    }
  });

  it('每组都写清自己是干什么的（purpose 不许留空）', () => {
    const thin = NAV.filter((g) => (g.purpose ?? '').length < 8).map((g) => g.title);
    expect(thin, `这些组没说清为什么存在：${thin.join('、')}`).toEqual([]);
  });

  it('同一个地址只出现一次——两个入口指同一页，用户两边都不知道该点哪个', () => {
    const hrefs = NAV.flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs).toEqual([...new Set(hrefs)]);
  });

  it('每个已上线的页面都有导航入口（藏起来 = 用户认为没这功能）', () => {
    // (app) 下的每个 page.tsx 就是一个用户能打开的页面。它们都该在侧栏里找得到。
    const dir = path.join(ROOT, 'app/(app)');
    const pages: string[] = [];
    const walk = (p: string, url: string) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(p, e.name), `${url}/${e.name}`);
        else if (e.name === 'page.tsx') pages.push(url === '' ? '/' : url);
      }
    };
    walk(dir, '');
    // 遍历一坏（目录改名、文件名不再是 page.tsx），orphans 恒为空数组、这条永远绿
    expect(pages.length, '一个页面都没扫到，遍历坏了').toBeGreaterThan(10);
    const hrefs = new Set(NAV.flatMap((g) => g.items.map((i) => i.href)));
    // covers 也算有入口：/workflows 没单列，但「技能 · 连接器」页顶标签一键就到
    const reachable = reachableRoutes(NAV);
    const orphans = pages.filter((p) => !hrefs.has(p) && !reachable.has(p));
    expect(orphans, `这些页面没有任何侧栏入口：${orphans.join('、')}`).toEqual([]);
  });
});

describe('高亮：只点亮一条，最长前缀胜出', () => {
  it('/settings/keys 只点亮「接入与密钥」，不连带点亮「运行设置」', () => {
    expect(activeHref(NAV, '/settings/keys')).toBe('/settings/keys');
    expect(activeHref(NAV, '/settings/account')).toBe('/settings/account');
    expect(activeHref(NAV, '/settings')).toBe('/settings');
  });

  it('首页只在真的是首页时点亮（不是「所有路径都以 / 开头」）', () => {
    expect(activeHref(NAV, '/')).toBe('/');
    expect(activeHref(NAV, '/topics')).toBe('/topics');
  });

  it('子路径归属父入口（/studio?tab=… 与 /data/xxx 都点亮各自那条）', () => {
    expect(activeHref(NAV, '/data/anything')).toBe('/data');
  });

  it('不在导航里的路径谁都不点亮', () => {
    expect(activeHref(NAV, '/setup')).toBeNull();
  });

  it('当前页能定位到所属阶段（侧栏那一行、顶部页签都靠它）', () => {
    expect(groupOf(NAV, '/settings/keys')?.title).toBe('设置');
    expect(groupOf(NAV, '/data')?.title).toBe('内容板块');
    expect(groupOf(NAV, '/studio')?.title).toBe('内容板块');
    // 不属于任何阶段的页面（装机向导）不渲染阶段页签
    expect(groupOf(NAV, '/setup')).toBeNull();
  });

  it('单壳后阶段页签退役，跨页导航由页顶组页签承担（Intel/Make/Asset/RoleTabs）', () => {
    // StageTabs 是「阶段」概念的产物，单壳（2026-08-26）没有阶段。
    // 「下一步去哪儿」链路由 NextSteps 恒渲染兜住（shell-modes 有守卫）。
    const shellSrc = fs.readFileSync(path.join(ROOT, 'components/TenantShell.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(shellSrc).not.toContain('<StageTabs');
  });

});

describe('帮助页的路标不许指向不存在的分组', () => {
  it('每条路标都能在导航里定位到「组 → 项」', () => {
    const broken = HELP_ROUTES.filter((r) => navPathLabel(r.href) === null).map((r) => `${r.what}(${r.href})`);
    expect(broken, `这些路标指向的地址不在导航里：${broken.join('、')}`).toEqual([]);
  });

  it('路标那半句是**现算**的，帮助页里不许再手写「组 → 项」', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app/(app)/help/page.tsx'), 'utf8');
    expect(src).toContain('navPathLabel');
    // 要拦的形状是「以分组名开头的路标」：'设置与支持 → 采集助手'。
    // 页面里那句「建人设 → 生成推荐 → 采纳」是流程说明不是路标，别一起拦下（那样只会逼人加豁免）。
    const groupNames = NAV.map((g) => g.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const handWritten = new RegExp(`['"\`](${groupNames}) → `);
    expect(src, '帮助页里又手写了「组 → 项」，改用 navPathLabel(href)').not.toMatch(handWritten);
  });
});

describe('链路：每个工作流页面都要说清「这一步之后去哪儿」', () => {
  // 侧栏回答「东西在哪」，这张表回答「做完接着做什么」。后者断了，用户走不完一整圈：
  // 重排前数据看板不指向爆款基因（它俩本来就该一组），爆款基因看完也不知道拿去哪儿用。
  // 单壳化后没有阶段分组了：工作流页 = 内容板块抽屉里的每一条（设置类不参与闭环）
  it('内容板块抽屉里的每一页都配了下一步', () => {
    const pages = NAV.filter((g) => g.title === '内容板块').flatMap((g) => g.items.map((i) => i.href.split(/[#?]/)[0]));
    const missing = pages.filter((h) => nextSteps(h).length === 0);
    expect(missing, `这些页面走到底就断了：${missing.join('、')}`).toEqual([]);
  });

  it('🔒 每个被 covers 的页都有显示名（COVERED_PAGE_NAMES）', async () => {
    // 名字缺席的后果是静默的：nextSteps 的按钮直接消失（「写完→查红线→发出去」断链）、
    // 帮助页路标 null。这里逐个核对，而不是等哪条链路断了才发现。
    const { NAV: nav, COVERED_PAGE_NAMES } = await import('@/lib/nav');
    const { TASK_NAV } = await import('@/lib/shell');
    const covered = new Set<string>();
    for (const g of [...nav, ...TASK_NAV]) for (const it of g.items) for (const c of it.covers ?? []) covered.add(c.split(/[#?]/)[0]);
    expect(covered.size, '一个 covers 都没有，这条用例失去意义了').toBeGreaterThan(0);
    const missing = [...covered].filter((h) => !COVERED_PAGE_NAMES[h]);
    expect(missing, `这些被 covers 的页没有显示名：${missing.join('、')}`).toEqual([]);
  });

  it('下一步指向的地址都在导航里，且不指向自己', () => {
    const broken: string[] = [];
    // 起点判据 2026-08-26 改为 reachableRoutes：情报三合一后 /competitors /library
    // 不再单列（由「看情报」covers），但页面存在、页顶标签一键可达——
    // NEXT_STEPS 的起点要求是「用户能站在那一页上」，不是「侧栏单列一条」。
    // 终点仍用 navPathLabel：按钮文字取自导航 label，被 covers 的页没有独立 label，
    // 终点只指主入口，没受影响。
    const reachable = reachableRoutes(NAV);
    for (const [from, steps] of Object.entries(NEXT_STEPS)) {
      if (!reachable.has(from)) broken.push(`起点不在导航里：${from}`);
      for (const s of steps) {
        if (navPathLabel(s.href) === null) broken.push(`${from} → ${s.href}（终点不在导航里）`);
        if (s.href === from) broken.push(`${from} 指向了自己`);
        if (s.why.length < 6) broken.push(`${from} → ${s.href} 没写为什么`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('按钮上的字取自导航，不是各写各的', () => {
    for (const [from, steps] of Object.entries(NEXT_STEPS)) {
      const resolved = nextSteps(from);
      expect(resolved).toHaveLength(steps.length);
      for (const r of resolved) expect(navPathLabel(r.href)).toContain(r.label);
    }
  });

  it('这条环是闭合的：看效果能回到定选题', () => {
    // 「看效果」三合一后，爆款基因/算法教练并进 /data（页内标签），闭环入口从 /genes 移到 /data。
    expect(nextSteps('/data').map((s) => s.href)).toContain('/topics');
    expect(nextSteps('/publish').map((s) => s.href)).toContain('/data');
    expect(nextSteps('/topics').map((s) => s.href)).toContain('/studio');
  });
});
