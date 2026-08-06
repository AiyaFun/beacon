import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { planAccountDeletion, executeAccountDeletion } from '@/lib/account/delete';
import { buildAccountExport } from '@/lib/account/export';

// 账号注销 + 全量导出。跑在真 SQLite 上——要验的正是 DB 语义：
// 删 Tenant 时外键级联到底走没走通（这件事在应用层怎么读代码都读不出来），
// 以及「哪些行**没有**被级联带走」（生成日志、注销存根）。
//
// 这两条都是「测试绿了才敢上线」的类型：级联没生效 = 用户点了注销、数据还躺在库里；
// 级联生效过了头 = 交易凭证一起消失，法定留存义务当场违反。

async function seedTenant(opts: { plan?: string } = {}) {
  const tenant = await prisma.tenant.create({ data: { name: '注销测试', plan: opts.plan ?? 'personal' } });
  const workspace = await prisma.workspace.create({
    data: { tenantId: tenant.id, name: '主工作区', ingestToken: `tok-${tenant.id}` },
  });
  const owner = await prisma.member.create({
    data: { tenantId: tenant.id, name: '所有者', phone: `1380000${Math.floor(Math.random() * 9000 + 1000)}`, role: 'owner' },
  });
  const account = await prisma.creatorAccount.create({
    data: { workspaceId: workspace.id, name: '主号', platform: 'douyin', personaCard: '{"identity":"科技博主"}' },
  });
  const draft = await prisma.draft.create({ data: { accountId: account.id, title: '稿子', platform: 'douyin' } });
  await prisma.draftVersion.create({ data: { draftId: draft.id, seq: 1, authorType: 'ai', content: '正文' } });
  await prisma.material.create({ data: { accountId: account.id, type: 'experience', content: '我的经历' } });
  await prisma.memoryEntry.create({ data: { workspaceId: workspace.id, type: 'persona', content: '偏好短句' } });
  await prisma.modelProvider.create({
    data: { tenantId: tenant.id, label: '我的 DeepSeek', vendor: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKeyEnc: 'SECRET-CIPHERTEXT', model: 'deepseek-chat' },
  });
  await prisma.botIntegration.create({
    data: { workspaceId: workspace.id, provider: 'feishu', secretsEnc: 'BOT-SECRET-CIPHERTEXT' },
  });
  await prisma.authSession.create({
    data: { token: `sess-${tenant.id}`, memberId: owner.id, expiresAt: new Date(Date.now() + 86400_000) },
  });
  const order = await prisma.paymentOrder.create({
    data: {
      outTradeNo: `bc${tenant.id.slice(-10)}`,
      tenantId: tenant.id,
      memberId: owner.id,
      plan: 'personal',
      periodMonths: 1,
      amountFen: 9900,
      status: 'paid',
      transactionId: `wx-${tenant.id}`,
      paidAt: new Date(),
    },
  });
  await prisma.llmCallLog.create({ data: { tenantId: tenant.id, fn: 'generation', provider: 'deepseek', model: 'deepseek-chat' } });

  return { tenant, workspace, owner, account, draft, order };
}

beforeEach(async () => {
  await prisma.accountDeletion.deleteMany();
  await prisma.llmCallLog.deleteMany();
  await prisma.tenant.deleteMany();
});

describe('planAccountDeletion（注销体检）', () => {
  it('所有者 → 范围是整个租户，清单里能看到自己的数据', async () => {
    const { tenant, owner } = await seedTenant();
    const plan = await planAccountDeletion({ memberId: owner.id, tenantId: tenant.id, role: 'owner' });
    expect(plan.scope).toBe('tenant');
    expect(plan.blocked).toBeNull();
    const drafts = plan.inventory.find((r) => r.key === 'drafts');
    expect(drafts?.count).toBe(1);
    expect(plan.inventory.find((r) => r.key === 'providers')?.count).toBe(1);
  });

  it('工作区还有其他成员时，所有者不许注销（不能替别人删数据）', async () => {
    const { tenant, owner } = await seedTenant();
    await prisma.member.create({ data: { tenantId: tenant.id, name: '同事', role: 'editor' } });
    const plan = await planAccountDeletion({ memberId: owner.id, tenantId: tenant.id, role: 'owner' });
    expect(plan.blocked).toContain('其他成员');
    expect(plan.otherMembers).toHaveLength(1);
  });

  it('非所有者 → 范围只是成员本身', async () => {
    const { tenant } = await seedTenant();
    const editor = await prisma.member.create({ data: { tenantId: tenant.id, name: '编辑', role: 'editor' } });
    const plan = await planAccountDeletion({ memberId: editor.id, tenantId: tenant.id, role: 'editor' });
    expect(plan.scope).toBe('member');
    expect(plan.blocked).toBeNull();
  });

  it('付费未到期会被识别出来（界面据此提示权益作废）', async () => {
    const tenant = await prisma.tenant.create({
      data: { name: '付费租户', plan: 'team', planExpiresAt: new Date(Date.now() + 30 * 86400_000) },
    });
    await prisma.workspace.create({ data: { tenantId: tenant.id, name: 'w' } });
    const m = await prisma.member.create({ data: { tenantId: tenant.id, name: 'o', role: 'owner' } });
    const plan = await planAccountDeletion({ memberId: m.id, tenantId: tenant.id, role: 'owner' });
    expect(plan.paidUntil).toBeInstanceOf(Date);
  });
});

describe('executeAccountDeletion（所有者注销）', () => {
  it('租户数据被级联删干净（工作区/账号/草稿/素材/记忆/会话）', async () => {
    const { tenant, workspace, owner, account, draft } = await seedTenant();
    const r = await executeAccountDeletion({ memberId: owner.id, tenantId: tenant.id, role: 'owner' });
    expect(r.ok).toBe(true);

    expect(await prisma.tenant.findUnique({ where: { id: tenant.id } })).toBeNull();
    expect(await prisma.workspace.count({ where: { id: workspace.id } })).toBe(0);
    expect(await prisma.member.count({ where: { id: owner.id } })).toBe(0);
    expect(await prisma.creatorAccount.count({ where: { id: account.id } })).toBe(0);
    expect(await prisma.draft.count({ where: { id: draft.id } })).toBe(0);
    expect(await prisma.draftVersion.count({ where: { draftId: draft.id } })).toBe(0);
    expect(await prisma.material.count({ where: { accountId: account.id } })).toBe(0);
    expect(await prisma.memoryEntry.count({ where: { workspaceId: workspace.id } })).toBe(0);
    expect(await prisma.authSession.count({ where: { memberId: owner.id } })).toBe(0);
  });

  it('凭证即时销毁：BYOK 密钥与机器人密钥一并消失', async () => {
    const { tenant, workspace, owner } = await seedTenant();
    await executeAccountDeletion({ memberId: owner.id, tenantId: tenant.id, role: 'owner' });
    expect(await prisma.modelProvider.count({ where: { tenantId: tenant.id } })).toBe(0);
    expect(await prisma.botIntegration.count({ where: { workspaceId: workspace.id } })).toBe(0);
  });

  it('生成日志不删、只摘除租户归属（网络安全法留存期未到）', async () => {
    const { tenant, owner } = await seedTenant();
    await executeAccountDeletion({ memberId: owner.id, tenantId: tenant.id, role: 'owner' });
    expect(await prisma.llmCallLog.count({ where: { tenantId: tenant.id } })).toBe(0);
    const orphan = await prisma.llmCallLog.findMany({ where: { tenantId: null } });
    expect(orphan).toHaveLength(1);
    expect(orphan[0].fn).toBe('generation');
  });

  it('交易凭证转存进注销存根：订单行随租户消失，单号/金额留在存根里', async () => {
    const { tenant, owner, order } = await seedTenant();
    await executeAccountDeletion({ memberId: owner.id, tenantId: tenant.id, role: 'owner' });

    expect(await prisma.paymentOrder.count({ where: { tenantId: tenant.id } })).toBe(0);
    const rec = await prisma.accountDeletion.findFirst({ where: { tenantId: tenant.id } });
    expect(rec).not.toBeNull();
    expect(rec!.scope).toBe('tenant');
    expect(rec!.logsAnonymized).toBe(1);

    const ledger = JSON.parse(rec!.ledger) as { outTradeNo: string; amountFen: number; transactionId: string }[];
    expect(ledger).toHaveLength(1);
    expect(ledger[0].outTradeNo).toBe(order.outTradeNo);
    expect(ledger[0].amountFen).toBe(9900);
    expect(ledger[0].transactionId).toBe(order.transactionId);

    // 存根里不许出现任何能指向自然人的东西
    const dump = JSON.stringify(rec);
    expect(dump).not.toContain('138');
    expect(dump).not.toContain('SECRET-CIPHERTEXT');
  });

  it('存根记下删除前的清单（事后能自证删了什么）', async () => {
    const { tenant, owner } = await seedTenant();
    await executeAccountDeletion({ memberId: owner.id, tenantId: tenant.id, role: 'owner' });
    const rec = await prisma.accountDeletion.findFirst({ where: { tenantId: tenant.id } });
    const counts = JSON.parse(rec!.counts) as Record<string, number>;
    expect(counts.drafts).toBe(1);
    expect(counts.materials).toBe(1);
    expect(counts.memories).toBe(1);
    expect(counts.orders).toBe(1);
  });

  it('有其他成员时执行也会被拦（预览不是授权凭证，执行处重算）', async () => {
    const { tenant, owner } = await seedTenant();
    await prisma.member.create({ data: { tenantId: tenant.id, name: '后来加入的同事', role: 'editor' } });
    const r = await executeAccountDeletion({ memberId: owner.id, tenantId: tenant.id, role: 'owner' });
    expect(r.ok).toBe(false);
    expect(await prisma.tenant.count({ where: { id: tenant.id } })).toBe(1);
    expect(await prisma.accountDeletion.count({ where: { tenantId: tenant.id } })).toBe(0);
  });
});

describe('executeAccountDeletion（成员退出）', () => {
  it('只删自己，工作区数据留给团队', async () => {
    const { tenant, owner, account, draft } = await seedTenant();
    const editor = await prisma.member.create({ data: { tenantId: tenant.id, name: '编辑', role: 'editor' } });
    await prisma.authSession.create({
      data: { token: 'sess-editor', memberId: editor.id, expiresAt: new Date(Date.now() + 86400_000) },
    });

    const r = await executeAccountDeletion({ memberId: editor.id, tenantId: tenant.id, role: 'editor' });
    expect(r.ok).toBe(true);
    expect((r as { scope: string }).scope).toBe('member');

    expect(await prisma.member.count({ where: { id: editor.id } })).toBe(0);
    expect(await prisma.authSession.count({ where: { memberId: editor.id } })).toBe(0);
    // 团队的东西一件没少
    expect(await prisma.tenant.count({ where: { id: tenant.id } })).toBe(1);
    expect(await prisma.member.count({ where: { id: owner.id } })).toBe(1);
    expect(await prisma.creatorAccount.count({ where: { id: account.id } })).toBe(1);
    expect(await prisma.draft.count({ where: { id: draft.id } })).toBe(1);
  });

  it('成员的选题投票随本人一并删除（不留无法归属的幽灵票）', async () => {
    const { tenant, account } = await seedTenant();
    const editor = await prisma.member.create({ data: { tenantId: tenant.id, name: '编辑', role: 'editor' } });
    const topic = await prisma.topicIdea.create({ data: { accountId: account.id, title: '选题', angle: '角度' } });
    await prisma.topicVote.create({ data: { topicId: topic.id, memberId: editor.id, value: 'up' } });

    await executeAccountDeletion({ memberId: editor.id, tenantId: tenant.id, role: 'editor' });
    expect(await prisma.topicVote.count({ where: { topicId: topic.id } })).toBe(0);
    expect(await prisma.topicIdea.count({ where: { id: topic.id } })).toBe(1);
  });
});

describe('buildAccountExport（全量导出）', () => {
  it('内容数据完整导出，按创作者账号归拢', async () => {
    const { tenant, owner, account } = await seedTenant();
    const bundle = await buildAccountExport({ tenantId: tenant.id, memberId: owner.id });

    const accounts = bundle.creatorAccounts as Record<string, unknown>[];
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe(account.id);
    expect(accounts[0].personaCard).toContain('科技博主');
    expect((accounts[0].drafts as unknown[])).toHaveLength(1);
    expect((accounts[0].materials as unknown[])).toHaveLength(1);
    expect((bundle.memories as unknown[])).toHaveLength(1);
    expect((bundle.payments as unknown[])).toHaveLength(1);
  });

  it('凭证类字段一个都不出现在导出包里', async () => {
    const { tenant, owner } = await seedTenant();
    const dump = JSON.stringify(await buildAccountExport({ tenantId: tenant.id, memberId: owner.id }));

    expect(dump).not.toContain('SECRET-CIPHERTEXT'); // BYOK API Key 密文
    expect(dump).not.toContain('BOT-SECRET-CIPHERTEXT'); // 机器人密钥密文
    expect(dump).not.toContain(`tok-${tenant.id}`); // 工作区采集令牌
    expect(dump).not.toContain(`sess-${tenant.id}`); // 登录会话 token
    expect(dump).not.toContain('apiKeyEnc');
    expect(dump).not.toContain('secretsEnc');
    // 但「配了哪家、还在不在」要能看到——用户对渠道的合理诉求靠元信息满足
    expect(dump).toContain('我的 DeepSeek');
    expect(dump).toContain('"ingestTokenEnabled":true');
  });

  it('手机号脱敏后才写进导出包', async () => {
    const { tenant, owner } = await seedTenant();
    const bundle = await buildAccountExport({ tenantId: tenant.id, memberId: owner.id });
    const phone = (bundle.account as { phone: string | null }).phone;
    expect(phone).toMatch(/^\d{3}\*{4}\d{4}$/);
  });

  it('元信息写明范围与未导出项（用户不必猜文件里少了什么）', async () => {
    const { tenant, owner } = await seedTenant();
    const bundle = await buildAccountExport({ tenantId: tenant.id, memberId: owner.id });
    const meta = bundle.meta as { excluded: string[]; inventory: unknown[] };
    expect(meta.excluded.length).toBeGreaterThan(0);
    expect(meta.inventory.length).toBeGreaterThan(10);
  });
});
