import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { resolveOpsBotTarget } from '@/lib/ops/bot-target';
import { setOpsBotSender, sendOpsAlert, resetOpsAlertState, opsAlertConfigured } from '@/lib/ops/alert';

// 运维告警默认走**用户自己配好的机器人集成**（2026-07-30 用户拍板：配了就用，没配就不推）。
// 这里钉的是「选谁的机器人」这件事上的克制：多于一个就宁可不发——
// 生产 500 的内容是内部信息，发进某个客户的群没有撤回键。

const KEY = 'BEACON_OPS_WORKSPACE_ID';
const HOOK = 'BEACON_OPS_WEBHOOK';

async function mkWorkspace(name: string) {
  const t = await prisma.tenant.create({ data: { name } });
  return prisma.workspace.create({ data: { tenantId: t.id, name } });
}

describe('运维告警的目标选择', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(async () => {
    for (const k of [KEY, HOOK]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    await prisma.botIntegration.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.tenant.deleteMany();
    setOpsBotSender(null);
    resetOpsAlertState();
  });
  afterEach(() => {
    for (const k of [KEY, HOOK]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
    setOpsBotSender(null);
    resetOpsAlertState();
    vi.unstubAllGlobals();
  });

  it('没人配机器人 → 没有目标（就不推，这是产品口径不是 bug）', async () => {
    expect(await resolveOpsBotTarget()).toBeNull();
  });

  it('全库只有一个启用中的集成 → 就用它', async () => {
    const ws = await mkWorkspace('唯一');
    await prisma.botIntegration.create({ data: { workspaceId: ws.id, provider: 'feishu', webhookUrl: 'https://open.feishu.cn/x' } });
    const t = await resolveOpsBotTarget();
    expect(t?.workspaceId).toBe(ws.id);
  });

  it('🔒 有两个集成且没指定 → 放弃，不猜（发错群没有撤回键）', async () => {
    const a = await mkWorkspace('甲');
    const b = await mkWorkspace('乙');
    await prisma.botIntegration.create({ data: { workspaceId: a.id, provider: 'feishu', webhookUrl: 'https://open.feishu.cn/a' } });
    await prisma.botIntegration.create({ data: { workspaceId: b.id, provider: 'feishu', webhookUrl: 'https://open.feishu.cn/b' } });
    expect(await resolveOpsBotTarget()).toBeNull();
  });

  it('指定了 BEACON_OPS_WORKSPACE_ID → 以它为准，多少个集成都不影响', async () => {
    const a = await mkWorkspace('甲');
    const b = await mkWorkspace('乙');
    await prisma.botIntegration.create({ data: { workspaceId: a.id, provider: 'feishu', webhookUrl: 'https://open.feishu.cn/a' } });
    await prisma.botIntegration.create({ data: { workspaceId: b.id, provider: 'feishu', webhookUrl: 'https://open.feishu.cn/b' } });
    process.env[KEY] = b.id;
    const t = await resolveOpsBotTarget();
    expect(t?.workspaceId).toBe(b.id);
    expect(t?.why).toContain('BEACON_OPS_WORKSPACE_ID');
  });

  it('停用的集成不算数', async () => {
    const ws = await mkWorkspace('停用');
    await prisma.botIntegration.create({
      data: { workspaceId: ws.id, provider: 'feishu', webhookUrl: 'https://open.feishu.cn/x', enabled: false },
    });
    expect(await resolveOpsBotTarget()).toBeNull();
  });

  it('注册了机器人出口后：没配 webhook 也算「已启用」，且真走机器人这条路', async () => {
    expect(opsAlertConfigured()).toBe(false);
    const sent: string[] = [];
    setOpsBotSender(async (text) => {
      sent.push(text);
      return true;
    });
    expect(opsAlertConfigured()).toBe(true);
    const r = await sendOpsAlert({ level: 'error', title: '服务端异常', lines: ['TypeError: x'], fingerprint: 'f1' });
    expect(r.sent).toBe(true);
    expect(sent[0]).toContain('服务端异常');
    expect(sent[0]).toContain('TypeError: x');
  });

  it('机器人发失败 → 如实回 false，不抛（监控不许把业务弄挂）', async () => {
    setOpsBotSender(async () => false);
    const r = await sendOpsAlert({ level: 'error', title: 'x', lines: [], fingerprint: 'f2' });
    expect(r).toEqual({ sent: false, reason: 'bot_send_failed' });
  });
});
