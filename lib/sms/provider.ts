// 短信服务商抽象。开发态用 Mock（把验证码打到控制台，登录页在 dev 下直接回显）；
// 生产态必须设 BEACON_SMS_VENDOR=volcengine 切火山引擎真实通道。
//
// 🔒 安全不变式：**生产态永远不会是 Mock 通道**。
// Mock 通道 = 谁都能拿到任意手机号的验证码 = 认证旁路。所以生产态未配 vendor 不是
// 「回退 Mock」而是「拒绝启动」，见下面工厂里的 throw。上层（lib/auth.ts 的 devCode、
// app/login/actions.ts 的限流逃生口）都依赖这条不变式，改动前先想清楚。

import { VolcengineSmsProvider } from './volcengine';
import { isProd } from '../env';

export interface SmsProvider {
  readonly name: string;
  readonly mocked: boolean;
  sendCode(phone: string, code: string): Promise<void>;
}

class MockSmsProvider implements SmsProvider {
  readonly name = 'mock-sms';
  readonly mocked = true;
  async sendCode(phone: string, code: string): Promise<void> {
    // 纵深防御：工厂已保证生产态到不了这里，但万一到了也绝不打明文验证码
    // （console.log 还绕过了 lib/logger 的脱敏，日志一旦外泄就是批量账号接管）。
    if (isProd()) return;
    console.log(`[mock-sms] 向 ${phone} 发送验证码：${code}`);
  }
}

// 用户已开通的消息组与模板，可用 env 覆盖
const DEFAULT_SMS_ACCOUNT = '1b6d4896';
const DEFAULT_TEMPLATE_ID = 'S1T_1y2pb4u4rerr6';
// 模板变量名：文档示例用 code、SDK demo 用 content，取决于控制台建模板时的定义。
// 这里默认 code，若线上报 RE:0005/RE:0009，第一个要核对的就是它。
const DEFAULT_PARAM_NAME = 'code';

let cached: SmsProvider | null = null;

// 懒校验（同 lib/crypto.ts:20 的 masterKey）：只在第一次真正取通道时校验并缓存。
// 为什么不在模块顶层校验 —— app/login/actions.ts → lib/auth.ts → 本模块，
// next build 收集页面数据时会加载它，而构建期 NODE_ENV=production 且没有 env，
// 顶层 throw 会把构建打挂。推迟到调用点后：构建不受影响，生产上第一次发码就炸 —— 依旧 fail-fast。
export function getSmsProvider(): SmsProvider {
  if (cached) return cached;
  const vendor = process.env.BEACON_SMS_VENDOR?.trim();

  // 未配置 vendor（含空串）
  if (!vendor) {
    // 生产态：绝不静默回退 Mock。回退等于开了一条无声的认证旁路 ——
    // 任何人在登录页输入任意手机号就能拿到验证码并登进去。宁可炸掉，不可将就。
    if (isProd()) {
      throw new Error(
        '[beacon/sms] 生产环境安全阻塞：未配置 BEACON_SMS_VENDOR。\n' +
          '生产环境必须配置真实短信通道 —— 回退 Mock 通道会把验证码直接回显给调用方，\n' +
          '等同于任意账号可被接管。\n' +
          '请设置 BEACON_SMS_VENDOR=volcengine 并配齐 BEACON_VOLC_SMS_AK / _SK / _SIGN。\n' +
          '（本地开发请勿设置 NODE_ENV=production / BEACON_ENV=prod。）',
      );
    }
    // dev 态零基础设施可跑：无 key 也能登录联调
    cached = new MockSmsProvider();
    return cached;
  }
  if (vendor !== 'volcengine') {
    throw new Error(`BEACON_SMS_VENDOR=${vendor} 不支持，当前仅支持 volcengine（留空则使用 dev 态 Mock 通道）`);
  }

  // 配置错误要 fail-fast，不能等用户点「发验证码」时才炸
  const required = {
    BEACON_VOLC_SMS_AK: process.env.BEACON_VOLC_SMS_AK,
    BEACON_VOLC_SMS_SK: process.env.BEACON_VOLC_SMS_SK,
    BEACON_VOLC_SMS_SIGN: process.env.BEACON_VOLC_SMS_SIGN,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    throw new Error(`BEACON_SMS_VENDOR=volcengine 但缺少必需环境变量：${missing.join('、')}`);
  }

  cached = new VolcengineSmsProvider({
    accessKeyId: required.BEACON_VOLC_SMS_AK!,
    secretAccessKey: required.BEACON_VOLC_SMS_SK!,
    sign: required.BEACON_VOLC_SMS_SIGN!,
    smsAccount: process.env.BEACON_VOLC_SMS_ACCOUNT || DEFAULT_SMS_ACCOUNT,
    templateId: process.env.BEACON_VOLC_SMS_TEMPLATE || DEFAULT_TEMPLATE_ID,
    paramName: process.env.BEACON_VOLC_SMS_PARAM_NAME || DEFAULT_PARAM_NAME,
    region: process.env.BEACON_VOLC_SMS_REGION || 'cn-north-1',
  });
  return cached;
}
