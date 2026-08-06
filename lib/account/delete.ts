import { prisma } from '@/lib/db';
import { dataInventory, inventoryToCounts, resolveTenantScope, type InventoryRow } from './inventory';

// 账号注销（PIPL 第 47 条删除权 / PRD §6 F9-8）。
//
// PRD 把注销的时序写死了：**记忆与素材即时删除、凭证即时销毁、生成日志留存至法定期限届满、
// 全程可审计**。四件事对应下面 executeAccountDeletion 里的四步，顺序不能换：
//
//   1) 生成日志摘除租户归属（不删——网络安全法第 21 条要求留存不少于六个月）
//   2) 交易凭证去标识化后转存进 AccountDeletion（电商法第 31 条要求三年）
//   3) 写注销存根（先于删除写，删除若失败则整个事务回滚，不会留下假存根）
//   4) 删 Tenant —— 级联带走工作区/账号/人设/素材/草稿/记忆/BYOK 密钥/机器人密钥/会话
//
// 【为什么不做"软删除 + 30 天后台清理"】那是给平台留后悔药，不是给用户的删除权。
// 用户点下注销的那一刻数据就该没了；真要防误删，防线应该前移到确认环节（见 DELETE_CONFIRM_TEXT），
// 而不是嘴上说删了、库里还留着。

/** 二次确认必须逐字输入的短语。前后端同一常量，别在界面上写死字面量。 */
export const DELETE_CONFIRM_TEXT = '注销账号';

export type DeletionScope = 'tenant' | 'member';

export type DeletionPlan = {
  /** tenant = 所有者注销（删除整个工作区）；member = 成员退出（工作区数据留给团队） */
  scope: DeletionScope;
  inventory: InventoryRow[];
  /** 同租户的其他成员，owner 注销前必须先清空 */
  otherMembers: { id: string; name: string; role: string }[];
  /** 非空 = 当前不能注销，文案可直接展示 */
  blocked: string | null;
  plan: string;
  /** 仍在有效期内的付费到期日；null = 无未到期权益 */
  paidUntil: Date | null;
};

type Actor = { memberId: string; tenantId: string; role: string };

/** 注销前的体检：算出范围、清单、拦截原因。纯读，不产生任何副作用。 */
export async function planAccountDeletion(actor: Actor): Promise<DeletionPlan> {
  const scope: DeletionScope = actor.role === 'owner' ? 'tenant' : 'member';
  const [tenant, others] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: actor.tenantId } }),
    prisma.member.findMany({
      where: { tenantId: actor.tenantId, id: { not: actor.memberId } },
      select: { id: true, name: true, role: true },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  // 所有者注销 = 连带删掉别人的工作成果。这个决定不该由界面上的一个复选框替他们做出，
  // 所以硬拦：先把人移除（或转让所有权）再来。
  const blocked =
    scope === 'tenant' && others.length > 0
      ? `工作区还有 ${others.length} 位其他成员，注销会一并删除他们的全部数据。请先在「团队成员」页移除他们，或把所有权转让出去。`
      : null;

  // 清单要跑近三十次 count：只在真的会用到时才算（成员退出不删工作区数据，被拦住时也不展示清单）
  const inventory =
    scope === 'tenant' && !blocked ? await dataInventory(await resolveTenantScope(actor.tenantId)) : [];

  const expires = tenant?.planExpiresAt ?? null;
  const paidUntil = tenant && tenant.plan !== 'free' && expires && expires.getTime() > Date.now() ? expires : null;

  return { scope, inventory, otherMembers: others, blocked, plan: tenant?.plan ?? 'free', paidUntil };
}

/** 订单 + 退款的去标识化存根：只有单号/金额/时间/档位，没有任何能指向自然人的字段。 */
async function collectLedger(tenantId: string) {
  const orders = await prisma.paymentOrder.findMany({
    where: { tenantId },
    include: { refunds: true },
    orderBy: { createdAt: 'asc' },
  });
  return orders.map((o) => ({
    outTradeNo: o.outTradeNo,
    transactionId: o.transactionId,
    plan: o.plan,
    periodMonths: o.periodMonths,
    amountFen: o.amountFen,
    currency: o.currency,
    status: o.status,
    provider: o.provider,
    paidAt: o.paidAt?.toISOString() ?? null,
    createdAt: o.createdAt.toISOString(),
    refunds: o.refunds.map((r) => ({
      outRefundNo: r.outRefundNo,
      refundId: r.refundId,
      amountRefundFen: r.amountRefundFen,
      status: r.status,
      successAt: r.successAt?.toISOString() ?? null,
    })),
  }));
}

export type DeletionResult =
  | { ok: true; scope: DeletionScope; deletionId: string }
  | { ok: false; error: string };

/**
 * 执行注销。**所有拦截条件在这里重算一遍**——预览是给人看的，不是授权凭证：
 * 预览到执行之间可能过了几分钟，期间完全可能有新成员被邀请进来。
 */
export async function executeAccountDeletion(actor: Actor): Promise<DeletionResult> {
  const plan = await planAccountDeletion(actor);
  if (plan.blocked) return { ok: false, error: plan.blocked };

  if (plan.scope === 'member') {
    // 成员退出：只删自己这一行，会话、投票、**他名下签发的采集令牌**随之级联。
    // 采集令牌那一条是 2026-07-30 补的：此前令牌是工作区级的单枚，成员退出后他电脑上那个插件
    // 拿着同一串照样能往工作区里写数据。现在按人签发（IngestToken.memberId → onDelete: Cascade），
    // 人一删令牌就没了——这层刻意压到数据库外键上，因为「记得去删」这种约定迟早会漏一次。
    // 内容（草稿/选题/发布记录）挂在创作者账号上而非成员上，属于工作区，留给团队——
    // 把它们一并删掉才是越权：那是别人还在用的东西。
    const deletion = await prisma.$transaction(async (tx) => {
      const rec = await tx.accountDeletion.create({
        data: {
          tenantId: actor.tenantId,
          memberId: actor.memberId,
          scope: 'member',
          plan: plan.plan,
          counts: JSON.stringify({ members: 1 }),
        },
      });
      await tx.member.delete({ where: { id: actor.memberId } });
      return rec;
    });
    return { ok: true, scope: 'member', deletionId: deletion.id };
  }

  // 清单直接复用体检结果（同一次调用内不会变），别再跑一遍三十次 count
  const inventory = plan.inventory;
  const ledger = await collectLedger(actor.tenantId);

  // 事务：日志摘归属 → 写存根 → 删租户。中途任何一步失败都整体回滚，
  // 不会出现「存根说删了、数据还在」或「数据没了、存根没写」这种半截状态。
  // timeout 放宽到 30s：重度租户的级联删除会摸到十几张表，默认 5s 不够。
  const deletion = await prisma.$transaction(
    async (tx) => {
      // ① 生成日志：留存至法定期限届满，但此刻就摘掉租户归属，不再关联到任何账号
      const logs = await tx.llmCallLog.updateMany({ where: { tenantId: actor.tenantId }, data: { tenantId: null } });
      await tx.jobRun.updateMany({ where: { tenantId: actor.tenantId }, data: { tenantId: null } });

      // ② + ③ 交易凭证转存进存根（否则下一步的级联会把它们一起删掉，违反电商法留存义务）
      const rec = await tx.accountDeletion.create({
        data: {
          tenantId: actor.tenantId,
          memberId: actor.memberId,
          scope: 'tenant',
          plan: plan.plan,
          ledger: JSON.stringify(ledger),
          counts: JSON.stringify(inventoryToCounts(inventory)),
          logsAnonymized: logs.count,
        },
      });

      // ④ 删租户：外键级联带走工作区 → 创作者账号 → 人设/素材/选题/草稿/发布/复盘/记忆，
      // 以及 BYOK 密钥、机器人密钥、采集令牌、登录会话（凭证即时销毁）
      await tx.tenant.delete({ where: { id: actor.tenantId } });
      return rec;
    },
    { timeout: 30_000 },
  );

  return { ok: true, scope: 'tenant', deletionId: deletion.id };
}
