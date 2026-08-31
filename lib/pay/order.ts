import { prisma, qualifiedTable } from '../db';
import { log } from '../logger';
import { invalidatePlanCache } from '../quota';
import { assertNotDemo } from '../demo/guard';
import { getPayProvider } from './provider';
import { assertCanPurchase, computeGrant } from './plan';
import { amountFenFor, descriptionFor, isPaidPlan, isPeriodMonths, type PaidPlan, type PeriodMonths } from './pricing';
import { refundPolicyFor, type RefundableOrder, type RefundPolicy } from './refund-amount';
import { newOutTradeNo, outRefundNoForOrder } from './sign';
import { WxPayError, type PayProvider, type RefundState } from './types';

// 下单与兑现。**幂等的唯一真值点在这里** —— 回调与查单兜底两条入口都走 fulfillOrder()。

// 二维码有效期：微信规定 code_url 有效期 2 小时，超时需重新下单换新单号
const CODE_TTL_MS = 2 * 3600_000;

export type CreateOrderInput = {
  tenantId: string;
  memberId: string;
  plan: string;
  periodMonths: number;
};

export type CreateOrderResult = {
  orderId: string;
  outTradeNo: string;
  codeUrl: string;
  amountFen: number;
  codeExpiresAt: Date;
  mocked: boolean;
};

/**
 * 下单。
 *
 * 🔒 金额**只在服务端算**（amountFenFor(plan, periodMonths)）。
 * 入参里没有、也永远不会有 amount 字段 —— 前端能传的只有 plan 与 periodMonths 两个枚举，
 * 传别的值会被 isPaidPlan/isPeriodMonths 挡掉。否则改个请求就是 1 分钱买团队版。
 */
export async function createOrder(i: CreateOrderInput, provider: PayProvider = getPayProvider()): Promise<CreateOrderResult> {
  assertNotDemo(i.tenantId); // 演示租户不下单
  if (!isPaidPlan(i.plan)) throw new Error(`不可下单的档位：${i.plan}`);
  if (!isPeriodMonths(i.periodMonths)) throw new Error(`不支持的购买时长：${i.periodMonths} 个月（仅 1 或 12）`);
  const plan: PaidPlan = i.plan;
  const periodMonths: PeriodMonths = i.periodMonths;

  const tenant = await prisma.tenant.findUnique({ where: { id: i.tenantId }, select: { plan: true, planExpiresAt: true } });
  if (!tenant) throw new Error('租户不存在');

  // 降档拦截（产品决策，见 plan.ts:assertCanPurchase）。传 periodMonths 让永久买断绕过降档拦截。
  assertCanPurchase({ currentPlan: tenant.plan, currentExpiresAt: tenant.planExpiresAt, newPlan: plan, periodMonths });

  const amountFen = amountFenFor(plan, periodMonths); // ← 服务端定价，唯一来源
  const outTradeNo = newOutTradeNo();

  const order = await prisma.paymentOrder.create({
    data: {
      outTradeNo,
      tenantId: i.tenantId,
      memberId: i.memberId,
      plan,
      periodMonths,
      amountFen,
      provider: provider.mocked ? 'mock' : 'wxpay_native',
    },
  });

  const codeExpiresAt = new Date(Date.now() + CODE_TTL_MS);
  try {
    const r = await provider.createNative({
      outTradeNo,
      amountFen,
      description: descriptionFor(plan, periodMonths),
      timeExpireISO: toRfc3339(codeExpiresAt),
    });
    await prisma.paymentOrder.update({
      where: { id: order.id },
      data: { codeUrl: r.codeUrl, codeExpiresAt, requestId: r.requestId },
    });
    return { orderId: order.id, outTradeNo, codeUrl: r.codeUrl, amountFen, codeExpiresAt, mocked: provider.mocked };
  } catch (e) {
    // 微信调用失败 → 必须把单置为 failed。
    // 否则它会以 status='created' + codeExpiresAt=NULL 永远留在库里：
    // 关单 job 扫的是 { status:'created', codeExpiresAt: { lt: now } }，NULL 不匹配任何比较 → 孤儿单。
    // （这是 schema agent 明确点出的真缺口，在这里堵上。）
    const reason = (e as Error).message.slice(0, 300);
    await prisma.paymentOrder.update({
      where: { id: order.id },
      data: { status: 'failed', failReason: reason, closedAt: new Date() },
    });
    log.error('微信下单失败，订单已置 failed', { outTradeNo, reason });
    throw e;
  }
}

/** RFC3339 带时区偏移（微信要 2015-05-20T13:29:35+08:00 这种格式，不吃 Z 结尾的 UTC 串）。 */
export function toRfc3339(d: Date): string {
  const pad = (n: number) => `${Math.floor(Math.abs(n))}`.padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(off / 60)}:${pad(off % 60)}`
  );
}

export type FulfillInput = {
  outTradeNo: string;
  transactionId: string;
  amountTotalFen?: number;
  paidAt?: Date;
  source: 'notify' | 'query'; // 只用于日志归因
};

export type FulfillResult =
  | { ok: true; alreadyDone: false; plan: string; newExpiresAt: Date; grantedDays: number }
  | { ok: true; alreadyDone: true } // 幂等命中：这一单之前已经兑现过
  | { ok: false; reason: string };

/**
 * 兑现一单（发货 = 把 Tenant.plan / planExpiresAt 写上去）。
 *
 * 🔒 幂等靠**条件写**，不靠「先查后写」：
 *   updateMany({ where: { id, status: 'created' } }) 的 count===0 就是「别人已经兑现过了」。
 *   「先 findUnique 判断 status 再 update」是 check-then-act，两个并发回调会双双读到
 *   status='created' 而双双发货 —— 用户付一次得两个月。DB 的条件写才是原子的。
 *
 * 微信会重复发同一通知（最多 15 次），**且可能并发到达**；查单兜底还会与回调并发。
 * 所有入口共用这一个兑现点，所以只需要在这里正确一次。
 *
 * 整体包在事务里：改订单状态与改租户套餐必须同生共死，
 * 否则中途崩溃会留下「订单显示已支付但套餐没升」的对不上的账。
 */
export async function fulfillOrder(i: FulfillInput): Promise<FulfillResult> {
  const order = await prisma.paymentOrder.findUnique({ where: { outTradeNo: i.outTradeNo } });
  if (!order) return { ok: false, reason: `订单不存在：${i.outTradeNo}` };

  // 🔒 金额校验：微信实收金额必须与我们下单时算的金额一致。
  // 对不上就绝不发货 —— 这是「篡改金额」的最后一道拦截，也是对账的底线。
  if (i.amountTotalFen !== undefined && i.amountTotalFen !== order.amountFen) {
    const reason = `金额不匹配：下单 ${order.amountFen} 分，实收 ${i.amountTotalFen} 分`;
    log.error('支付金额不匹配，拒绝兑现', { outTradeNo: i.outTradeNo, expected: order.amountFen, got: i.amountTotalFen });
    await prisma.paymentOrder.updateMany({
      where: { id: order.id, status: 'created' },
      data: { status: 'failed', failReason: reason, closedAt: new Date() },
    });
    return { ok: false, reason };
  }

  if (order.status !== 'created') {
    // 快路径：已经是终态了。真正的并发防护在下面的条件写，这里只是省一次事务。
    return { ok: true, alreadyDone: true };
  }

  const paidAt = i.paidAt ?? new Date();

  try {
    return await prisma.$transaction(async (tx) => {
      // Postgres: 行锁防止同租户两笔不同订单并发兑现时 read-modify-write 丢失更新。
      // SQLite 事务天然串行化，不需要也不支持 FOR UPDATE。
      // ⚠️ 表名必须走 qualifiedTable()：裸 SQL 不吃连接串的 ?schema=，写死 "Tenant" 会在生产
      // 42P01（2026-07-28 真实事故：钱收了、货没发，微信 5xx 重发 15 次）。见 lib/db.ts 注释。
      if (!process.env.DATABASE_URL?.startsWith('file:')) {
        await tx.$queryRawUnsafe(`SELECT 1 FROM ${qualifiedTable('Tenant')} WHERE id = $1 FOR UPDATE`, order.tenantId);
      }
      const tenant = await tx.tenant.findUnique({ where: { id: order.tenantId }, select: { plan: true, planExpiresAt: true } });
      if (!tenant) return { ok: false as const, reason: '租户不存在' };

      const grant = computeGrant({
        currentPlan: tenant.plan,
        currentExpiresAt: tenant.planExpiresAt,
        newPlan: order.plan as PaidPlan,
        periodMonths: order.periodMonths as PeriodMonths,
        now: paidAt,
      });

      // ★ 幂等点：条件写。count===0 = 已被别的入口兑现，直接返回，绝不重复发货。
      const claimed = await tx.paymentOrder.updateMany({
        where: { id: order.id, status: 'created' },
        data: {
          status: 'paid',
          transactionId: i.transactionId,
          paidAt,
          prevPlan: tenant.plan,
          prevPlanExpiresAt: tenant.planExpiresAt,
          grantedDays: grant.grantedDays,
          newPlanExpiresAt: grant.newExpiresAt,
        },
      });
      if (claimed.count === 0) return { ok: true as const, alreadyDone: true as const };

      await tx.tenant.update({
        where: { id: order.tenantId },
        data: { plan: order.plan, planExpiresAt: grant.newExpiresAt },
      });
      // 配额那边有 60s 的 plan 短缓存，付了钱不该还等一分钟才能用新额度
      invalidatePlanCache(order.tenantId);

      log.info('套餐兑现成功', {
        outTradeNo: i.outTradeNo,
        source: i.source,
        tenantId: order.tenantId,
        plan: order.plan,
        mode: grant.mode,
        grantedDays: grant.grantedDays,
        bonusDays: grant.bonusDays,
      });
      return {
        ok: true as const,
        alreadyDone: false as const,
        plan: order.plan,
        newExpiresAt: grant.newExpiresAt,
        grantedDays: grant.grantedDays,
      };
    });
  } catch (e) {
    // transactionId 撞唯一索引 = 同一笔微信支付想兑现两次（第二道锁兜住了条件写没覆盖的路径）
    if ((e as { code?: string }).code === 'P2002') {
      log.warn('transactionId 重复，判定为重复兑现', { outTradeNo: i.outTradeNo, transactionId: i.transactionId });
      return { ok: true, alreadyDone: true };
    }
    throw e;
  }
}

/**
 * 主动查单兜底。
 *
 * 官方明确「商户系统不能仅依赖回调通知获取结果，需结合查询接口使用」——
 * 回调会丢（反代过滤了 Wechatpay-* 头、我们 5s 没应答完、公网抖动…）。
 * 前端轮询订单状态时顺便查一次微信，回调丢了也能正常发货。
 */
export async function syncOrderFromWechat(outTradeNo: string, provider: PayProvider = getPayProvider()): Promise<FulfillResult | null> {
  const order = await prisma.paymentOrder.findUnique({ where: { outTradeNo } });
  if (!order) return { ok: false, reason: '订单不存在' };
  if (order.status !== 'created') return null; // 已终态，不用查

  let q;
  try {
    q = await provider.queryByOutTradeNo(outTradeNo);
  } catch (e) {
    // 查单失败不影响用户（回调可能仍会到），记日志即可
    log.warn('查单失败', { outTradeNo, err: (e as Error).message });
    return null;
  }

  if (q.tradeState === 'SUCCESS') {
    if (!q.transactionId) {
      log.error('查单返回 SUCCESS 但没有 transaction_id', { outTradeNo });
      return null;
    }
    return fulfillOrder({
      outTradeNo,
      transactionId: q.transactionId,
      amountTotalFen: q.amountTotalFen,
      paidAt: q.successTimeISO ? new Date(q.successTimeISO) : new Date(),
      source: 'query',
    });
  }

  if (q.tradeState === 'CLOSED' || q.tradeState === 'REVOKED' || q.tradeState === 'PAYERROR') {
    await prisma.paymentOrder.updateMany({
      where: { id: order.id, status: 'created' },
      data: { status: 'closed', closedAt: new Date(), failReason: `微信侧状态 ${q.tradeState}` },
    });
    return null;
  }

  // 【二维码过期了、微信侧仍是未支付 → 这张单再也付不了了，本地关掉】
  //
  // 不关的话它**永远停在 created**：用户扫码后放弃是最常见的情形，而 code_url 只有 2 小时。
  // 后果有两条：① 定时对账每轮都要为这些死单再查一次微信，永远查不完；
  // ② 「待支付订单」在界面与运维台上越堆越多，真正卡住的那一单反而看不出来。
  //
  // 【为什么这个判断是安全的】它要求两个**正向**条件同时成立：查单成功返回了 NOTPAY
  //（不是网络失败——那种情况上面已经 return 了），且二维码时间已过。
  // 少任何一个都不关：只凭 null 关单会让一次网络抖动关掉一张还能付的单。
  if (q.tradeState === 'NOTPAY' && order.codeExpiresAt && order.codeExpiresAt.getTime() < Date.now()) {
    await prisma.paymentOrder.updateMany({
      where: { id: order.id, status: 'created' },
      data: { status: 'closed', closedAt: new Date(), failReason: '二维码超时未支付（重新下单会换新单号）' },
    });
  }
  return null;
}

/**
 * 把所有还在「待支付」的订单向微信查一遍。
 *
 * 【为什么必须有这个】`syncOrderFromWechat` 的注释写着「回调丢了也能正常发货」，
 * 而它**唯一的生产调用点是 actPollOrder**——也就是「用户正盯着二维码那个页面」。
 * 用户扫码付完就关页面是再正常不过的操作，于是真实的失败路径是：
 * 回调丢了（反代过滤 Wechatpay-* 头、我们 5s 没应答完、公网抖动——这几种它自己的注释就写着）
 * ＋ 用户关了页面 = **钱收了，套餐永远不发**，而且没有任何地方会报错。
 *
 * 这与退款那侧是同一个形状：`reconcilePendingRefunds` 就是为此而加的
 *（2026-08-29 查出 syncRefundFromWechat 零调用点）。当时留下的注释说
 *「支付那侧是对称的：syncOrderFromWechat 由 actPollOrder 轮询」——
 * 那句话只在用户不关页面时成立，所以这一侧同样需要服务端定期对账。
 *
 * 【窗口为什么是 7 天】二维码 2 小时就失效，超过这个时间还没终态的单，
 * 要么是回调丢了（这几天内查得到 SUCCESS），要么是没付（会被上面那段关掉）。
 * 再老的单微信侧也早已自动关闭，留着只是白查。
 */
export async function reconcilePendingOrders(
  provider: PayProvider = getPayProvider(),
  now = Date.now(),
): Promise<{ scanned: number; fulfilled: number }> {
  const pending = await prisma.paymentOrder.findMany({
    where: { status: 'created', createdAt: { gte: new Date(now - 7 * 86_400_000) } },
    select: { outTradeNo: true },
    // 上限：一轮对账不该无限拉长。剩下的下一轮继续——它们不会消失
    take: 200,
    orderBy: { createdAt: 'asc' },
  });
  let fulfilled = 0;
  for (const o of pending) {
    // 单条失败不该让其余的这一轮也不对账（与退款对账、daily_recommend 同款隔离）
    const r = await syncOrderFromWechat(o.outTradeNo, provider).catch(() => null);
    if (r?.ok) fulfilled += 1;
  }
  return { scanned: pending.length, fulfilled };
}

// ══════════════════════════════════════════════════════════════════════════
// 退款（全额 / 按天折算 + 安全回收套餐）。
//   口径见 lib/pay/refund-amount.ts：未消耗→全额；已消耗且非买断→按剩余天折算；买断已用→转人工。
//   自助入口在 app/(app)/billing/actions.ts（owner）；内部受控入口在 app/api/internal/pay/refund（ops）。
// ══════════════════════════════════════════════════════════════════════════

/**
 * 「安全可回收」判据：退款时租户当前档位与到期时间，**仍等于本单兑现后写入的结果**。
 * 相等 ⇒ 本单之上没有叠加过后续购买/续费/升档 ⇒ 回收 = 恢复 prevPlan/prevPlanExpiresAt 是安全的。
 * 不等 ⇒ 其上已有更晚的购买，把套餐回滚到 prev 会**抹掉那笔后续购买的天数** ⇒ 拒绝自助、转人工。
 * 这与 assertCanPurchase「宁可拒绝，不做复杂折算」的既有产品哲学一致。
 */
function isSafelyRecoverable(
  order: { plan: string; newPlanExpiresAt: Date | null },
  tenant: { plan: string; planExpiresAt: Date | null },
): boolean {
  if (tenant.plan !== order.plan) return false;
  const a = tenant.planExpiresAt?.getTime() ?? null;
  const b = order.newPlanExpiresAt?.getTime() ?? null;
  return a !== null && b !== null && a === b;
}

/**
 * 本单生效窗口内**用户自己**用掉的真实（非 Mock）AI 调用次数——退款「是否使用」的判据。
 *
 * ── 为什么要排除定时任务（2026-08-30 修）──
 * 原来数的是租户名下**所有**非 Mock 调用。而这些是系统替他跑的、他碰都没碰：
 *   daily_recommend(05:00) / replenish_evergreen(05:20) / optimize_memory(05:30) /
 *   generate_reviews(09:00) / weekly_review(周一 08:00) / run_scheduled_agents(每 10 分钟)
 *
 * 于是：用户 23:00 买了 ¥2999 永久买断，去睡觉；05:00 定时任务替他跑了一轮推荐；
 * 早上他想退款 → consumedCount > 0 → 按 refundPolicyFor 的口径，买断已用要**转人工**。
 * 他什么都没做，睡了一觉，自助全额退款的权利就没了——而这是我们自己替他花掉的。
 *
 * 【byJob 为空 = 用户当场发起】归因在 lib/jobs/current.ts（AsyncLocalStorage），
 * 由 withRun 一处挂上，账本在 recordUsage 里记下。
 * 历史行没有这一列（null），会被算成用户消耗——那是保守的一边：
 * 宁可少退一点也不能凭空多退，何况这一列上线后新单都是准的。
 */
async function consumedCountForOrder(order: { tenantId: string; paidAt: Date | null; createdAt: Date }): Promise<number> {
  return prisma.llmCallLog.count({
    where: {
      tenantId: order.tenantId,
      mocked: false,
      byJob: null, // 定时任务替他跑的不算他消耗
      createdAt: { gte: order.paidAt ?? order.createdAt },
    },
  });
}

function toRefundableOrder(order: {
  amountFen: number;
  periodMonths: number;
  grantedDays: number | null;
  paidAt: Date | null;
  newPlanExpiresAt: Date | null;
}): RefundableOrder {
  return {
    amountFen: order.amountFen,
    periodMonths: order.periodMonths,
    grantedDays: order.grantedDays,
    paidAt: order.paidAt,
    newPlanExpiresAt: order.newPlanExpiresAt,
  };
}

export type RefundPreview =
  | { ok: true; policy: RefundPolicy; recoverable: boolean }
  | { ok: false; reason: string };

/**
 * 退款预览（不发起任何退款）：给 billing 自助入口在确认前展示「能退多少、已用几天」。
 * 与 createRefund 用**同一套** refundPolicyFor + isSafelyRecoverable，口径不漂移。
 */
export async function previewRefund(outTradeNo: string): Promise<RefundPreview> {
  const order = await prisma.paymentOrder.findUnique({ where: { outTradeNo } });
  if (!order) return { ok: false, reason: `订单不存在：${outTradeNo}` };
  if (order.status !== 'paid') return { ok: false, reason: `订单状态为 ${order.status}，只有已支付(paid)的订单可退款` };
  const [tenant, consumedCount] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: order.tenantId }, select: { plan: true, planExpiresAt: true } }),
    consumedCountForOrder(order),
  ]);
  if (!tenant) return { ok: false, reason: '租户不存在' };
  return {
    ok: true,
    policy: refundPolicyFor(toRefundableOrder(order), consumedCount),
    recoverable: isSafelyRecoverable(order, tenant),
  };
}

// 「可复核」退款状态：还可能最终变成 SUCCESS 的中间态。SUCCESS 兑现的条件写、查单兜底都认这一组。
//   unknown  = 发起时网络超时/系统错，微信可能已退款、回执丢了（bug #1）——绝不能当死信。
//   abnormal = 微信退款异常态，文档化时序可后续转 SUCCESS（bug #3）——不是终态。
// 真终态（不再变 SUCCESS）：success（已成）/ closed（微信关闭）/ failed（明确拒绝，钱没动）。
const REFUND_RECONCILABLE = ['created', 'processing', 'unknown', 'abnormal'] as const;

export type CreateRefundInput = {
  outTradeNo: string;
  reason?: string;
  operator: string; // 发起人：memberId（客服代操作）或 'ops'（内部脚本/受控接口）
  notifyUrl?: string; // 退款回调地址（可选，不传则靠 applyRefundResult 的即时/查单兜底）
};

export type CreateRefundResult =
  | { ok: true; outRefundNo: string; status: RefundState; planRecovered: boolean; amountRefundFen: number; kind: RefundPolicy['kind'] }
  | { ok: false; reason: string };

/**
 * 发起退款。v1 只做**全额退款**（refund = 原单 total），且只对能安全回收套餐的订单放行。
 *
 * 🔒 幂等/防重：先落 WxPayRefund（持久化 out_refund_no）再调微信（同 createOrder 范式）；
 * 同一订单已有 created/processing/success 的退款单 → 拒绝再发起（微信按 out_refund_no 幂等，
 * 但我们不希望为同一单生成多个退款号）。发起失败置 failed，不留孤儿。
 */
export async function createRefund(i: CreateRefundInput, provider: PayProvider = getPayProvider()): Promise<CreateRefundResult> {
  const order = await prisma.paymentOrder.findUnique({ where: { outTradeNo: i.outTradeNo } });
  if (!order) return { ok: false, reason: `订单不存在：${i.outTradeNo}` };
  if (order.status !== 'paid') return { ok: false, reason: `订单状态为 ${order.status}，只有已支付(paid)的订单可退款` };

  // 已有活跃/已成的退款单（含 unknown/abnormal 这类可复核态）→ 快路径友好拦截。
  // race-safe 的真正兜底是下面 create 撞 outRefundNo 唯一索引（确定性单号）。
  const existing = await prisma.wxPayRefund.findFirst({
    where: { orderId: order.id, status: { in: [...REFUND_RECONCILABLE, 'success'] } },
    select: { outRefundNo: true, status: true },
  });
  if (existing) return { ok: false, reason: `该订单已存在退款单（${existing.outRefundNo}，状态 ${existing.status}），不重复发起` };

  const tenant = await prisma.tenant.findUnique({ where: { id: order.tenantId }, select: { plan: true, planExpiresAt: true } });
  if (!tenant) return { ok: false, reason: '租户不存在' };
  if (!isSafelyRecoverable(order, tenant)) {
    return {
      ok: false,
      reason: '该订单之上已有后续购买或套餐变更，自助退款会误伤当前套餐。请人工核对后在微信商户平台手动退款并手工调整套餐。',
    };
  }

  // 退款金额口径：未消耗→全额；已消耗且非买断→按剩余天折算；买断已用→转人工（refund-amount.ts）。
  // amountTotalFen 恒为原单金额；amountRefundFen 可小于它（部分退款，通道层已支持）。
  const consumedCount = await consumedCountForOrder(order);
  const policy = refundPolicyFor(toRefundableOrder(order), consumedCount);
  if (policy.kind === 'manual') return { ok: false, reason: policy.reason };
  const amountRefundFen = policy.refundFen;

  // 确定性单号（bug #2 修复）：并发/重试算出同一 out_refund_no，靠 DB 唯一索引兜底「一单一退款」。
  const outRefundNo = outRefundNoForOrder(order.id);

  // 【上一次失败的那行要复用，不能再 create】2026-08-30 修：
  // 上面的 existing 检查**刻意**只拦 REFUND_RECONCILABLE ∪ {success}——
  // 也就是说 failed / closed 是允许重试的，注释里也写着「发起失败置 failed，不留孤儿」。
  // 可单号是确定性派生的、outRefundNo 又是唯一索引，于是重试必然撞 P2002，
  // 被那句「该订单已存在退款单，请勿并发/重复发起」挡回来——而用户根本没有并发。
  // 结果：一次网络抖动导致的 failed，就让这一单的自助退款**永久发不出去**，
  // 只能转人工。同一个函数里两套机制打架。
  //
  // 复用同一行（而不是换个新号）正是这份设计自己写的：
  //「重试复用同号，天然满足微信按 out_refund_no 的退款幂等」（lib/pay/sign.ts）。
  const stale = await prisma.wxPayRefund.findUnique({
    where: { outRefundNo },
    select: { id: true, status: true },
  });
  let refund;
  if (stale) {
    // 走到这里说明 existing 没拦住 → 它一定是 failed/closed。仍然带状态条件更新：
    // 万一在这两行之间它被别的路径推成了活跃态，这次就该落空而不是把它踩回 created。
    const revived = await prisma.wxPayRefund.updateMany({
      where: { id: stale.id, status: { in: ['failed', 'closed'] } },
      data: {
        status: 'created',
        amountRefundFen,
        amountTotalFen: order.amountFen,
        reason: i.reason,
        operator: i.operator,
        failReason: null,
      },
    });
    if (revived.count === 0) {
      return { ok: false, reason: `该订单已存在退款单（${outRefundNo}，状态 ${stale.status}），不重复发起` };
    }
    refund = await prisma.wxPayRefund.findUniqueOrThrow({ where: { id: stale.id } });
  } else {
  try {
    refund = await prisma.wxPayRefund.create({
      data: {
        outRefundNo,
        orderId: order.id,
        outTradeNo: order.outTradeNo,
        tenantId: order.tenantId,
        amountRefundFen,
        amountTotalFen: order.amountFen,
        reason: i.reason,
        operator: i.operator,
      },
    });
  } catch (e) {
    // outRefundNo 唯一索引冲突 = 并发/重试的第二个请求。前面 findFirst 是快路径友好提示，
    // 这里的 P2002 是 race-safe 兜底：不靠 check-then-act，DB 层强制一单一退款。
    if ((e as { code?: string }).code === 'P2002') {
      return { ok: false, reason: `该订单已存在退款单（${outRefundNo}），请勿并发/重复发起` };
    }
    throw e;
  }
  }

  let res;
  try {
    res = await provider.refund({
      outTradeNo: order.outTradeNo,
      outRefundNo,
      amountRefundFen,
      amountTotalFen: order.amountFen,
      reason: i.reason,
      notifyUrl: i.notifyUrl,
    });
  } catch (e) {
    const reason = (e as Error).message.slice(0, 300);
    // 🔒 bug #1 修复：区分「微信明确拒绝（钱没动）」与「网络超时/系统错（钱可能已退，回执丢了）」。
    //   非重试类 WxPayError = 微信收到并以业务错拒绝（4xx，如 REFUND_NOT_ENOUGH）→ 钱没动 → failed（真终态）。
    //   可重试 WxPayError（5xx/429）与任意网络异常 = 微信可能已受理并完成退款，只是回执没回来 →
    //     绝不能落 failed 死信（否则后续 SUCCESS 回调/查单会被永久拒绝，钱退了套餐没回收）→ 落 unknown（可复核）。
    const definiteReject = e instanceof WxPayError && !e.retryable;
    const status = definiteReject ? 'failed' : 'unknown';
    await prisma.wxPayRefund.update({ where: { id: refund.id }, data: { status, failReason: reason } });
    log[definiteReject ? 'error' : 'warn'](`发起退款异常，退款单置 ${status}`, { outRefundNo, reason, definiteReject });
    return {
      ok: false,
      reason: definiteReject ? reason : `${reason}（退款结果未知，请稍后用查单/回调对账，勿直接重发）`,
    };
  }

  // 记 refundId/requestId（status 先不动，交给 applyRefundResult 的条件写去翻，保证幂等）
  await prisma.wxPayRefund.update({
    where: { id: refund.id },
    data: { refundId: res.refundId ?? undefined, requestId: res.requestId },
  });

  if (res.status === 'SUCCESS') {
    const applied = await applyRefundResult({ outRefundNo, refundId: res.refundId, status: 'SUCCESS', successTimeISO: res.successTimeISO, source: 'create' });
    return { ok: true, outRefundNo, status: 'SUCCESS', planRecovered: applied.ok ? applied.planRecovered ?? false : false, amountRefundFen, kind: policy.kind };
  }
  if (res.status === 'CLOSED' || res.status === 'ABNORMAL') {
    await prisma.wxPayRefund.update({ where: { id: refund.id }, data: { status: res.status.toLowerCase(), failReason: `微信退款状态 ${res.status}` } });
    return { ok: false, reason: `微信退款未成功：${res.status}` };
  }
  // PROCESSING：微信处理中，等退款回调 / queryRefund 兜底兑现
  await prisma.wxPayRefund.update({ where: { id: refund.id }, data: { status: 'processing' } });
  return { ok: true, outRefundNo, status: res.status, planRecovered: false, amountRefundFen, kind: policy.kind };
}

export type ApplyRefundInput = {
  outRefundNo: string;
  refundId?: string;
  status: RefundState;
  successTimeISO?: string;
  source: 'create' | 'notify' | 'query';
};

export type ApplyRefundResult =
  | { ok: true; alreadyDone: boolean; planRecovered?: boolean }
  | { ok: false; reason: string };

/**
 * 兑现一笔退款结果（把订单置 refunded + 安全回收套餐）。**退款侧的幂等唯一真值点**——
 * createRefund 的即时 SUCCESS、退款回调、queryRefund 兜底三条入口都走这里。
 *
 * 🔒 幂等靠条件写：updateMany({where:{status:{in:['created','processing']}}}) 的 count===0
 * 即「已被别的入口兑现」。退款回调可能重发/并发，与即时兑现并发，只需在这里正确一次。
 *
 * 套餐回收在事务内**再判一次** isSafelyRecoverable：createRefund 到此可能过了数秒，
 * 极小概率其上又叠加了购买——那时只退钱、不回收套餐、打 error 待人工，绝不误伤后续购买。
 */
export async function applyRefundResult(i: ApplyRefundInput): Promise<ApplyRefundResult> {
  if (i.status !== 'SUCCESS') {
    // 非成功（CLOSED/ABNORMAL）：从可复核态迁移，不回收套餐。ABNORMAL 仍可后续被 SUCCESS 翻转（见下）。
    await prisma.wxPayRefund.updateMany({
      where: { outRefundNo: i.outRefundNo, status: { in: [...REFUND_RECONCILABLE] } },
      data: { status: i.status.toLowerCase(), failReason: `微信退款状态 ${i.status}` },
    });
    return { ok: true, alreadyDone: false };
  }

  const refund = await prisma.wxPayRefund.findUnique({ where: { outRefundNo: i.outRefundNo } });
  if (!refund) return { ok: false, reason: `退款单不存在：${i.outRefundNo}` };
  if (refund.status === 'success') return { ok: true, alreadyDone: true };

  try {
    return await prisma.$transaction(async (tx) => {
      // 同兑现路径：表名必须 schema 限定，否则退款回滚在生产 42P01（钱退了、套餐没回滚）
      if (!process.env.DATABASE_URL?.startsWith('file:')) {
        await tx.$queryRawUnsafe(`SELECT 1 FROM ${qualifiedTable('Tenant')} WHERE id = $1 FOR UPDATE`, refund.tenantId);
      }
      const order = await tx.paymentOrder.findUnique({
        where: { id: refund.orderId },
        select: { plan: true, prevPlan: true, prevPlanExpiresAt: true, newPlanExpiresAt: true },
      });
      if (!order) return { ok: false as const, reason: '原订单不存在' };
      const tenant = await tx.tenant.findUnique({ where: { id: refund.tenantId }, select: { plan: true, planExpiresAt: true } });
      if (!tenant) return { ok: false as const, reason: '租户不存在' };

      const recoverable = isSafelyRecoverable(order, tenant);

      // ★ 幂等点：条件写退款单 可复核态 → success（含 unknown/abnormal，修 bug #1/#3：
      //   微信最终真的退成功时，即便我们此前落了 unknown/abnormal 也必须能兑现回收）
      const claimed = await tx.wxPayRefund.updateMany({
        where: { id: refund.id, status: { in: [...REFUND_RECONCILABLE] } },
        data: {
          status: 'success',
          refundId: i.refundId ?? refund.refundId,
          successAt: i.successTimeISO ? new Date(i.successTimeISO) : new Date(),
          planRecovered: recoverable,
          recoveredPlan: recoverable ? order.prevPlan ?? 'free' : null,
          recoveredPlanExpiresAt: recoverable ? order.prevPlanExpiresAt : null,
        },
      });
      if (claimed.count === 0) return { ok: true as const, alreadyDone: true as const };

      // 订单置 refunded（仅当仍 paid）
      await tx.paymentOrder.updateMany({ where: { id: refund.orderId, status: 'paid' }, data: { status: 'refunded' } });

      if (recoverable) {
        // 回滚到兑现前：prevPlan 为空（原本 free 首购）→ 回 free
        await tx.tenant.update({
          where: { id: refund.tenantId },
          data: { plan: order.prevPlan ?? 'free', planExpiresAt: order.prevPlanExpiresAt },
        });
        invalidatePlanCache(refund.tenantId);
      } else {
        log.error('退款成功但套餐无法安全回收（其上已有后续购买/变更），已退款未降档，需人工处理', {
          outRefundNo: i.outRefundNo,
          tenantId: refund.tenantId,
        });
      }
      log.info('退款兑现成功', { outRefundNo: i.outRefundNo, source: i.source, planRecovered: recoverable });
      return { ok: true as const, alreadyDone: false as const, planRecovered: recoverable };
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      // refundId 撞唯一索引 = 同一笔微信退款想兑现两次
      log.warn('退款 refundId 重复，判定为重复兑现', { outRefundNo: i.outRefundNo, refundId: i.refundId });
      return { ok: true, alreadyDone: true };
    }
    throw e;
  }
}

/**
 * 把所有还在可复核态的退款单向微信查一遍。
 *
 * 【为什么必须有这个，而不是只留一个「等人调」的函数】
 * `syncRefundFromWechat` 的注释写着「退款回调丢了也要能兑现 · 前端/内部轮询触发」——
 * 但 2026-08-29 全库扫描查出：**它一个调用点都没有**。
 * 支付那侧是对称的：`syncOrderFromWechat` 由 `actPollOrder` 在用户盯着二维码时轮询，
 * 而退款没有对应的东西——用户点完退款就走了，没人会守着页面。
 * 于是那句「靠即时返回 + 查单兜底」在退款这条路上是**假的**：
 * 回调一丢（反代过滤 Wechatpay-* 头、公网抖动——支付那侧的注释就写着这两种），
 * 退款单永远停在 processing，钱退了而我们这边的套餐没收回。
 *
 * 【为什么是定时而不是轮询】退款是异步的，微信可能几分钟也可能几天才终态。
 * 用户不会守着页面，所以只能由服务端定期对账——这与移除申请「流转时删一次 +
 * 每日重扫第二道」是同一个形状。
 */
export async function reconcilePendingRefunds(
  provider: PayProvider = getPayProvider(),
): Promise<{ scanned: number; settled: number }> {
  const pending = await prisma.wxPayRefund.findMany({
    where: { status: { in: [...REFUND_RECONCILABLE] } },
    select: { outRefundNo: true },
    // 上限：一轮对账不该无限拉长。剩下的下一轮继续——它们不会消失
    take: 200,
    orderBy: { createdAt: 'asc' },
  });
  let settled = 0;
  for (const r of pending) {
    // 单条失败不该让其余的这一轮也不对账（与 daily_recommend 的 per-tenant 隔离同款）
    const applied = await syncRefundFromWechat(r.outRefundNo, provider).catch(() => null);
    if (applied?.ok) settled += 1;
  }
  return { scanned: pending.length, settled };
}

/** 退款查单兜底（退款回调丢了也要能兑现）。由 reconcilePendingRefunds 定时调用。 */
export async function syncRefundFromWechat(outRefundNo: string, provider: PayProvider = getPayProvider()): Promise<ApplyRefundResult | null> {
  const refund = await prisma.wxPayRefund.findUnique({ where: { outRefundNo }, select: { status: true } });
  if (!refund) return { ok: false, reason: '退款单不存在' };
  // 只对真终态短路（success/closed/failed）。unknown/abnormal 是可复核态，必须继续查单兑现（修 bug #1/#3）。
  if (!(REFUND_RECONCILABLE as readonly string[]).includes(refund.status)) return null;

  let q;
  try {
    q = await provider.queryRefund(outRefundNo);
  } catch (e) {
    log.warn('退款查单失败', { outRefundNo, err: (e as Error).message });
    return null;
  }
  return applyRefundResult({ outRefundNo, refundId: q.refundId, status: q.status, successTimeISO: q.successTimeISO, source: 'query' });
}
