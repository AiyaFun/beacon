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
    expect(text).toContain('采集插件：已连接');
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
    expect(text).toContain('采集插件：没装');
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
      data: { workspaceId, token: `bcn_${Math.random().toString(36).slice(2)}`, label: 'dev', memberId, lastUsedAt: new Date() },
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
