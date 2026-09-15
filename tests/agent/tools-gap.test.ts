import { describe, it, expect } from 'vitest';
import { toolByName, AGENT_TOOLS } from '@/lib/agent/tools';
import { parseGap, gapDevPrompt } from '@/lib/agent/gap-prompt';
import { looksLikeGaveUp } from '@/lib/agent/run';

// 执行器那道硬闸：说做不到却没记缺口 → 打回一次。判据是纯函数，逐条钉住。
describe('looksLikeGaveUp', () => {
  const tools = [{ name: 'add_account' }, { name: 'report_capability_gap' }];
  const noCall: { role: string; toolCalls?: { name: string }[] }[] = [{ role: 'user' }, { role: 'assistant', toolCalls: [{ name: 'list_accounts' }] }];

  it('2026-09-09 真机那段「抱歉，我无法直接执行…建议您登录系统进入管理页面」要被认出来', () => {
    const text = '抱歉，我无法直接执行这个操作。作为AI助手，我只能通过调用系统提供的API来完成特定任务，而升级成员权限这样的操作需要通过系统管理界面或由系统管理员手动完成。建议您：1. 登录烽火台系统 2. 进入工作区管理页面';
    expect(looksLikeGaveUp(text, tools, noCall)).toBe(true);
  });

  it('「我没有添加自有账号的工具，需要你自己去页面添加」也算', () => {
    expect(looksLikeGaveUp('抱歉，我没有添加自有账号的工具。需要你自己去系统里的「账号」页面添加 X 账号。', tools, noCall)).toBe(true);
  });

  it('已经调过 report_capability_gap 的这次运行不再打回（否则会无限循环）', () => {
    const called = [...noCall, { role: 'assistant', toolCalls: [{ name: 'report_capability_gap' }] }];
    expect(looksLikeGaveUp('我无法直接执行，已记下缺口。', tools, called)).toBe(false);
  });

  it('这次运行没有 report_capability_gap 可调（职能 bot 白名单外）就不判', () => {
    expect(looksLikeGaveUp('我无法直接执行这个操作。', [{ name: 'add_account' }], noCall)).toBe(false);
  });

  it('正常交付不误伤：说「已添加」「以下是结果」不算摊手', () => {
    expect(looksLikeGaveUp('我已经将你的 X 账号添加进来了，现在你的账号列表如下：1. X @aiyafun', tools, noCall)).toBe(false);
    expect(looksLikeGaveUp('这个账号还没有作品数据，先派一次采集再看。', tools, noCall)).toBe(false);
  });
});

// 「做不到 → 记缺口 → 补能力」这条环的三个接点：
//   ① 工具在册且不算写操作（它只是留痕，不该被授权卡拦成「改我的内容」）；
//   ② 缺口说不清（need/missing 缺一）就拒收——记一条空缺口比不记更糟，会污染 ops 页的归并；
//   ③ 开发提示里四样齐全（用户原话 / 缺什么 / 建议工具与参数 / 手动路径），少一样开发者就得回头猜。

const ctx = { tenantId: 't', workspaceId: 'w', accountId: 'a', memberId: 'm', role: 'owner' };

describe('report_capability_gap', () => {
  it('① 在册，且是只读工具', () => {
    const t = toolByName('report_capability_gap');
    expect(t).not.toBeNull();
    expect(AGENT_TOOLS.some((x) => x.name === 'report_capability_gap')).toBe(true);
    expect(t!.write).toBe(false);
    expect(t!.costly).toBeFalsy();
    expect(t!.contract).toBeFalsy();
  });

  it('② need / missing 缺一就拒收', async () => {
    const t = toolByName('report_capability_gap')!;
    expect((await t.run(ctx, { need: '加 X 账号' })).ok).toBe(false);
    expect((await t.run(ctx, { missing: '没有加账号的工具' })).ok).toBe(false);
    expect((await t.run(ctx, {})).ok).toBe(false);
  });

  it('记下之后的 summary 要把用户支回「现在怎么手动做」，不许只说记下了', async () => {
    const t = toolByName('report_capability_gap')!;
    const r = await t.run(ctx, { need: '加 X 账号', missing: '没有加账号的工具', tool: 'add_account', manual: '记忆与人设 → 账号管理' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('记忆与人设 → 账号管理');
    expect(r.summary).toContain('add_account');
  });
});

describe('gapDevPrompt', () => {
  it('③ 四样齐全都进提示，且写明工具契约的三个标记', () => {
    const gap = parseGap({ need: '帮我加 X 账号', missing: '没有加自有账号的工具', tool: 'add_account', params: 'platform + handle', manual: '记忆与人设 → 账号管理' });
    const p = gapDevPrompt(gap, '帮我去采集 x 的账号');
    for (const s of ['帮我去采集 x 的账号', '帮我加 X 账号', '没有加自有账号的工具', 'add_account', 'platform + handle', '记忆与人设 → 账号管理', 'write:true', 'costly:true', 'contract:true', 'AGENT_TOOLS']) {
      expect(p, s).toContain(s);
    }
  });

  it('goal 与 need 相同时不重复印两遍', () => {
    const gap = parseGap({ need: '加 X 账号', missing: '缺工具' });
    const p = gapDevPrompt(gap, '加 X 账号');
    expect(p.split('加 X 账号').length - 1).toBe(1);
  });

  it('parseGap 只认字符串，空串当没填', () => {
    const g = parseGap({ need: '  x ', missing: 1, tool: '', params: undefined });
    expect(g).toEqual({ need: 'x', missing: '', tool: undefined, params: undefined, manual: undefined });
  });
});
