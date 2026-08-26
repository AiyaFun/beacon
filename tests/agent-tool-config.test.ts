import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readToolConfig, writeToolConfig, disabledTools, toolsFor, toolCatalog } from '@/lib/agent/tool-config';
import { AGENT_TOOLS } from '@/lib/agent/tools';

const ROOT = path.resolve(__dirname, '..');
const code = (p: string) =>
  fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('「插件」开关：缺省全开', () => {
  it('空配置 = 全部可用（加了新工具不该要求每个工作区先去打开一次）', () => {
    const cfg = readToolConfig('{}');
    expect(Object.keys(cfg).length).toBe(AGENT_TOOLS.length);
    expect(Object.values(cfg).every(Boolean)).toBe(true);
    expect(disabledTools('{}')).toEqual([]);
    expect(disabledTools(null)).toEqual([]);
  });

  it('坏 JSON 不许把 AI 变成哑巴——回落全开', () => {
    expect(disabledTools('{不是 json')).toEqual([]);
    // 下面这三个都是**合法** JSON，parseJson 的兜底不会生效，返回的却不是对象。
    // 第一版在这里真的崩了（Cannot read properties of null），整个助手页 500
    expect(Object.values(readToolConfig('null')).every(Boolean)).toBe(true);
    expect(Object.values(readToolConfig('[]')).every(Boolean)).toBe(true);
    expect(Object.values(readToolConfig('123')).every(Boolean)).toBe(true);
    expect(() => writeToolConfig('null', 'create_draft', false)).not.toThrow();
  });

  it('只有显式 false 才算关；配置里的陌生键不影响真工具', () => {
    expect(disabledTools('{"create_draft":false}')).toEqual(['create_draft']);
    expect(disabledTools('{"create_draft":true}')).toEqual([]);
    expect(disabledTools('{"早就删掉的工具":false}')).toEqual([]);
  });

  it('写配置只记「被关掉的」，打开等于删键——不把当前默认值固化成显式配置', () => {
    const off = writeToolConfig('{}', 'create_draft', false);
    expect(JSON.parse(off)).toEqual({ create_draft: false });
    const on = writeToolConfig(off, 'create_draft', true);
    expect(JSON.parse(on)).toEqual({});
  });
});

describe('两个判据必须一起收口', () => {
  it('toolsFor = 角色有权限 ∩ 工作区没关掉', () => {
    const all = toolsFor('owner', []);
    expect(all.length).toBe(AGENT_TOOLS.length);

    const someName = AGENT_TOOLS[0].name;
    const cut = toolsFor('owner', [someName]);
    expect(cut.map((t) => t.name)).not.toContain(someName);
    expect(cut.length).toBe(all.length - 1);

    // 只读角色本来就拿不到写工具，与开关无关
    const viewer = toolsFor('viewer', []);
    expect(viewer.every((t) => !t.write)).toBe(true);
  });

  it('不许复活 toolsForRole——它只查权限不查开关，是条绕开开关的近路', () => {
    expect(code('lib/agent/tools.ts')).not.toMatch(/export function toolsForRole/);
    for (const f of ['lib/agent/run.ts', 'app/(app)/assistant/page.tsx', 'app/(app)/assistant/agent-actions.ts']) {
      expect(code(f), `${f} 还在用 toolsForRole`).not.toMatch(/toolsForRole/);
    }
  });

  it('执行时必须再查一次开关——只从清单里拿掉，模型会凭记忆继续调', () => {
    const run = code('lib/agent/run.ts');
    // executeCall 里那道拦截：没有它，被关掉的工具照样执行成功且不报错
    const exec = run.slice(run.indexOf('async function executeCall'));
    expect(exec).toMatch(/offTools\(ctx\.workspaceId\)/);
    expect(exec).toMatch(/已被工作区关闭/);
  });

  it('两个界面入口都过一遍开关，否则会显示一个调不动的工具', () => {
    expect(code('app/(app)/assistant/page.tsx')).toMatch(/availableTools\(s\.role, disabledTools\(/);
    expect(code('app/(app)/assistant/agent-actions.ts')).toMatch(/availableTools\(s\.role, disabledTools\(/);
  });
});

describe('智能体这两个工具要真的被用起来', () => {
  it('list_agents / run_agent 都在注册表里，且 run_agent 必定要确认', async () => {
    const { AGENT_TOOLS, needsConfirm } = await import('@/lib/agent/tools');
    const list = AGENT_TOOLS.find((t) => t.name === 'list_agents');
    const run = AGENT_TOOLS.find((t) => t.name === 'run_agent');
    expect(list, 'list_agents 没注册').toBeTruthy();
    expect(run, 'run_agent 没注册').toBeTruthy();
    // 它是这批工具里最贵的一个：一条模板每步都可能调模型/生图
    expect(run!.write).toBe(true);
    expect(run!.costly).toBe(true);
    expect(needsConfirm(run!), 'run_agent 必须停下来问用户').toBe(true);
    expect(needsConfirm(list!), 'list_agents 是只读的，不该打断用户').toBe(false);
  });

  it('系统提示要明说派活次序——只在工具清单里列名字，模型会自己一步步做', async () => {
    const { dispatchOrderBlock } = await import('@/lib/agent/roles');
    const src = code('lib/agent/run.ts');
    const prompt = src.slice(src.indexOf('function systemPrompt'), src.indexOf('async function loadContext'));

    // 次序那一段由 roles.ts 生成——**界面上写给用户看的四类分工，和模型看到的是同一份**。
    // 光在这里断言源码里出现过「智能体」三个字是抓不住退化的：真正的退化形状是
    // 「roles.ts 改了措辞，而 run.ts 里还留着一段手写的旧说法」，两份并存且不报错。
    expect(prompt, 'systemPrompt 没接 roles.ts 那份派活次序').toMatch(/dispatchOrderBlock\(/);

    const block = dispatchOrderBlock();
    expect(block, '次序里没提智能体').toMatch(/智能体/);
    expect(block, '次序里没提技能').toMatch(/技能/);
    // 顺序是「大→小」：先问有没有现成的一整套，再退到一次成品，最后才自己拼
    expect(block.indexOf('智能体'), '智能体必须排在技能前面').toBeLessThan(block.indexOf('技能'));
    // 也要给出「什么时候不该派」，否则它会硬套
    expect(block, '没说什么时候不该派现成的').toMatch(/没有合适|只要其中一步/);

    // 认人的两条路都要教到，缺一条那类就成了摆设
    for (const t of ['list_agents', 'run_agent', 'list_skills', 'run_skill']) {
      expect(prompt, `提示里没教 ${t}`).toContain(t);
    }

    // 【喂给模型的那句「会不会先问你」必须跟着授权档走】写死一句「会先弹给用户确认」
    // 不是提示词不准，是**让模型替我们撒谎**：预授权的运行里它会照着这句对用户说
    // 「这一步我会先问你」，然后直接做了。08-13 审计过的 11 条「文案与实际行为相反」是同一形状。
    expect(prompt, 'systemPrompt 里那句「会先问你」写死了，没按授权档拼').toMatch(/writeConfirmLine\(authMode\)/);
    const each = dispatchOrderBlock('confirm_each');
    const pre = dispatchOrderBlock('preauthorized');
    const un = dispatchOrderBlock('unattended');
    expect(each, '缺省档要说会先停下来问').toMatch(/先停下来问/);
    expect(pre, '预授权档不该还承诺「会先停下来问」').not.toMatch(/会先停下来问用户/);
    expect(pre, '预授权档要说清「授权过的不问、没授权的还问」').toMatch(/不用再问|直接做/);
    // 无人值守下**仍然**要告诉模型：签合约那几样照样停（那是机制级的闸，不是提示词客气话）
    expect(un, '无人值守档没说清 contract 工具照样要等确认').toMatch(/定时|发布计划|记忆/);
    // 定时是一份**会在用户不在场时花钱的合约**。策略从「完全不给」改成了「起草制」：
    // 模型可以拟一条，但落库必须过用户这一关。
    //
    // 【守机制，不只守措辞】提示词只降低概率，真正的保证是 write:true 带来的确认闸——
    // 所以这里两样都验，而且下面那条才是硬的：把 draft_schedule 改成 write:false，
    // 提示词一个字不动，模型就能自己把合约签了。
    expect(prompt, '没教它先看已有的计划').toMatch(/list_schedules/);
    expect(prompt, '没告诉模型它只是在起草').toMatch(/起草|让用户确认/);
    for (const name of ['draft_schedule', 'draft_workflow']) {
      const tool = AGENT_TOOLS.find((t) => t.name === name);
      expect(tool, `${name} 没注册`).toBeTruthy();
      expect(tool!.write, `${name} 必须是写操作，否则模型能绕过确认直接落库`).toBe(true);
    }
  });
});

describe('清单页要说清每个能力的性质', () => {
  it('每条都带 label / 说明 / 会不会改数据 / 花不花钱', () => {
    const rows = toolCatalog('owner', '{}');
    expect(rows.length).toBe(AGENT_TOOLS.length);
    for (const r of rows) {
      expect(r.label, `${r.name} 没有中文名`).toBeTruthy();
      expect(r.description.length, `${r.name} 说明太短`).toBeGreaterThanOrEqual(8);
      expect(typeof r.write).toBe('boolean');
      expect(typeof r.costly).toBe('boolean');
    }
    // 写操作确实存在（这条守住「全标成只读」这种退化）
    expect(rows.filter((r) => r.write).length).toBeGreaterThan(0);
  });

  it('角色用不了的工具照样列出来，只是标明——藏起来会让人以为 AI 没这能力', () => {
    const rows = toolCatalog('viewer', '{}');
    expect(rows.length).toBe(AGENT_TOOLS.length);
    expect(rows.some((r) => !r.allowedByRole)).toBe(true);
  });
});
