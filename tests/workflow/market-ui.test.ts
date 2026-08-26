import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'app/(app)/workflows/WorkflowMarket.tsx'), 'utf8');

describe('模板市场的「跑着…」只能落在被点的那一张卡上', () => {
  // 真机撞到的：useTransition 的 pending 是整个组件共享的一个布尔，
  // 拿它渲按钮文字 → 点一张卡，三张卡同时显示「跑着…」，
  // 看上去像三条会花额度的智能体一起开跑了。
  it('按钮文字按 id 比对，不是直接读 pending', () => {
    const btn = SRC.match(/\{[^{}]*\?\s*'跑着…'\s*:\s*'跑一遍'[^{}]*\}/);
    expect(btn, '找不到「跑着…/跑一遍」这个三元').toBeTruthy();
    expect(btn![0]).toMatch(/busyId\s*===\s*t\.id/);
    expect(btn![0]).not.toMatch(/\bpending\s*\?/);
  });

  it('点下去先记下是哪一张，动作回来后清掉', () => {
    const fn = SRC.slice(SRC.indexOf('function doRun('), SRC.indexOf('function simple('));
    expect(fn).toMatch(/setBusyId\(t\.id\)/);
    // 必须在 await 之后立刻清，且早于任何 return——否则失败那条会一直卡在「跑着…」
    expect(fn).toMatch(/await actRunWorkflow\(t\.id\);\s*\n\s*setBusyId\(''\);/);
  });
});
