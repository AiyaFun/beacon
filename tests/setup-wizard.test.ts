import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { prisma } from '@/lib/db';
import {
  isInitialized,
  needsSetup,
  setupTokenConfigured,
  setupTokenOk,
  assertSetupAllowed,
  resetInitializedCache,
  SetupClosedError,
} from '@/lib/setup/state';

// 装机向导的状态判定。这一层决定「谁能成为这台机器的管理员」，
// 每一条分支都要往安全的方向倒：拿不准就不让装。

const TOKEN = 'a'.repeat(32);

async function seedOneMember() {
  const t = await prisma.tenant.create({ data: { name: '装机测试', plan: 'enterprise' } });
  await prisma.member.create({ data: { tenantId: t.id, name: '管理员', role: 'owner' } });
}


beforeEach(() => {
  resetInitializedCache();
  vi.stubEnv('BEACON_EDITION', 'appliance');
  vi.stubEnv('BEACON_SETUP_TOKEN', TOKEN);
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetInitializedCache();
});

describe('needsSetup()', () => {
  it('SaaS 上恒为 false —— 线上不存在装机向导这回事', async () => {
    vi.stubEnv('BEACON_EDITION', 'saas');
    expect(await needsSetup()).toBe(false);
  });

  it('空库 = 还没装过 → 需要装机', async () => {
    await prisma.member.deleteMany();
    resetInitializedCache();
    expect(await isInitialized()).toBe(false);
    expect(await needsSetup()).toBe(true);
  });

  it('库里一出现成员就算装过，且这条边不回头（只缓存 true）', async () => {
    await prisma.member.deleteMany();
    resetInitializedCache();
    expect(await isInitialized()).toBe(false);
    await seedOneMember();
    // 上一次查出来的 false 不许被缓存 —— 否则装机那一刻的并发请求会各自看到过期状态
    expect(await isInitialized()).toBe(true);
    expect(await needsSetup()).toBe(false);
  });
});

describe('装机口令', () => {
  it('没配口令时一律不通过（fail closed）', () => {
    vi.stubEnv('BEACON_SETUP_TOKEN', '');
    expect(setupTokenConfigured()).toBe(false);
    expect(setupTokenOk('')).toBe(false);
    expect(setupTokenOk('anything')).toBe(false);
  });

  it('太短的口令不算配置过 —— 防止有人填个 "1" 当口令', () => {
    vi.stubEnv('BEACON_SETUP_TOKEN', '123');
    expect(setupTokenConfigured()).toBe(false);
    expect(setupTokenOk('123')).toBe(false);
  });

  it('正确口令通过，错误口令不通过，长度不同也不通过', () => {
    expect(setupTokenOk(TOKEN)).toBe(true);
    expect(setupTokenOk(' ' + TOKEN + ' ')).toBe(true); // 复制粘贴常带空白
    expect(setupTokenOk('b'.repeat(32))).toBe(false);
    expect(setupTokenOk('a'.repeat(31))).toBe(false);
  });
});

describe('assertSetupAllowed()', () => {
  it('SaaS 形态直接拒', async () => {
    vi.stubEnv('BEACON_EDITION', 'saas');
    await expect(assertSetupAllowed(TOKEN)).rejects.toThrow(SetupClosedError);
  });

  it('口令正确且未初始化 → 放行', async () => {
    await prisma.member.deleteMany();
    resetInitializedCache();
    await expect(assertSetupAllowed(TOKEN)).resolves.toBeUndefined();
  });

  it('口令不对就拒', async () => {
    await prisma.member.deleteMany();
    resetInitializedCache();
    await expect(assertSetupAllowed('wrong')).rejects.toThrow(/口令不正确/);
  });

  it('没配口令时拒，且提示去重跑安装脚本', async () => {
    await prisma.member.deleteMany();
    resetInitializedCache();
    vi.stubEnv('BEACON_SETUP_TOKEN', '');
    await expect(assertSetupAllowed('')).rejects.toThrow(/安装脚本/);
  });

  it('已初始化的实例拒绝再次装机 —— 否则谁都能再建一个 owner', async () => {
    await seedOneMember();
    resetInitializedCache();
    await expect(assertSetupAllowed(TOKEN)).rejects.toThrow(/已经初始化/);
  });
});

describe('路由接线（源码级）', () => {
  it('/setup 在 middleware 白名单里 —— 不然装机与登录互相死锁', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('middleware.ts', 'utf-8');
    const block = src.slice(src.indexOf('const PUBLIC_PATHS'), src.indexOf('];', src.indexOf('const PUBLIC_PATHS')));
    expect(block).toContain("'/setup'");
  });

  it('登录页与 (app)/layout 都会把未装机的人送去 /setup', async () => {
    const fs = await import('node:fs');
    for (const f of ['app/login/page.tsx', 'app/(app)/layout.tsx']) {
      const src = fs.readFileSync(f, 'utf-8');
      expect(src, `${f} 缺少装机跳转`).toMatch(/needsSetup\(\)\) redirect\('\/setup'\)/);
    }
  });

  it('向导的每个写操作都先过 assertSetupAllowed —— server action 即公开 RPC', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('app/setup/actions.ts', 'utf-8');
    const actions = src.match(/export async function act\w+/g) ?? [];
    expect(actions.length).toBeGreaterThanOrEqual(2);
    // actEdition 只读、不写，不要求过闸；两个会碰状态的都必须过。
    for (const name of ['actCompleteSetup', 'actCheckSetupToken']) {
      const body = src.slice(src.indexOf(`export async function ${name}`));
      expect(body.slice(0, 1200), `${name} 未过闸`).toContain('assertSetupAllowed');
    }
  });
});

// ── 回归：演示租户不算「装过机」 ─────────────────────────────────────────
// 2026-08-18 真机跑安装脚本时发现：prisma/seed.ts 会种一个演示工作台（含 viewer 成员），
// 而 seed 是安装脚本的必经步骤。若把它算成「已初始化」，客户装完机永远进不了向导，
// 只会落在一个他登不进去的登录页（企业版没有短信通道）。单测此前用空库，一路绿。
describe('演示租户不算已初始化', () => {
  it('库里只有演示成员时仍然需要装机', async () => {
    const { DEMO_TENANT_ID } = await import('@/lib/demo/guard');
    await prisma.member.deleteMany();
    await prisma.tenant.deleteMany({ where: { id: DEMO_TENANT_ID } });
    await prisma.tenant.create({ data: { id: DEMO_TENANT_ID, name: '烽火台演示工作台', plan: 'free' } });
    await prisma.member.create({
      data: { id: 'demo-member-fixed-0001', tenantId: DEMO_TENANT_ID, name: '演示访客', role: 'viewer' },
    });
    resetInitializedCache();
    expect(await isInitialized(), '演示成员被误判成真实管理员').toBe(false);
    expect(await needsSetup()).toBe(true);
  });

  it('真实成员出现后才算装过', async () => {
    await seedOneMember();
    resetInitializedCache();
    expect(await isInitialized()).toBe(true);
  });
});
