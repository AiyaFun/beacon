import { prisma } from '@/lib/db';

// 租户数据清单：注销预览、导出包、注销存根三处共用同一份口径。
//
// 三处必须同源，否则会出现最难堪的那种不一致——预览页告诉用户「将删除 128 条草稿」，
// 导出包里只有 90 条，存根里又记成 130 条。清单是给用户看的承诺，也是删除后的自证材料。

export type TenantScope = {
  tenantId: string;
  workspaceIds: string[];
  accountIds: string[];
};

/** 从租户展开到工作区、创作者账号——下游所有查询的归属根。 */
export async function resolveTenantScope(tenantId: string): Promise<TenantScope> {
  const workspaces = await prisma.workspace.findMany({ where: { tenantId }, select: { id: true } });
  const workspaceIds = workspaces.map((w) => w.id);
  const accounts = await prisma.creatorAccount.findMany({
    where: { workspaceId: { in: workspaceIds } },
    select: { id: true },
  });
  return { tenantId, workspaceIds, accountIds: accounts.map((a) => a.id) };
}

export type InventoryRow = { key: string; label: string; count: number };

/**
 * 各类数据条数。顺序即界面展示顺序：先「你产出的东西」，再「系统替你攒的东西」，最后账务。
 * 竞对档案/热榜是全局共享数据，不属于本租户，故此处只数「订阅关系」而非竞对本身。
 */
export async function dataInventory(scope: TenantScope): Promise<InventoryRow[]> {
  const { tenantId, workspaceIds, accountIds } = scope;
  const byAccount = { accountId: { in: accountIds } };
  const byWorkspace = { workspaceId: { in: workspaceIds } };

  const draftIds = (
    await prisma.draft.findMany({ where: byAccount, select: { id: true } })
  ).map((d) => d.id);
  const publishIds = (
    await prisma.publishRecord.findMany({ where: byAccount, select: { id: true } })
  ).map((p) => p.id);
  const sessionIds = (
    await prisma.advisorSession.findMany({ where: byAccount, select: { id: true } })
  ).map((a) => a.id);

  const [
    members,
    accounts,
    personaVersions,
    materials,
    ownPosts,
    dailyStats,
    audience,
    topics,
    drafts,
    draftVersions,
    complianceChecks,
    publishRecords,
    snapshots,
    reviews,
    advisorSessions,
    advisorOpinions,
    advisorPersonas,
    memories,
    inspirations,
    readerComments,
    mediaAssets,
    watchlist,
    tasks,
    notifications,
    providers,
    bots,
    ingestTokens,
    skillInstalls,
    customSkills,
    orders,
    llmLogs,
  ] = await Promise.all([
    prisma.member.count({ where: { tenantId } }),
    prisma.creatorAccount.count({ where: byWorkspace }),
    prisma.personaVersion.count({ where: byAccount }),
    prisma.material.count({ where: byAccount }),
    prisma.ownPost.count({ where: byAccount }),
    prisma.accountDailyStat.count({ where: byAccount }),
    prisma.audienceProfile.count({ where: byAccount }),
    prisma.topicIdea.count({ where: byAccount }),
    prisma.draft.count({ where: byAccount }),
    prisma.draftVersion.count({ where: { draftId: { in: draftIds } } }),
    prisma.complianceCheck.count({ where: { draftId: { in: draftIds } } }),
    prisma.publishRecord.count({ where: byAccount }),
    prisma.performanceSnapshot.count({ where: { publishId: { in: publishIds } } }),
    prisma.reviewReport.count({ where: byAccount }),
    prisma.advisorSession.count({ where: byAccount }),
    prisma.advisorOpinion.count({ where: { sessionId: { in: sessionIds } } }),
    prisma.advisorPersona.count({ where: byAccount }),
    prisma.memoryEntry.count({ where: byWorkspace }),
    prisma.inspirationItem.count({ where: byWorkspace }),
    prisma.readerComment.count({ where: byWorkspace }),
    prisma.mediaAsset.count({ where: byWorkspace }),
    prisma.watchlistItem.count({ where: byWorkspace }),
    prisma.taskItem.count({ where: byWorkspace }),
    prisma.notification.count({ where: byWorkspace }),
    prisma.modelProvider.count({ where: { tenantId } }),
    prisma.botIntegration.count({ where: byWorkspace }),
    prisma.ingestToken.count({ where: { ...byWorkspace, revokedAt: null } }),
    prisma.skillInstall.count({ where: { tenantId } }),
    prisma.contentSkill.count({ where: { tenantId } }),
    prisma.paymentOrder.count({ where: { tenantId } }),
    prisma.llmCallLog.count({ where: { tenantId } }),
  ]);

  const rows: InventoryRow[] = [
    { key: 'members', label: '团队成员', count: members },
    { key: 'accounts', label: '创作者账号（含人设卡）', count: accounts },
    { key: 'personaVersions', label: '人设历史版本', count: personaVersions },
    { key: 'materials', label: '素材库条目', count: materials },
    { key: 'ownPosts', label: '历史作品', count: ownPosts },
    { key: 'topics', label: '选题', count: topics },
    { key: 'drafts', label: '草稿', count: drafts },
    { key: 'draftVersions', label: '草稿版本', count: draftVersions },
    { key: 'complianceChecks', label: '合规检测记录', count: complianceChecks },
    { key: 'publishRecords', label: '发布记录', count: publishRecords },
    { key: 'snapshots', label: '表现快照', count: snapshots },
    { key: 'dailyStats', label: '账号逐日数据', count: dailyStats },
    { key: 'audience', label: '受众画像', count: audience },
    { key: 'reviews', label: 'AI 复盘报告', count: reviews },
    { key: 'advisorSessions', label: '智囊团会诊', count: advisorSessions },
    { key: 'advisorOpinions', label: '智囊团发言', count: advisorOpinions },
    { key: 'advisorPersonas', label: '智囊团人物卡', count: advisorPersonas },
    { key: 'memories', label: '记忆条目', count: memories },
    { key: 'inspirations', label: '灵感收集箱', count: inspirations },
    // 第三方写的评论正文，不随导出走（可携带权针对的是**你的**个人信息），但要让用户看得见它存在
    { key: 'readerComments', label: '读者原声（评论正文 · 90 天自动删）', count: readerComments },
    // 参考图与生成的封面。图片体积大、且人像属敏感个人信息，**不随导出走**（同 ReaderComment 的取舍），
    // 但必须让用户看得见它存在、知道去哪删（封面工位的形象库）。
    { key: 'mediaAssets', label: '封面与形象素材（图片 · 可在封面工位删除）', count: mediaAssets },
    { key: 'watchlist', label: '竞对订阅', count: watchlist },
    { key: 'tasks', label: '待办', count: tasks },
    { key: 'notifications', label: '站内通知', count: notifications },
    { key: 'providers', label: '模型渠道（含加密的 API Key）', count: providers },
    { key: 'bots', label: '机器人集成（含加密密钥）', count: bots },
    { key: 'ingestTokens', label: '已授权的插件设备（采集令牌）', count: ingestTokens },
    { key: 'skills', label: '技能安装 / 自建技能', count: skillInstalls + customSkills },
    { key: 'orders', label: '支付订单', count: orders },
    { key: 'llmLogs', label: 'AI 调用日志', count: llmLogs },
  ];
  return rows;
}

/** 清单转成 {key: count} 的扁平对象，落进注销存根。 */
export function inventoryToCounts(rows: InventoryRow[]): Record<string, number> {
  return Object.fromEntries(rows.map((r) => [r.key, r.count]));
}
