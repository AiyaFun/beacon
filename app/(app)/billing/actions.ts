'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { requireRole } from '@/lib/rbac';
import { isProd } from '@/lib/env';
import { createOrder, createRefund, previewRefund, syncOrderFromWechat } from '@/lib/pay/order';
import { getPayProvider } from '@/lib/pay/provider';
import { MockPayProvider } from '@/lib/pay/mock';
import { renderQrSvg } from '@/lib/pay/qr';
import { isPaidPlan, isPeriodMonths } from '@/lib/pay/pricing';
import { invoiceContact } from '@/lib/constants';

// 计费相关 server action。
// 权限：计费关系到租户钱包，仅 owner（lib/rbac.ts 的 billing.manage）。
// server action 就是公开 RPC —— 页面上藏起按钮拦不住任何人，守卫必须在这里。

// ── 下单：返回二维码 SVG ──
export async function actCreateOrder(data: { plan: string; periodMonths: number }) {
  const s = await getSession();
  requireRole(s, 'billing.manage');

  // 🔒 前端只能传这两个枚举，金额由服务端按 plan+period 算（lib/pay/pricing.ts）。
  // 这个 action 的入参里没有 amount，也永远不该有 —— 否则改个请求就是 1 分钱买团队版。
  const plan = String(data?.plan ?? '');
  const periodMonths = Number(data?.periodMonths);
  if (!isPaidPlan(plan)) return { ok: false as const, error: '请选择有效的套餐档位' };
  if (!isPeriodMonths(periodMonths)) return { ok: false as const, error: '购买时长仅支持 1 个月或 12 个月' };

  try {
    const r = await createOrder({ tenantId: s.tenantId, memberId: s.memberId, plan, periodMonths });
    revalidatePath('/billing');
    return {
      ok: true as const,
      outTradeNo: r.outTradeNo,
      amountFen: r.amountFen,
      qrSvg: renderQrSvg(r.codeUrl, { size: 240 }),
      codeExpiresAt: r.codeExpiresAt.toISOString(),
      mocked: r.mocked,
    };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
}

// ── 轮询订单状态：顺便向微信查一次单（回调兜底）──
export async function actPollOrder(outTradeNo: string) {
  const s = await getSession();
  requireRole(s, 'billing.manage');

  // 必须限定 tenantId：否则拿别人的单号来轮询就能读到别的租户的订单状态
  const own = await prisma.paymentOrder.findFirst({
    where: { outTradeNo: String(outTradeNo ?? ''), tenantId: s.tenantId },
    select: { id: true, status: true },
  });
  if (!own) return { ok: false as const, error: '订单不存在' };

  // 回调可能丢（反代过滤了 Wechatpay-* 头、公网抖动…）。官方明确「不能仅依赖回调通知」，
  // 所以每次轮询顺手查一次微信 —— 回调丢了也能正常发货。
  if (own.status === 'created') {
    await syncOrderFromWechat(outTradeNo).catch(() => null);
  }

  const fresh = await prisma.paymentOrder.findFirst({
    where: { outTradeNo, tenantId: s.tenantId },
    select: { status: true, failReason: true, newPlanExpiresAt: true, grantedDays: true, plan: true },
  });
  if (fresh?.status === 'paid') revalidatePath('/billing');
  return {
    ok: true as const,
    status: fresh?.status ?? 'created',
    failReason: fresh?.failReason ?? null,
    plan: fresh?.plan ?? null,
    grantedDays: fresh?.grantedDays ?? null,
    newPlanExpiresAt: fresh?.newPlanExpiresAt?.toISOString() ?? null,
  };
}

// ── dev 专用：模拟支付成功 ──
export async function actMockPay(outTradeNo: string) {
  const s = await getSession();
  requireRole(s, 'billing.manage');

  // 🔒 三道闸，任意一道不满足都拒绝。这个 action 的存在本身就是风险 ——
  // 它一旦能在生产被调到，就是「点一下免费升团队版」。
  // 账号接管那个洞的根因正是「是否 Mock」被当成了「是否 dev」的开关，这里两个条件都要满足：
  //   1. 不是生产态（NODE_ENV/BEACON_ENV）
  //   2. 当前通道**确实**是 Mock 实例（生产态根本构造不出 MockPayProvider）
  if (isProd()) return { ok: false as const, error: '生产环境不可用' };
  const provider = getPayProvider();
  if (!provider.mocked || !(provider instanceof MockPayProvider)) {
    return { ok: false as const, error: '当前不是 Mock 支付通道' };
  }

  const own = await prisma.paymentOrder.findFirst({
    where: { outTradeNo: String(outTradeNo ?? ''), tenantId: s.tenantId },
    select: { id: true },
  });
  if (!own) return { ok: false as const, error: '订单不存在' };

  // 标记完不直接兑现，让前端轮询走「查单兜底」那条**生产同款**路径去兑现，
  // 这样 Mock 流程验证的是真实兑现代码（含幂等），而不是一条只有 dev 才走的旁路。
  provider.markPaid(outTradeNo);
  return { ok: true as const };
}

// ── 退款：预览（不发起）──
// 自助退款仅 owner（billing.manage）。口径：未消耗→全额；已消耗且非买断→按剩余天折算；
// 买断已用→转人工。金额一律服务端算（previewRefund → refundPolicyFor），前端只传单号。
export async function actRefundPreview(outTradeNo: string) {
  const s = await getSession();
  requireRole(s, 'billing.manage');

  // 必须限定 tenantId：否则拿别人的单号就能读到别的租户订单的退款口径
  const own = await prisma.paymentOrder.findFirst({
    where: { outTradeNo: String(outTradeNo ?? ''), tenantId: s.tenantId },
    select: { id: true },
  });
  if (!own) return { ok: false as const, error: '订单不存在' };

  const r = await previewRefund(String(outTradeNo));
  if (!r.ok) return { ok: false as const, error: r.reason };
  const cs = invoiceContact();
  return {
    ok: true as const,
    kind: r.policy.kind,
    refundFen: r.policy.refundFen,
    usedDays: r.policy.usedDays,
    remainingDays: r.policy.remainingDays,
    totalDays: r.policy.totalDays,
    consumedCount: r.policy.consumedCount,
    reason: r.policy.reason,
    recoverable: r.recoverable,
    csEmail: cs.email,
    csWechat: cs.wechat,
  };
}

// ── 退款：发起 ──
export async function actRefundOrder(outTradeNo: string, reason?: string) {
  const s = await getSession();
  requireRole(s, 'billing.manage');

  const own = await prisma.paymentOrder.findFirst({
    where: { outTradeNo: String(outTradeNo ?? ''), tenantId: s.tenantId },
    select: { id: true },
  });
  if (!own) return { ok: false as const, error: '订单不存在' };

  // 退款回调地址（可选）：配了就传给微信让退款结果异步回调；没配则靠即时返回 + 查单兜底
  const notifyUrl = process.env.BEACON_WXPAY_REFUND_NOTIFY_URL?.trim() || undefined;
  const r = await createRefund({
    outTradeNo: String(outTradeNo),
    reason: (reason ?? '用户自助申请退款').slice(0, 80),
    operator: s.memberId, // 审计：谁发起的
    notifyUrl,
  });
  if (r.ok) revalidatePath('/billing');
  return r.ok
    ? { ok: true as const, status: r.status, amountRefundFen: r.amountRefundFen, kind: r.kind, planRecovered: r.planRecovered }
    : { ok: false as const, error: r.reason };
}
