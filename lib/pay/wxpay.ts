import { log } from '../logger';
import { buildAuthorization, newNonceStr, nowTimestamp, stripAstralChars } from './sign';
import {
  WxPayError,
  type CreateNativeParams,
  type CreateNativeResult,
  type PayProvider,
  type QueryResult,
  type RefundParams,
  type RefundResult,
  type RefundState,
  type TradeState,
} from './types';

// 微信支付 APIv3 · Native 扫码下单 + 查单。
//
// 只做公钥模式，不实现 /v3/certificates 与平台证书轮换 —— 官方明确：
// 「如果你是新申请的商户号…且是全新开发的支付系统，该系统此前从未对接过平台证书模式，则无需切换」。
// ⚠️ 上线前必须确认商户号是新号：存量号在公钥灰度期，**回调由微信随机选公钥或平台证书验签**，
// 那种情况下本实现的回调会间歇性验签失败。这是唯一需要向商户侧确认的事实（见 docs/微信支付接入.md）。

const MAIN_HOST = 'https://api.mch.weixin.qq.com';

export type WxPayConfig = {
  appid: string;
  mchid: string;
  serialNo: string; // 商户 API 证书序列号（40 位大写 hex）
  privateKeyPem: string; // apiclient_key.pem 全文
  notifyUrl: string; // 必须 https、外网可达、不带 query
  /** 可覆盖，用于单测把 HTTP 打到本地假服务器 */
  host?: string;
  fetchImpl?: typeof fetch;
};

type ErrorBody = { code?: string; message?: string; detail?: unknown };

export class WxPayNativeProvider implements PayProvider {
  readonly name = 'wxpay-native';
  readonly mocked = false;

  constructor(private readonly cfg: WxPayConfig) {}

  private get host(): string {
    return this.cfg.host ?? MAIN_HOST;
  }

  private get fetchImpl(): typeof fetch {
    return this.cfg.fetchImpl ?? fetch;
  }

  /**
   * 发一个已签名的 APIv3 请求。
   * 关键不变式：**签名用的 body 字节 = 实际发出的 body 字节**。
   * 所以 body 只 JSON.stringify 一次，之后签它、发它 —— 二次序列化必然 401 SIGN_ERROR。
   */
  private async call<T>(method: 'GET' | 'POST', urlPath: string, bodyObj?: unknown): Promise<{ data: T; requestId?: string }> {
    const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
    const authorization = buildAuthorization({
      mchid: this.cfg.mchid,
      serialNo: this.cfg.serialNo,
      privateKeyPem: this.cfg.privateKeyPem,
      method,
      urlPath, // 必须与实际请求逐字节一致（含 query）
      body,
      timestamp: nowTimestamp(),
      nonceStr: newNonceStr(),
    });

    const res = await this.fetchImpl(`${this.host}${urlPath}`, {
      method,
      headers: {
        Authorization: authorization,
        Accept: 'application/json',
        // Node 的 fetch 默认 Accept: */*，微信要 application/json；
        // 且官方明确「很可能会拒绝处理无 User-Agent 的请求」，显式给一个。
        'User-Agent': 'beacon/1.0',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body } : {}),
    });

    // Request-ID 是微信侧请求唯一标识，报障必须提供 → 一定要记
    const requestId = res.headers.get('Request-ID') ?? undefined;
    const text = await res.text();

    if (!res.ok) {
      let e: ErrorBody = {};
      try {
        e = JSON.parse(text) as ErrorBody;
      } catch {
        // 非 JSON 错误体（网关 502 之类）
      }
      const code = e.code ?? `HTTP_${res.status}`;
      log.error('微信支付接口返回错误', { urlPath, status: res.status, code, message: e.message, requestId });
      throw new WxPayError(code, e.message ?? `微信支付接口 ${res.status}`, res.status, requestId, e.detail);
    }

    return { data: (text ? JSON.parse(text) : {}) as T, requestId };
  }

  async createNative(p: CreateNativeParams): Promise<CreateNativeResult> {
    if (!Number.isInteger(p.amountFen) || p.amountFen <= 0) {
      throw new Error(`下单金额必须是正整数分，收到 ${p.amountFen}`);
    }
    const body: Record<string, unknown> = {
      appid: this.cfg.appid,
      mchid: this.cfg.mchid,
      description: stripAstralChars(p.description).slice(0, 127), // emoji 会被 APIv3 拒
      out_trade_no: p.outTradeNo,
      notify_url: this.cfg.notifyUrl,
      amount: { total: p.amountFen, currency: 'CNY' },
    };
    if (p.timeExpireISO) body.time_expire = p.timeExpireISO;
    if (p.attach) body.attach = stripAstralChars(p.attach).slice(0, 128);

    const { data, requestId } = await this.call<{ code_url: string }>('POST', '/v3/pay/transactions/native', body);
    if (!data.code_url) {
      throw new WxPayError('INVALID_RESPONSE', '微信下单成功但未返回 code_url', 200, requestId);
    }
    return { codeUrl: data.code_url, requestId };
  }

  async queryByOutTradeNo(outTradeNo: string): Promise<QueryResult> {
    // mchid 是**必填 query 参数** → 签名的 URL 行必须带上它，且与实际请求逐字节一致
    const urlPath = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(this.cfg.mchid)}`;
    const { data, requestId } = await this.call<{
      trade_state: TradeState;
      trade_state_desc?: string;
      transaction_id?: string;
      success_time?: string;
      amount?: { total?: number };
    }>('GET', urlPath);
    return {
      tradeState: data.trade_state,
      tradeStateDesc: data.trade_state_desc,
      transactionId: data.transaction_id,
      amountTotalFen: data.amount?.total,
      successTimeISO: data.success_time,
      requestId,
    };
  }

  async refund(p: RefundParams): Promise<RefundResult> {
    if (!Number.isInteger(p.amountRefundFen) || p.amountRefundFen <= 0) {
      throw new Error(`退款金额必须是正整数分，收到 ${p.amountRefundFen}`);
    }
    if (p.amountRefundFen > p.amountTotalFen) {
      throw new Error(`退款金额 ${p.amountRefundFen} 不能大于原订单金额 ${p.amountTotalFen}`);
    }
    // out_trade_no 与 transaction_id 二选一定位原单；我们用 out_trade_no（下单时自己生成的，一定有）。
    const body: Record<string, unknown> = {
      out_trade_no: p.outTradeNo,
      out_refund_no: p.outRefundNo,
      amount: { refund: p.amountRefundFen, total: p.amountTotalFen, currency: 'CNY' },
    };
    if (p.reason) body.reason = stripAstralChars(p.reason).slice(0, 80);
    // notify_url 可不传：不传则微信不发退款回调，靠 queryRefund 兜底
    if (p.notifyUrl) body.notify_url = p.notifyUrl;

    const { data, requestId } = await this.call<{
      refund_id?: string;
      out_refund_no?: string;
      status?: RefundState;
      success_time?: string;
      amount?: { refund?: number };
    }>('POST', '/v3/refund/domestic/refunds', body);
    // 下单响应即带 status：SUCCESS（多为余额退款即时到账）/ PROCESSING / ABNORMAL / CLOSED
    return {
      outRefundNo: data.out_refund_no ?? p.outRefundNo,
      refundId: data.refund_id,
      status: data.status ?? 'PROCESSING',
      amountRefundFen: data.amount?.refund ?? p.amountRefundFen,
      successTimeISO: data.success_time,
      requestId,
    };
  }

  async queryRefund(outRefundNo: string): Promise<RefundResult> {
    // 退款查单按 out_refund_no，路径参数即可，无必填 query（与支付查单不同，不带 mchid）
    const urlPath = `/v3/refund/domestic/refunds/${encodeURIComponent(outRefundNo)}`;
    const { data, requestId } = await this.call<{
      refund_id?: string;
      out_refund_no?: string;
      status?: RefundState;
      success_time?: string;
      amount?: { refund?: number };
    }>('GET', urlPath);
    return {
      outRefundNo: data.out_refund_no ?? outRefundNo,
      refundId: data.refund_id,
      status: data.status ?? 'PROCESSING',
      amountRefundFen: data.amount?.refund,
      successTimeISO: data.success_time,
      requestId,
    };
  }
}
