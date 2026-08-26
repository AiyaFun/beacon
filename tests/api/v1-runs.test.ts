import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db';
import { issueApiToken, revokeApiToken, resolveApiToken, listApiTokens } from '@/lib/api/token';

// 对外调用面（批 5B）：让别的程序驱动这台烽火台。
//
// 【它补的是最初那句需求】「像 OpenClaw 一样部署到 Mac mini 上直接调用使用」——
// 在此之前让烽火台干活的唯一入口是网页，脚本和 MCP 客户端都够不着它。
//
// 【这份用例守的四件事】
//   ① **令牌绑到人**：不绑就回答不了「这次调用按谁的权限算」，
//      而 AI 执行的每一步权限都是按发起人算的；
//   ② 权限**每次现查**：昨天签的令牌用的是这个人今天的权限；
//   ③ **SaaS 上整条路不存在**：那边的边界是公网，多开一条「拿到一串字符就能代人操作」
//      的通道要配套一整套东西，而这条能力的动机本来就是本机部署；
//   ④ **不暴露确认**：调用方常常是另一个模型，让模型 A 起草模型 B 代签，
//      「不让模型代签」那条规矩就没了。

const h = vi.hoisted(() => ({ edition: 'appliance' as string }));
vi.mock('@/lib/edition', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/edition')>();
  return { ...real, edition: () => h.edition };
});

let memberId: string;
let tenantId: string;
let workspaceId: string;
let accountId: string;

beforeEach(async () => {
  h.edition = 'appliance';
  await prisma.apiToken.deleteMany();
  const tenant = await prisma.tenant.create({ data: { name: 'T', plan: 'personal' } });
  tenantId = tenant.id;
  const ws = await prisma.workspace.create({ data: { tenantId, name: 'W' } });
  workspaceId = ws.id;
  const acc = await prisma.creatorAccount.create({
    data: { workspaceId, name: '我的号', platform: 'xiaohongshu', personaCard: '{}' },
  });
  accountId = acc.id;
  const m = await prisma.member.create({ data: { tenantId, name: '张三', role: 'owner' } });
  memberId = m.id;
});

afterEach(() => vi.unstubAllEnvs());

describe('令牌绑到人，权限每次现查', () => {
  it('换出来的上下文就是这个人的租户/工作区/账号/角色', async () => {
    const issued = await issueApiToken(memberId, '我的 Mac mini');
    const r = await resolveApiToken(issued.token);

    expect(r).toBeTruthy();
    expect(r!.ctx).toEqual({ tenantId, workspaceId, accountId, memberId, role: 'owner' });
  });

  it('**角色现查**：昨天签的令牌，用的是这个人今天的权限', async () => {
    const issued = await issueApiToken(memberId, 'x');
    await prisma.member.update({ where: { id: memberId }, data: { role: 'viewer' } });

    const r = await resolveApiToken(issued.token);
    // 缓存了角色的话，一个已经降权的人靠一枚旧令牌还能用管理员权限操作
    expect(r!.ctx.role, '角色要现查，不能缓存在令牌上').toBe('viewer');
  });

  it('成员被停用 → 令牌跟着失效（不用逐枚去吊销）', async () => {
    const issued = await issueApiToken(memberId, 'x');
    await prisma.member.update({ where: { id: memberId }, data: { status: 'suspended' } });
    expect(await resolveApiToken(issued.token)).toBeNull();
  });

  it('成员被删 → 令牌行随外键一起没了', async () => {
    const issued = await issueApiToken(memberId, 'x');
    await prisma.member.delete({ where: { id: memberId } });
    expect(await prisma.apiToken.count()).toBe(0);
    expect(await resolveApiToken(issued.token)).toBeNull();
  });

  it('吊销之后立刻不认', async () => {
    const issued = await issueApiToken(memberId, 'x');
    expect(await resolveApiToken(issued.token)).toBeTruthy();
    expect(await revokeApiToken(memberId, issued.id)).toBe(true);
    expect(await resolveApiToken(issued.token)).toBeNull();
  });

  it('吊销别人的令牌不行', async () => {
    const issued = await issueApiToken(memberId, 'x');
    const other = await prisma.member.create({ data: { tenantId, name: '李四', role: 'editor' } });
    expect(await revokeApiToken(other.id, issued.id), '拿到任意 id 就能吊销别人的令牌').toBe(false);
    expect(await resolveApiToken(issued.token)).toBeTruthy();
  });
});

describe('令牌明文只给一次', () => {
  it('列表里只回前缀，拼不出完整令牌', async () => {
    const issued = await issueApiToken(memberId, '我的 Mac mini');
    const rows = await listApiTokens(memberId);

    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('我的 Mac mini');
    // 能再看一遍就意味着它随时可读，那么任何一次会话劫持都等于拿到长期凭证
    expect(rows[0].prefix.length).toBeLessThan(issued.token.length);
    expect(issued.token.startsWith(rows[0].prefix.replace('…', ''))).toBe(true);
    expect(JSON.stringify(rows), '完整令牌不该出现在列表里').not.toContain(issued.token);
  });

  it('前缀与采集令牌一眼可分（排查时不至于看混）', async () => {
    const issued = await issueApiToken(memberId, 'x');
    expect(issued.token.startsWith('bck_')).toBe(true);
    expect(issued.token.startsWith('bcn_'), '与采集令牌撞前缀了').toBe(false);
  });
});

describe('乱来的令牌一律不认', () => {
  it('空 / 前缀不对 / 不存在，都回 null', async () => {
    for (const bad of ['', '   ', 'bcn_something', 'random', 'bck_notexist']) {
      expect(await resolveApiToken(bad), `${bad} 不该通过`).toBeNull();
    }
  });

  it('认 Bearer 前缀（HTTP 头里带着它来）', async () => {
    const issued = await issueApiToken(memberId, 'x');
    expect(await resolveApiToken(`Bearer ${issued.token}`)).toBeTruthy();
  });
});

describe('SaaS 上整条路不存在', () => {
  it('形态是 saas 时，令牌换不出上下文', async () => {
    const issued = await issueApiToken(memberId, 'x');
    h.edition = 'saas';
    expect(await resolveApiToken(issued.token), 'SaaS 的边界是公网，这条通道要单独评估').toBeNull();
  });
});

describe('刻意不做的事', () => {
  const read = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');

  it('调用面**没有确认接口**——不让模型代签', () => {
    // 调 MCP 的通常是另一个模型。模型 A 起草、模型 B 代签，
    // 「睡着时花钱的合约不让模型代签」那条规矩就形同虚设
    for (const p of ['app/api/v1/runs/route.ts', 'app/api/v1/runs/[id]/route.ts', 'mcp-server.ts']) {
      const src = read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(src, `${p} 里出现了确认动作`).not.toMatch(/decidePendingCall|actDecideAgentStep/);
    }
  });

  it('MCP 只暴露三个只读/发起类工具，没有 confirm', () => {
    const src = read('mcp-server.ts');
    expect(src).toMatch(/beacon_run\b/);
    expect(src).toMatch(/beacon_run_status/);
    expect(src).toMatch(/beacon_recent_runs/);
    expect(src, 'MCP 暴露了确认工具').not.toMatch(/name: 'beacon_confirm/);
  });

  it('停在等确认时要告诉调用方「去哪儿点」（它是个程序，不知道网页在哪）', () => {
    const route = read('app/api/v1/runs/[id]/route.ts');
    expect(route, '卡着不动最容易被当成挂了').toMatch(/needsConfirm/);
    expect(route).toMatch(/assistant\?run=/);
  });

  it('不为 API 另开一套执行逻辑（否则两边的闸迟早各走各的）', () => {
    const src = read('app/api/v1/runs/route.ts');
    expect(src, 'API 要走与网页同一个 startAgentRun').toMatch(/startAgentRun/);
  });

  it('中间件放行了 /api/v1（调用方不带登录 cookie）', () => {
    expect(read('middleware.ts')).toMatch(/'\/api\/v1'/);
  });
});
