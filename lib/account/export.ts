import { prisma } from '@/lib/db';
import { LEGAL_VERSION } from '@/lib/legal';
import { dataInventory, inventoryToCounts, resolveTenantScope, type TenantScope } from './inventory';

// 全量数据导出（PIPL 第 45 条可携带权 / PRD §6 F9-8「数据导出」）。
//
// 一个文件、机器可读、不需要我们这边配合就能读懂——这是「可携带」的最低门槛，
// 分成十几个 CSV 让用户自己拼关系就不算。故：单个 JSON，关联数据按归属嵌套。
//
// 【铁律：凭证类字段永不出现在导出包里】
// BYOK 的 apiKeyEnc、机器人的 secretsEnc、工作区采集令牌、会话 token、邀请 token——
// 一个都不导。它们是「访问权」而非「用户数据」，导出包一旦落到别人手上就是一串可直接用的钥匙；
// 而用户对这些字段的合理诉求（我配了哪家、还在不在）用元信息就能满足。
// 下面凡是含密字段的模型一律显式 select，绝不 findMany 裸取——新增字段时默认不外泄。

export const EXPORT_FORMAT_VERSION = '1';

type Grouped<T> = Map<string, T[]>;

function groupBy<T, K extends keyof T>(rows: T[], key: K): Grouped<T> {
  const m: Grouped<T> = new Map();
  for (const r of rows) {
    const k = String(r[key]);
    const bucket = m.get(k);
    if (bucket) bucket.push(r);
    else m.set(k, [r]);
  }
  return m;
}

function pick<T>(m: Grouped<T>, id: string): T[] {
  return m.get(id) ?? [];
}

function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  return phone.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');
}

export type ExportBundle = Record<string, unknown>;

/**
 * 组装导出包。范围 = 当前租户的全部业务数据（团队工作区里，成员共享同一份数据）。
 * 全局共享的竞对档案/热榜不属于本租户，只导「你订阅了谁」这一层关系。
 */
export async function buildAccountExport(opts: { tenantId: string; memberId: string }): Promise<ExportBundle> {
  const scope = await resolveTenantScope(opts.tenantId);
  const { tenantId, workspaceIds, accountIds } = scope;
  const byAccount = { accountId: { in: accountIds } };
  const byWorkspace = { workspaceId: { in: workspaceIds } };

  const [tenant, me, members, workspaces, accounts] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: tenantId } }),
    prisma.member.findUnique({ where: { id: opts.memberId } }),
    prisma.member.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } }),
    // ingestToken 是采集凭证，不导（见文件头铁律），只导「有没有启用」。
    // IngestToken 表同理：**整张表都不进导出**——它每一行都是一枚可直接使用的凭证，
    // 导出文件本身是可离线传播的副本，凭证进去就等于凭证泄漏。「已授权几台设备」
    // 在注销清单（lib/account/inventory.ts）里如实列出，那里只有计数没有令牌串。
    prisma.workspace.findMany({
      where: { tenantId },
      select: {
        id: true, name: true, automationConfig: true, createdAt: true, ingestToken: true,
        _count: { select: { ingestTokens: { where: { revokedAt: null } } } },
      },
    }),
    prisma.creatorAccount.findMany({ where: byWorkspace, orderBy: { createdAt: 'asc' } }),
  ]);

  const drafts = await prisma.draft.findMany({
    where: byAccount,
    include: { versions: { orderBy: { seq: 'asc' } }, checks: { orderBy: { checkedAt: 'asc' } } },
    orderBy: { createdAt: 'asc' },
  });

  const [
    personaVersions,
    materials,
    ownPosts,
    dailyStats,
    audience,
    topics,
    publishRecords,
    reviews,
    advisorSessions,
    advisorPersonas,
    memories,
    inspirations,
    watchlist,
    tasks,
    notifications,
    providers,
    bots,
    skillInstalls,
    customSkills,
    orders,
    complianceFeedback,
  ] = await Promise.all([
    prisma.personaVersion.findMany({ where: byAccount, orderBy: { createdAt: 'asc' } }),
    prisma.material.findMany({ where: byAccount, orderBy: { createdAt: 'asc' } }),
    prisma.ownPost.findMany({ where: byAccount, orderBy: { publishedAt: 'asc' } }),
    prisma.accountDailyStat.findMany({ where: byAccount, orderBy: { date: 'asc' } }),
    prisma.audienceProfile.findMany({ where: byAccount }),
    prisma.topicIdea.findMany({ where: byAccount, orderBy: { createdAt: 'asc' } }),
    prisma.publishRecord.findMany({
      where: byAccount,
      include: { snapshots: { orderBy: { takenAt: 'asc' } } },
      orderBy: { publishedAt: 'asc' },
    }),
    prisma.reviewReport.findMany({ where: byAccount, orderBy: { createdAt: 'asc' } }),
    prisma.advisorSession.findMany({
      where: byAccount,
      include: { opinions: { orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.advisorPersona.findMany({ where: byAccount }),
    // embedding 是几百维浮点数组，对人零可读性、能把导出包撑大一个量级——不导，元信息里写明
    prisma.memoryEntry.findMany({
      where: byWorkspace,
      select: {
        id: true, workspaceId: true, accountId: true, type: true, content: true,
        confidence: true, hitCount: true, active: true,
        validFrom: true, validTo: true, createdAt: true, updatedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.inspirationItem.findMany({ where: byWorkspace, orderBy: { createdAt: 'asc' } }),
    prisma.watchlistItem.findMany({ where: byWorkspace, include: { competitor: true } }),
    prisma.taskItem.findMany({ where: byWorkspace, orderBy: { createdAt: 'asc' } }),
    prisma.notification.findMany({ where: byWorkspace, orderBy: { createdAt: 'asc' } }),
    // apiKeyEnc 不导
    prisma.modelProvider.findMany({
      where: { tenantId },
      select: { id: true, label: true, vendor: true, baseUrl: true, model: true, region: true, routing: true, isDefault: true, status: true, createdAt: true },
    }),
    // secretsEnc / inboundKey 不导（inboundKey 是入站路由键，等同半个凭证）
    prisma.botIntegration.findMany({
      where: byWorkspace,
      select: { id: true, workspaceId: true, provider: true, label: true, enabled: true, pushEvents: true, pushSchedule: true, allowCommands: true, lastInboundAt: true, lastOutboundAt: true, lastError: true, createdAt: true },
    }),
    prisma.skillInstall.findMany({ where: { tenantId }, include: { skill: { select: { slug: true, name: true, platform: true, category: true, isBuiltin: true } } } }),
    prisma.contentSkill.findMany({ where: { tenantId } }),
    prisma.paymentOrder.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } }),
    prisma.complianceFeedback.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } }),
  ]);

  const draftsByAccount = groupBy(drafts, 'accountId');
  const personaByAccount = groupBy(personaVersions, 'accountId');
  const materialByAccount = groupBy(materials, 'accountId');
  const ownPostByAccount = groupBy(ownPosts, 'accountId');
  const dailyByAccount = groupBy(dailyStats, 'accountId');
  const audienceByAccount = groupBy(audience, 'accountId');
  const topicByAccount = groupBy(topics, 'accountId');
  const publishByAccount = groupBy(publishRecords, 'accountId');
  const reviewByAccount = groupBy(reviews, 'accountId');
  const advisorByAccount = groupBy(advisorSessions, 'accountId');
  const personaCardByAccount = groupBy(advisorPersonas, 'accountId');

  const inventory = await dataInventory(scope);

  return {
    // ── 元信息：这份文件是什么、怎么读、少了什么 ──
    meta: {
      product: '烽火台 · 跨平台内容作战室',
      formatVersion: EXPORT_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      exportedBy: opts.memberId,
      tenantId,
      legalVersion: LEGAL_VERSION,
      scope: '当前工作区（租户）的全部业务数据。团队成员共享同一份数据，故导出范围与角色无关。',
      excluded: [
        'API Key / 机器人密钥 / 采集令牌 / 登录会话 token —— 属访问凭证而非用户数据，导出即等于把钥匙交出去',
        '记忆条目的向量（embedding）—— 数百维浮点数组，对人不可读且会把文件撑大一个量级；记忆正文已完整导出',
        '全局共享的竞对档案与热榜原文 —— 不属于本工作区的数据，只导出你的订阅关系',
      ],
      inventory,
    },

    // ── 账号与团队 ──
    account: me
      ? {
          id: me.id,
          name: me.name,
          phone: maskPhone(me.phone),
          email: me.email,
          wechatBound: !!me.wechatOpenId,
          role: me.role,
          status: me.status,
          consentAt: me.consentAt,
          consentVersion: me.consentVersion,
          createdAt: me.createdAt,
        }
      : null,
    tenant: tenant
      ? { id: tenant.id, name: tenant.name, plan: tenant.plan, planExpiresAt: tenant.planExpiresAt, createdAt: tenant.createdAt }
      : null,
    members: members.map((m) => ({
      id: m.id,
      name: m.name,
      phone: maskPhone(m.phone),
      wechatBound: !!m.wechatOpenId,
      role: m.role,
      status: m.status,
      createdAt: m.createdAt,
    })),
    workspaces: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      automationConfig: w.automationConfig,
      ingestTokenEnabled: !!w.ingestToken || w._count.ingestTokens > 0,
      authorizedDevices: w._count.ingestTokens,
      createdAt: w.createdAt,
    })),

    // ── 创作者账号：人设、素材、选题、草稿、发布、复盘、智囊团都挂在它下面 ──
    creatorAccounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      platform: a.platform,
      handle: a.handle,
      status: a.status,
      personaCard: a.personaCard,
      styleFingerprint: a.styleFingerprint,
      createdAt: a.createdAt,
      personaVersions: pick(personaByAccount, a.id),
      materials: pick(materialByAccount, a.id),
      ownPosts: pick(ownPostByAccount, a.id),
      dailyStats: pick(dailyByAccount, a.id),
      audienceProfiles: pick(audienceByAccount, a.id),
      topics: pick(topicByAccount, a.id),
      drafts: pick(draftsByAccount, a.id),
      publishRecords: pick(publishByAccount, a.id),
      reviewReports: pick(reviewByAccount, a.id),
      advisorSessions: pick(advisorByAccount, a.id),
      advisorPersonas: pick(personaCardByAccount, a.id),
    })),

    // ── 工作区级 ──
    memories,
    inspirations,
    watchlist: watchlist.map((w) => ({
      id: w.id,
      label: w.label,
      addedAt: w.addedAt,
      competitor: w.competitor
        ? { platform: w.competitor.platform, handle: w.competitor.handle, name: w.competitor.name, followers: w.competitor.followers }
        : null,
    })),
    tasks,
    notifications,

    // ── 配置与账务 ──
    modelProviders: providers,
    botIntegrations: bots,
    skills: {
      installs: skillInstalls.map((i) => ({ id: i.id, enabled: i.enabled, createdAt: i.createdAt, skill: i.skill })),
      custom: customSkills,
    },
    complianceFeedback,
    payments: orders.map((o) => ({
      outTradeNo: o.outTradeNo,
      transactionId: o.transactionId,
      plan: o.plan,
      periodMonths: o.periodMonths,
      amountFen: o.amountFen,
      amountYuan: (o.amountFen / 100).toFixed(2),
      currency: o.currency,
      status: o.status,
      paidAt: o.paidAt,
      grantedDays: o.grantedDays,
      newPlanExpiresAt: o.newPlanExpiresAt,
      createdAt: o.createdAt,
    })),

    counts: inventoryToCounts(inventory),
  };
}

export type { TenantScope };
