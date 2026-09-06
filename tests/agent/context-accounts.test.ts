import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';
import { loadAccountsContext, renderAccountsContext } from '@/lib/agent/context-accounts';

// 系统提示里的「你的账号与插件」（2026-09-03）。
// 用户原话：「抓取我的 x 账号，我们都有 x 账号的信息和插件的信息，应该要有所关联」。

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

let workspaceId = '';
let memberId = '';
beforeEach(async () => {
  await prisma.tenant.deleteMany();
  const t = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  const w = await prisma.workspace.create({ data: { tenantId: t.id, name: 'W' } });
  workspaceId = w.id;
  const m = await prisma.member.create({ data: { tenantId: t.id, name: '张三', role: 'owner' } });
  memberId = m.id;
});

describe('渲染', () => {
  it('列出每个账号的平台/名字/handle，标出当前那条，并说清插件状态', () => {
    const text = renderAccountsContext({
      accounts: [
        { id: 'a1', name: '小红书号', platform: 'xiaohongshu', handle: null, current: true },
        { id: 'a2', name: 'Aiya哎呀', platform: 'x', handle: '@aiyafun', current: false },
      ],
      plugin: { installed: true, lastSeenAt: new Date('2026-09-03T02:00:00Z') },
      localBrowser: 'off',
    });
    expect(text).toContain('【你的账号与插件】');
    expect(text).toContain('「Aiya哎呀」（handle：aiyafun）');
    expect(text).toContain('「小红书号」（没填 handle） ← 当前');
    expect(text).toContain('采集执行器：浏览器插件已连接');
    expect(text).toContain('本机浏览器：未开启');
    // 走哪条路由系统定，不许反问用户选
    expect(text).toContain('不要问用户选');
    expect(text).toContain('不要把工具调用写成 JSON 块');
    // 明确告诉模型：直接派，不要反问
    expect(text).toContain('dispatch_browser_task(kind=collect_self');
    expect(text).toContain('不要再问他要主页链接');
  });

  it('没装插件 / 没账号也如实说，不留空', () => {
    const text = renderAccountsContext({ accounts: [], plugin: { installed: false, lastSeenAt: null }, localBrowser: 'ready' });
    expect(text).toContain('还没有账号');
    expect(text).toContain('没有任何采集执行器');
    expect(text).toContain('本机浏览器：就绪');
    expect(text).toContain('当场跑完');
  });

  it('开了但 Chrome 没带端口跑着：说破只能排插件，并给出叫起来的那句话', () => {
    const text = renderAccountsContext({ accounts: [], plugin: { installed: true, lastSeenAt: null }, localBrowser: 'offline' });
    expect(text).toContain('本机浏览器：已开启但此刻没在跑');
    expect(text).toContain('开启浏览器操作');
  });
});

describe('从库里读', () => {
  it('账号来自本工作区（别的工作区的不出现），插件状态看采集令牌', async () => {
    const a = await prisma.creatorAccount.create({ data: { workspaceId, name: 'X号', platform: 'x', handle: 'me' } });
    const other = await prisma.workspace.create({ data: { tenantId: (await prisma.tenant.findFirstOrThrow()).id, name: 'O' } });
    await prisma.creatorAccount.create({ data: { workspaceId: other.id, name: '别人的', platform: 'x', handle: 'other' } });

    const none = await loadAccountsContext({ workspaceId, accountId: a.id });
    expect(none.accounts.map((x) => x.name)).toEqual(['X号']);
    expect(none.accounts[0].current).toBe(true);
    expect(none.plugin.installed).toBe(false);
    expect(none.localBrowser).toBe('off'); // 测试进程是 SaaS 语义：形态第一道就关

    await prisma.ingestToken.create({
      data: { lastUsedAt: new Date(),  workspaceId, token: `bcn_${Math.random().toString(36).slice(2)}`, label: 'dev', memberId },
    });
    const withPlugin = await loadAccountsContext({ workspaceId, accountId: null });
    expect(withPlugin.plugin.installed).toBe(true);
    expect(withPlugin.plugin.lastSeenAt).toBeInstanceOf(Date);
  });
});

describe('🔒 真的拼进了系统提示', () => {
  it('startAgentRun 的 loadContext 取了这一段，并传给 systemPrompt', () => {
    const src = read('lib/agent/run.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).toContain("import { accountsContextBlock } from './context-accounts';");
    expect(src).toContain('accountsContextBlock({ workspaceId: ctx.workspaceId, accountId: ctx.accountId })');
    expect(src).toContain('auth.authMode, accounts)');
  });
});

describe('执行器状态必须如实告诉模型（2026-09-04 真机：没插件却被劝去开浏览器）', () => {
  const base = { accounts: [], plugin: { installed: false, lastSeenAt: null }, localBrowser: 'off' as const };

  it('只登记了桌面客户端：说清「几秒内领走」，且明说别提插件', () => {
    const out = renderAccountsContext({ ...base, executors: ['desktop'] });
    expect(out).toMatch(/桌面客户端已登记为采集执行器/);
    expect(out).toMatch(/几秒内领走/);
    expect(out, '没说破「别让他去开浏览器」——模型会自己编出等插件那套').toMatch(/别提插件|别让他去开浏览器/);
  });

  it('两个都没有：如实说派不出去，不许说成「已排队等浏览器」', () => {
    const out = renderAccountsContext({ ...base, executors: [] });
    expect(out).toMatch(/没有任何采集执行器/);
    expect(out).toMatch(/派不出去/);
  });

  it('只有插件时才提「等下次打开浏览器」', () => {
    const out = renderAccountsContext({ ...base, plugin: { installed: true, lastSeenAt: null }, executors: ['plugin'] });
    expect(out).toMatch(/浏览器插件已连接/);
  });

  it('🔒 系统提示不许一律说「插件要等用户下次打开浏览器」，且不许把工具名当命令给用户', async () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'lib/agent/run.ts'), 'utf8');
    expect(src, '还在无条件说「插件要等用户下次打开浏览器才会跑」').not.toMatch(/它是\*\*排队\*\*：插件要等用户下次打开浏览器才会跑/);
    expect(src).toMatch(/谁来领、等多久，看下面/);
    expect(src, '没教它别把工具名当命令写给用户').toMatch(/不要把工具名（如 list_browser_tasks）当命令写给他看/);
  });
});
