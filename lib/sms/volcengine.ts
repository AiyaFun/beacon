import crypto from 'node:crypto';
import { signVolcRequest } from './sign';
import type { SmsProvider } from './provider';

// 火山引擎短信 SendSms 真实通道。
// 契约要点：Service 固定 volcSMS（大小写敏感，写成 sms 会得到 RE:0000 且无任何提示）；
// Action/Version 走 query string 不进 body；字段名一律 PascalCase（TemplateID 的 ID 大写）。

const HOST = 'sms.volcengineapi.com';
const SERVICE = 'volcSMS';
const VERSION = '2020-01-01';
const ACTION = 'SendSms';
const DEFAULT_REGION = 'cn-north-1';

// 只有这两个是"重试有意义"的：0500 是未知交互类错误（文档明说可重试），0013 是超阈值。
// 其余错误码全是配置/参数问题，重试只会浪费配额。
const RETRYABLE = new Set(['RE:0500', 'RE:0013']);
const MAX_ATTEMPTS = 3;

// 把错误码映射成可直接照着排查的中文信息，default 兜底
//（文档还提到未列出的"公共错误码"，所以这里不能写成穷举）。
const ERROR_HINTS: Record<string, string> = {
  'RE:0000': '账号鉴权失败：AK/SK 错误或签名实现有问题',
  'RE:0001': '该火山账号未开通短信服务，请在控制台开通',
  'RE:0002': '火山账号已被关停，请联系火山客服',
  'RE:0003': '消息组不存在：BEACON_VOLC_SMS_ACCOUNT 需填消息组 ID，不是消息组名称',
  'RE:0004': '短信签名错误：BEACON_VOLC_SMS_SIGN 未过审，或不属于该消息组',
  'RE:0005': '短信模板错误：BEACON_VOLC_SMS_TEMPLATE 未过审，或不属于该消息组',
  'RE:0006': '手机号格式错误',
  'RE:0007': '服务器 IP 未加入火山短信白名单（换机器/扩容后需重新加白）',
  'RE:0009': '请求参数错误：字段名或类型不对',
  'RE:0010': '火山账号欠费，短信服务已暂停，请充值',
  'RE:0011': '不支持向该地区下发，需先申请地区权限',
  'RE:0012': '消息组未开通该短信类型',
  'RE:0013': '发送量超出阈值，请检查控制台的发送上限设置',
  'RE:0500': '火山短信服务未知错误',
};

export interface VolcSmsConfig {
  accessKeyId: string;
  secretAccessKey: string;
  smsAccount: string; // 消息组 ID（火山管理接口里叫 SubAccountId），当不透明字符串处理
  sign: string; // 短信签名内容（如「烽火台」），不是签名 ID
  templateId: string;
  paramName: string; // 模板变量名
  region: string;
}

interface SendSmsResponse {
  ResponseMetadata?: {
    RequestId?: string;
    Error?: { Code?: string; Message?: string };
  };
  Result?: { MessageID?: string[] };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class VolcengineSmsProvider implements SmsProvider {
  readonly name = 'volcengine-sms';
  readonly mocked = false;

  constructor(private cfg: VolcSmsConfig) {}

  async sendCode(phone: string, code: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const err = await this.send(phone, code);
      if (!err) return;
      if (attempt >= MAX_ATTEMPTS || !RETRYABLE.has(err.code)) {
        throw new Error(`火山短信发送失败 [${err.code}] ${err.message}`);
      }
      // 指数退避。注意 RE:0500 重试可能重复下发（上一次也许已进队列），
      // 验证码场景由上层的 60s 冷却兜底。
      await sleep(500 * 2 ** (attempt - 1));
    }
  }

  // 发一次。成功返回 null，失败返回错误码信息（供上层决定是否重试）。
  private async send(phone: string, code: string): Promise<{ code: string; message: string } | null> {
    // body 只序列化一次并存成变量：算 sha 和发请求必须用同一个字符串，
    // 序列化两次可能产生不同字节，签名必挂。
    const body = JSON.stringify({
      SmsAccount: this.cfg.smsAccount,
      Sign: this.cfg.sign,
      TemplateID: this.cfg.templateId,
      // TemplateParam 是被转义的嵌套 JSON 字符串，不是对象
      TemplateParam: JSON.stringify({ [this.cfg.paramName]: code }),
      PhoneNumbers: phone,
      Tag: crypto.randomUUID(), // 透传字段，回执的 ext 参数会原样带回，便于对账
      // 不传 UserExtCode：SDK 结构体里有，但文档零记载、语义未知
    });

    const query = { Action: ACTION, Version: VERSION };
    const signed = signVolcRequest({
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
      region: this.cfg.region,
      service: SERVICE,
      method: 'POST',
      path: '/',
      host: HOST,
      query,
      body,
      date: new Date(),
      headers: { 'content-type': 'application/json' },
      signContentSha256: true, // Go SDK 路线：content-type;host;x-content-sha256;x-date
    });

    let res: Response;
    try {
      res = await fetch(`https://${HOST}/?${new URLSearchParams(query)}`, {
        method: 'POST',
        headers: {
          // 签什么就必须原样发什么。显式写死 application/json，
          // 不能让客户端改写成带 charset 的形式，否则与签名值不符。
          // （Host 头不用手写：fetch 忽略它，按 URL 自动带上，正好等于入签的 HOST）
          'Content-Type': 'application/json',
          'X-Date': signed.xDate,
          'X-Content-Sha256': signed.bodySha,
          Authorization: signed.authorization,
        },
        body, // 与算 bodySha 的同一个变量
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      // 网络层失败：不进重试（验证码场景宁可让用户重发，也不冒重复下发的风险）
      throw new Error(`火山短信请求失败：${(e as Error).message}`);
    }

    const text = await res.text();
    let data: SendSmsResponse;
    try {
      data = JSON.parse(text) as SendSmsResponse;
    } catch {
      throw new Error(`火山短信返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }

    // 失败时 HttpCode 依然是 200，且 Result.MessageID 依然有值——
    // 这两个都不能用来判定成败，唯一可靠的判据是 ResponseMetadata.Error。
    const error = data.ResponseMetadata?.Error;
    if (!error?.Code) return null;
    const hint = ERROR_HINTS[error.Code] ?? error.Message ?? '未知错误码，请查火山公共错误码文档';
    return { code: error.Code, message: hint };
  }
}
