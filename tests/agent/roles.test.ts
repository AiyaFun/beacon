import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NAV, reachableRoutes } from '@/lib/nav';
import { TASK_NAV } from '@/lib/shell';
import { AGENT_ROLES, AGENT_ROLE_LIST, dispatchOrderBlock } from '@/lib/agent/roles';
import { AGENT_TOOLS } from '@/lib/agent/tools';
import { PER_RUN_TOOL_CAP } from '@/lib/agent/budget';
import { between, orderedBefore } from '../helpers/anchor';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/** 断言看的是代码在做什么，不是文件里出现过什么字符串——注释里恰恰会解释这些坑 */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 生产源码文件（不含测试）。抄一份 oneLine 过去的地方可能在任何一处，所以要全扫。 */
function allSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(path.join(process.cwd(), d), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const rel = `${d}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(e.name) && !e.name.includes('.test.')) out.push(rel);
    }
  };
  for (const d of ['lib', 'app', 'components']) walk(d);
  return out;
}

describe('四类干活单位：只有一处定义', () => {
  it('每一类都说清「是什么」「谁决定怎么做」「在哪儿」', () => {
    expect(AGENT_ROLE_LIST.length).toBe(4);
    for (const r of AGENT_ROLE_LIST) {
      expect(r.name, `${r.key} 没有名字`).toBeTruthy();
      expect(r.oneLine.length, `${r.key} 没说清是什么`).toBeGreaterThanOrEqual(8);
      // 「谁决定怎么做」才是四类真正的分界。缺了它，用户会以为叫「智能体」的那个会临场思考
      expect(r.decidedBy.length, `${r.key} 没说清谁决定怎么做`).toBeGreaterThanOrEqual(4);
    }
  });

  it('每一类的落地页都真的存在（剥掉锚点之后要在导航里）', () => {
    // covers 也算到得了（2026-08-26 扁平化：智能体不再单列，由技能·连接器页顶标签覆盖）
    const known = reachableRoutes(NAV);
    for (const r of AGENT_ROLE_LIST) {
      // 2026-08-26：能力的落点从 /extension#abilities 改成 /skills?view=abilities
      //（它此前挂在「下载采集助手」页里，用户当场问「为什么能力是跳转到插件去了」）。
      // 所以这里要**同时剥锚点与查询串**——只剥 # 的话带 ?view= 的那条永远找不到。
      expect(known, `${r.name} 指向的 ${r.href} 不在导航里`).toContain(r.href.split(/[#?]/)[0]);
    }
  });

  it('带锚点/带 view 参数的落点，那个目标必须真的存在——否则点过去只是停在页面顶部', () => {
    // 2026-08-26 起四类的落点里已经没有 # 锚点了（能力改成了 ?view=abilities）。
    // 两种形态都要能验：# 要求页面源码里有那个 id，? 要求页面真的认这个 view 值。
    const targeted = AGENT_ROLE_LIST.filter((r) => /[#?]/.test(r.href));
    expect(targeted.length, '一个带定位的都没有，这条用例失去意义了').toBeGreaterThan(0);
    for (const r of targeted) {
      const [route, frag] = r.href.split('#');
      const [path, query] = route.split('?');
      const src = code(`app/(app)${path}/page.tsx`);
      if (frag) {
        expect(src, `${path} 页里没有 id="${frag}"`).toMatch(new RegExp(`id="${frag}"`));
      }
      if (query) {
        const value = new URLSearchParams(query).get('view');
        // 页面必须真的分支到这个值上——只在 URL 里写 ?view=abilities 而页面不认，
        // 用户点过去看到的是默认视图，跟点错了没区别
        expect(src, `${path} 页没有认 view=${value} 的分支`).toMatch(
          new RegExp(`view === '${value}'`),
        );
      }
    }
  });

  it('术语不许各页各写一份：四页都从 roles.ts 取，且都挂了分工梯', () => {
    // 2026-08-20 之前这四类的说法散在六处（三个 PageHead + 一段注释 + systemPrompt +
    // 任务台 hint），互相不引用。于是界面上读到的分工与 AI 实际的派活逻辑可以完全对不上，
    // 而这种不一致既不会红也不会 404，只会让用户觉得「这个 AI 不听话」。
    // 2026-08-26：三类落地页从「四张分工梯卡」换成同一条页签（components/RoleTabs.tsx）。
    // 守的性质没变——**这一页是四类里的哪一类、另外几类怎么去，页顶就能看见**，
    // 且名字必须来自 roles.ts。变的只是用哪个组件承担。
    const pages: [string, string, 'tabs' | 'ladder'][] = [
      ['app/(app)/workflows/page.tsx', 'agent', 'tabs'],
      ['app/(app)/skills/page.tsx', 'skill', 'tabs'],
      // 能力 2026-08-26 从 /extension 搬到 /skills 的第三个标签
      ['app/(app)/skills/page.tsx', 'ability', 'tabs'],
      // 助手页的分工梯在**页尾**（「你也可以直接去用其中任何一样」），
      // 不与页顶抢位置，所以它保留四张卡的形态
      ['app/(app)/assistant/page.tsx', 'assistant', 'ladder'],
    ];
    // 【2026-08-30 改了判据】原来这里断的是「页面里有没有 `from '@/lib/agent/roles'` 这行」。
    // 那是拿**一行 import 冒充「名字来自 roles.ts」**：
    // 助手页只渲染 <RoleLadder here="assistant" />，名字是 RoleLadder 内部去取的，
    // 页面自己那行 import 从头到尾没被用过——清死 import 时才暴露出来。
    // 更糟的是：真有人在这一页把四类的说法写死、同时留着那行没用的 import，它照样绿。
    //（本会话在自己写的孤儿守卫上踩过同一形状：没被使用的 import 被算成了调用点。）
    //
    // 现在断的是它真正要守的三件事：
    //   ① 页顶/页尾确实挂了那个承担分工说明的组件（原来就有）
    //   ② 那个组件自己从 roles.ts 取名字（承接关系成立）
    //   ③ 直接用 AGENT_ROLES 的那种页，描述自己这一类时必须真的从 AGENT_ROLES.<key> 取
    //
    // 【③ 第一版也是假绿，变异当场抓到】原来写的是「出现写死的名字 → 断言文件里含 AGENT_ROLES」。
    // 可技能页别处本来就在用 AGENT_ROLES，断言恒真（「只验存在一处」那种形状）。
    // 而且「技能」这两个字在技能页正文里到处都是，拿**名字**做判据必然误报——
    // 能守住的是「这一类的说明有没有从 AGENT_ROLES.<key> 取」这个具体表达式。
    for (const [, , kind] of pages) {
      const comp = kind === 'tabs' ? 'components/RoleTabs.tsx' : 'components/RoleLadder.tsx';
      expect(code(comp), `${comp} 没从 roles.ts 取名字，页面挂了它也白挂`)
        .toMatch(/from '@\/lib\/agent\/roles'/);
    }
    for (const [file, key, kind] of pages) {
      const src = code(file);
      const want = kind === 'tabs' ? `RoleTabs active="${key}"` : `RoleLadder here="${key}"`;
      expect(src, `${file} 没挂 ${want}`).toMatch(new RegExp(want));

      // 【这一页描述自己是哪一类时，必须从 AGENT_ROLES 取，不许自己写一句】
      // 判据只对直接用 AGENT_ROLES 的那种页（tabs）成立；ladder 那种由组件承担，
      // 已经由上面「组件自己从 roles.ts 取」那一条守住了。
      if (kind === 'tabs') {
        expect(
          src,
          `${file} 描述「${key}」这一类时没走 AGENT_ROLES.${key}——自己写一句的话，`
          + 'roles.ts 改了它不会跟着改，界面上的分工与 AI 实际的派活逻辑就分叉了，'
          + '而这种不一致既不会红也不会 404，只会让用户觉得「这个 AI 不听话」。',
        ).toContain(`AGENT_ROLES.${key}.`);
      }
    }
  });
  // 那几句一句话描述又长又独特，谁也不会不小心打出一模一样的——
  // 一旦在别处出现，就一定是从 roles.ts 抄过去的第二份，而抄过去的那份不会跟着改。
  it('🔒 一句话描述不许被抄到 roles.ts 以外的任何地方', () => {
    const files = allSourceFiles().filter((f) => !f.endsWith('lib/agent/roles.ts'));
    for (const r of AGENT_ROLE_LIST) {
      for (const f of files) {
        expect(
          code(f),
          `${f} 里出现了「${r.name}」那句一句话描述的副本。roles.ts 是唯一真相源，`
          + '抄过去的那份不会跟着改，界面上的分工与 AI 实际的派活逻辑会慢慢分叉。',
        ).not.toContain(r.oneLine);
      }
    }
  });


  it('🔒 同一页不许既挂页签又挂分工梯——那是同一屏说两遍', () => {
    // 用户 2026-08-26 截图圈出来的正是这个：/skills 页顶「技能|智能体|能力」三个页签，
    // 紧接着又是「能力/技能/智能体/助手」四张卡，两处都是跳去另外几类。
    for (const f of ['app/(app)/workflows/page.tsx', 'app/(app)/skills/page.tsx', 'app/(app)/extension/page.tsx', 'app/(app)/assistant/page.tsx']) {
      const src = code(f);
      const both = /<RoleTabs\s/.test(src) && /<RoleLadder\s/.test(src);
      expect(both, `${f} 同时挂了页签与分工梯`).toBe(false);
    }
  });

  it('🔒 页签上的三个名字全部取自 roles.ts，不许硬编码', () => {
    // 名字写死的话，改 roles.ts 就会出现「页签叫插件、页面叫能力」
    const tabs = code('components/RoleTabs.tsx');
    for (const key of ['skill', 'agent', 'ability']) {
      expect(tabs, `页签里 ${key} 的名字不是从 roles.ts 取的`).toMatch(
        new RegExp(`AGENT_ROLES\\.${key}\\.name`),
      );
    }
  });

  it('分工梯必须**全量**渲染四类，不许过滤或截断', () => {
    // 同 StageTabs 那条守卫的理由：可发现性全靠这一处，藏掉一类 = 用户认为没这功能
    const src = code('components/RoleLadder.tsx');
    expect(src).toMatch(/AGENT_ROLE_LIST\.map\(/);
    expect(src).not.toMatch(/\.filter\(/);
    expect(src).not.toMatch(/\.slice\(/);
    // 当前这一类不做成链接：链到自己就是一个点了没反应的假入口
    expect(src).toMatch(/active \?/);
  });

  it('lib/agent/roles.ts 进得了客户端包——它被 lib/shell.ts 引用，而那被 ShellSwitch 引用', () => {
    // 同 lib/shell.ts 不许碰 next/headers 那条：tsc 全绿、单测全绿，只有真机打开页面才 Build Error
    const src = read('lib/agent/roles.ts');
    for (const forbidden of ['next/headers', '@/lib/db', "from '../db'", 'prisma']) {
      expect(src, `roles.ts 碰了 ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('派活次序：界面上写的和模型看到的是同一份', () => {
  it('次序是「大 → 小」，且给出了「什么时候不该派现成的」', () => {
    const block = dispatchOrderBlock();
    expect(block.indexOf(AGENT_ROLES.agent.name)).toBeLessThan(block.indexOf(AGENT_ROLES.skill.name));
    expect(block.indexOf(AGENT_ROLES.skill.name)).toBeLessThan(block.lastIndexOf(AGENT_ROLES.ability.name));
    expect(block).toMatch(/没有合适|只要其中一步/);
  });

  it('三类各自的 when 都进了这段话——漏一类，模型就永远想不起来那类', () => {
    for (const key of ['agent', 'skill', 'ability'] as const) {
      expect(dispatchOrderBlock(), `${key} 的 when 没进去`).toContain(AGENT_ROLES[key].when);
    }
  });
});

describe('任务台侧栏：术语与 roles.ts 同一套', () => {
  const items = TASK_NAV.flatMap((g) => g.items);

  it('智能体 / 技能 / 能力三个名字都出现在侧栏，且取自 roles.ts', () => {
    // 2026-08-26 起「班底」是合并入口（/skills，页顶 RoleTabs 互切），技能不再是独立 label——
    // 三个职能名可以出现在 label 或 hint 里，但**必须都出现**：用户在侧栏上找得到这三个词，
    // 才知道这三样东西存在。智能体/能力仍是抽屉里的独立入口（label 精确匹配）。
    const flat = items.map((i) => `${i.label} ${i.hint ?? ''}`).join(' ');
    for (const key of ['agent', 'skill', 'ability'] as const) {
      expect(flat.includes(AGENT_ROLES[key].name), `侧栏文本里找不到「${AGENT_ROLES[key].name}」`).toBe(true);
    }
    // 2026-08-26 扁平化：智能体/能力不再单列，由「技能 · 连接器」covers + 页顶标签承担。
    // 守的是**这一条真的声明了覆盖智能体**，不是「必须单列一条」。
    const hub = items.find((i) => i.href === '/skills');
    expect(hub?.covers ?? [], '技能·连接器没声明覆盖智能体，那智能体就真找不到了').toContain('/workflows');
    // 名字硬编码在 shell.ts 里的话，改 roles.ts 就会出现「侧栏叫插件、页面叫能力」——
    // skill 的名字进了合并入口的 hint，正则必须连它一起盯住
    // 2026-08-26 单壳化：导航真相源从 shell.ts 搬进 nav.ts，名字引用跟着搬
    expect(code('lib/nav.ts')).toMatch(/AGENT_ROLES\.skill\.name/);
    expect(code('lib/nav.ts')).toMatch(/AGENT_ROLES\.(agent|ability)\.name/);
  });

  it('「插件」这个词只留给浏览器扩展', () => {
    // 一个词两个意思是这一轮要收掉的东西：浏览器插件是「他要去装的」，
    // AI 能力是「AI 会替他做的」——后者跟智能体、技能是同一个问题的三个答案
    const plugin = items.filter((i) => i.label.includes('插件'));
    expect(plugin.length, '「插件」应当只对应一个入口').toBe(1);
    expect(plugin[0].href).toBe('/extension');
    // 而 AI 那批**不许**落在插件页上：用户 2026-08-26 当场问「为什么能力是跳转到插件去了」。
    // 能力是 AI 的工具集，跟装浏览器扩展是两件事，它的家在班底页的第三个标签。
    expect(AGENT_ROLES.ability.href).toBe('/skills?view=abilities');
    expect(AGENT_ROLES.ability.href, '能力又落回插件页了').not.toContain('/extension');
  });
});

describe('AI 真的认得这四类', () => {
  const byName = new Map(AGENT_TOOLS.map((t) => [t.name, t]));

  it('技能有「认人」和「派活」两个工具——少一个，用户装的技能对模型就不存在', () => {
    expect(byName.get('list_skills'), 'list_skills 没注册').toBeTruthy();
    const run = byName.get('run_skill');
    expect(run, 'run_skill 没注册').toBeTruthy();
    // 每次都是一次真实模型调用，且会写进草稿版本
    expect(run!.write).toBe(true);
    expect(run!.costly).toBe(true);
    expect(byName.get('list_skills')!.write, 'list_skills 是只读的，不该打断用户').toBe(false);
  });

  it('定时是起草制：可以拟，但绝不能由模型一个人签下去', () => {
    // 这条从前是「完全不给建」。改成起草制之后，不变式换了但**要守的东西没换**：
    // 定时是一份会在用户睡着时花钱的合约，模型永远不能单独落库。
    expect(byName.get('list_schedules')?.write, '看一眼不该打断用户').toBe(false);

    // 凡是能碰定时计划的工具，一律必须是写操作（= 必过确认闸）。
    // 把 draft_schedule 改成 write:false，提示词一个字不用动，模型就能自己把合约签了
    const touchers = AGENT_TOOLS.filter((t) => /schedule/i.test(t.name) && t.name !== 'list_schedules');
    expect(touchers.length, '起草工具没注册').toBeGreaterThan(0);
    for (const t of touchers) {
      expect(t.write, `${t.name} 必须是写操作，否则它绕过了确认闸`).toBe(true);
    }
  });

  // ⚠️ 「image 技能要在花钱之前挡掉」「Mock 产出不许落库」这两条**不在这儿断言源码**：
  // 试过，是假绿——把 `if (skill.outputKind === 'image')` 改成 `if (false && …)`，
  // 字符串还在、位置也还在 runSkill 之前，扫源码的守卫照过不误，而闸门已经没了。
  // 它们在 tests/agent/skill-tool.test.ts 里以行为验证（真的没调 runSkill、真的没落库），
  // 那四条都做过 mutation：关掉闸门 / 挪到之后 / 照样落库 / 去掉归属校验，全部变红。
});

// ── 单工具次数上限必须够得着（2026-08-30 修）───────────────────────────────
//
// PER_RUN_TOOL_CAP 里那几个工具全都是 write，而默认授权档是「每一步都要确认」。
// 原来 toolCapReason 挂在确认闸**下面**、紧挨着 executeCall：
//   · 走确认那条路 → 在 mustConfirm 那里就 break 了，永远到不了 cap 闸；
//   · 用户点确认之后走 decidePendingCall → 那条路直接 executeCall，也没有这道闸。
// 于是这几个上限**一次都没生效过**——写了、也有用例，就是够不着。
// 用例当时是绿的，因为它们直接调 toolCapReason，没有走真实的执行路径。
describe('🔒 单工具上限：闸要挂在够得着的地方', () => {
  const runSrc = code('lib/agent/run.ts');

  it('cap 闸在确认闸之前（否则确认档下永远到不了）', () => {
    orderedBefore(runSrc, 'const capped = await toolCapReason(runId, call.name);',
      'if (tool && (await mustConfirm(ctx, runId, tool, call))');
  });

  it('🔒 有上限的工具确实都是 write（这条前提没了就该重新想这道闸挂哪儿）', () => {
    // 前提变了要么说明有人加了只读的 costly 工具，要么说明 write 标记被改了。
    // 两种都该让人来看一眼，而不是让上面那条守卫继续绿着。
    const capped = Object.keys(PER_RUN_TOOL_CAP);
    expect(capped.length).toBeGreaterThan(2);
    for (const name of capped) {
      const t = AGENT_TOOLS.find((x) => x.name === name);
      expect(t, `PER_RUN_TOOL_CAP 里的 ${name} 不在工具表里`).toBeTruthy();
      expect(t!.write || t!.costly, `${name} 既不是写操作也不花钱，为什么要限次？`).toBe(true);
    }
  });

  it('超了上限就不去问用户（不该弹一张注定被拒的确认卡）', () => {
    // cap 命中时 continue，压根走不到 mustConfirm
    const seg = between(runSrc, 'const capped = await toolCapReason(runId, call.name);',
      'if (tool && (await mustConfirm(ctx, runId, tool, call))');
    expect(seg).toContain('continue;');
  });
});
