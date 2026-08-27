import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'app/(app)/workflows/WorkflowMarket.tsx'), 'utf8');
const ACTIONS = readFileSync(join(process.cwd(), 'app/(app)/workflows/actions.ts'), 'utf8');

describe('「跑一遍」必须是派活，不许在 server action 里原地跑完', () => {
  // 真机撞到的：server action 在途时 Next 会把同一客户端的后续导航与其它 action
  // 全部排队。同步跑一条几分钟的工作流 = 用户点完「跑一遍」整个站点点不动：
  // 跳不了页、技能页安装/卸载全部灰死、而且全程没有任何进度显示。
  it('actStartWorkflow 只建行 + kick，立刻返回 runId', () => {
    const fn = ACTIONS.slice(ACTIONS.indexOf('export async function actStartWorkflow'));
    expect(fn).toMatch(/await createWorkflowRun\(/);
    expect(fn).toMatch(/\n\s*kickWorkflowRun\(ctx, runId\);/);
    // kick 绝不能被 await——await 了就又变回同步跑完
    expect(fn).not.toMatch(/await kickWorkflowRun/);
  });

  it('actions.ts 里不再有同步跑完的通道（runWorkflow / executeWorkflowRun 的调用都不许进来）', () => {
    // 只禁调用形态（带左括号）：注释里提到函数名是允许的，别学「被自己的注释骗」那次
    expect(ACTIONS).not.toMatch(/\brunWorkflow\(/);
    expect(ACTIONS).not.toMatch(/executeWorkflowRun\(/);
  });
});

describe('前端靠轮询看进度，进度是活的', () => {
  it('doRun 只派活：拿到 runId 交给 watchId，失败当场清 busyId', () => {
    const fn = SRC.slice(SRC.indexOf('function doRun('), SRC.indexOf('function simple('));
    expect(fn).toMatch(/setBusyId\(t\.id\)/);
    expect(fn).toMatch(/await actStartWorkflow\(t\.id\)/);
    expect(fn).toMatch(/setWatchId\(r\.runId\)/);
    // 失败分支必须先清 busyId 再 return，否则那张卡永远「跑着…」
    expect(fn).toMatch(/setBusyId\(''\);\s*\n\s*setErr\(/);
  });

  it('轮询读 actReadWorkflowRun，到终态清 watchId/busyId 并刷新服务端数据', () => {
    const eff = SRC.slice(SRC.indexOf('useEffect(() => {\n    if (!watchId) return;'));
    expect(eff).toMatch(/await actReadWorkflowRun\(watchId\)/);
    expect(eff).toMatch(/if \(r\.run\.status !== 'running'\) \{\s*\n\s*stopWatching\(\);\s*\n[\s\S]{0,200}?router\.refresh\(\);/);
    // 轮询要有上限：跑飞的运行由巡检判死，前端不能无限转下去
    expect(eff).toMatch(/polls >= \d+/);
  });

  it('结果卡有 running 态（跑的过程看得见，不是跑完才冒出来）', () => {
    expect(SRC).toMatch(/status === 'running' \? '正在跑…'/);
    expect(SRC).toMatch(/第 \{run\.run\.stepIndex \+ 1\} 步正在进行/);
    // 跑动期间要给「任务记录」出口——离开这页后用户得知道去哪找它
    expect(SRC).toMatch(/href="\/runs"/);
  });
});

describe('「跑着…」只能落在被点的那一张卡上', () => {
  // 真机撞到的：useTransition 的 pending 是整个组件共享的一个布尔，
  // 拿它渲按钮文字 → 点一张卡，三张卡同时显示「跑着…」，
  // 看上去像三条会花额度的智能体一起开跑了。
  it('按钮文字按 id 比对，不是直接读 pending', () => {
    const btn = SRC.match(/\{[^{}]*\?\s*'跑着…'\s*:\s*'跑一遍'[^{}]*\}/);
    expect(btn, '找不到「跑着…/跑一遍」这个三元').toBeTruthy();
    expect(btn![0]).toMatch(/busyId\s*===\s*t\.id/);
    expect(btn![0]).not.toMatch(/\bpending\s*\?/);
  });

  it('有一条在跑时不许再派第二条（结果卡只有一张，进度会互相顶掉）', () => {
    expect(SRC).toMatch(/disabled=\{pending \|\| watchId !== null\} onClick=\{\(\) => doRun\(t\)\}/);
  });

  // 跳走再回来时组件状态全丢：不接回正在跑的那条，「跑一遍」恢复可点，
  // 同一条模板会被再派一次——真双跑、双花额度（改异步后才可能发生，同步版是靠卡死挡住的）
  it('回到页面要接回正在跑的那条：服务端查 running+manual 传进来，作为 watchId/busyId 初值', () => {
    const page = readFileSync(join(process.cwd(), 'app/(app)/workflows/page.tsx'), 'utf8');
    expect(page).toMatch(/status: 'running', trigger: 'manual'/);
    expect(page).toMatch(/activeRun=\{activeRun \? \{ runId: activeRun\.id, templateId: activeRun\.templateId \} : null\}/);
    expect(SRC).toMatch(/useState\(activeRun\?\.templateId \?\? ''\)/);
    expect(SRC).toMatch(/useState<string \| null>\(activeRun\?\.runId \?\? null\)/);
  });
});

describe('技能页安装/卸载只暗被点的那一张', () => {
  // 用户报的：点任何一张卡的安装/卸载，全部卡的按钮一起灰掉，看上去像整页坏了
  it('disabled 按 busyId 比对，不是整组件共享的 pending', () => {
    const skl = readFileSync(join(process.cwd(), 'app/(app)/skills/SkillCenter.tsx'), 'utf8');
    const btn = skl.match(/<button[^>]*disabled=\{[^}]*\}[^>]*\n[^>]*onClick=\{\(\) => toggleInstall\(skl\)\}/);
    expect(btn, '找不到安装/卸载按钮').toBeTruthy();
    expect(btn![0]).toMatch(/disabled=\{busyId === skl\.id && pending\}/);
  });
});
