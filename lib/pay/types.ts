// 支付通道抽象。与 lib/sms/provider.ts、lib/llm/gateway.ts 同构：
// 开发态 Mock、生产态真实通道，**生产态绝不回退 Mock**。

/** Native 下单入参。金额由服务端算好传进来，通道层不碰定价。 */
export type CreateNativeParams = {
  outTradeNo: string;
  amountFen: number; // 整数分
  description: string; // 已剥 emoji（APIv3 只收 1-3 字节 UTF-8）
  timeExpireISO?: string; // RFC3339，不传则微信默认 7 天
  attach?: string;
};

export type CreateNativeResult = {
  codeUrl: string; // weixin://wxpay/bizpayurl/... 原样转二维码，别自己拼参数
  requestId?: string; // 微信应答头 Request-ID，报障必须提供 → 落库
};

/** 查单结果。Native 场景 tradeState 实际只会是前 4 种。 */
export type TradeState = 'SUCCESS' | 'REFUND' | 'NOTPAY' | 'CLOSED' | 'REVOKED' | 'USERPAYING' | 'PAYERROR';

export type QueryResult = {
  tradeState: TradeState;
  tradeStateDesc?: string;
  transactionId?: string; // 未支付的订单没有它
  amountTotalFen?: number;
  successTimeISO?: string;
  requestId?: string;
};

/** 退款状态（微信 /v3/refund 的 status）。 */
export type RefundState = 'SUCCESS' | 'PROCESSING' | 'CLOSED' | 'ABNORMAL';

/** 发起退款入参。金额由服务端从原订单读，通道层不算钱。v1 只做全额退款（refund=total）。 */
export type RefundParams = {
  outTradeNo: string; // 原支付商户订单号
  outRefundNo: string; // 商户退款单号（幂等键，重试必须复用）
  amountRefundFen: number; // 退款金额（分）
  amountTotalFen: number; // 原订单总额（分），必须等于原单金额
  reason?: string;
  notifyUrl?: string; // 退款结果回调地址，可不传（不传则无回调，靠查单兜底）
};

export type RefundResult = {
  outRefundNo?: string;
  refundId?: string; // 微信退款单号，全局唯一
  status: RefundState;
  amountRefundFen?: number;
  successTimeISO?: string; // status=SUCCESS 时的退款成功时间
  requestId?: string;
};

export interface PayProvider {
  readonly name: string;
  readonly mocked: boolean;
  createNative(p: CreateNativeParams): Promise<CreateNativeResult>;
  /** 查单：回调不可靠时的兜底。官方明确「不能仅依赖回调通知」。 */
  queryByOutTradeNo(outTradeNo: string): Promise<QueryResult>;
  /** 发起退款。 */
  refund(p: RefundParams): Promise<RefundResult>;
  /** 退款查单：退款回调不可靠时的兜底（同支付，官方明确不能只依赖回调）。 */
  queryRefund(outRefundNo: string): Promise<RefundResult>;
}

/** 微信支付业务错误。code 是 APIv3 的下划线码（注意不是 APIv2 的 NOAUTH/ORDERPAID 那套）。 */
export class WxPayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly requestId?: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'WxPayError';
  }

  /**
   * 是否值得重试。
   * 只有 SYSTEM_ERROR(500/501/503) 与 FREQUENCY_LIMITED(429) 该重试，
   * 且 SYSTEM_ERROR 必须用**完全相同的参数**（含相同 out_trade_no，微信保证幂等）。
   * 4xx 全是我们自己的错，重试没有意义。
   */
  get retryable(): boolean {
    return this.code === 'SYSTEM_ERROR' || this.code === 'FREQUENCY_LIMITED';
  }
}
