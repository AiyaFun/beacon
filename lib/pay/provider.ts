import { isProd } from '../env';
import { MockPayProvider } from './mock';
import { WxPayNativeProvider } from './wxpay';
import type { PayProvider } from './types';

// 支付通道工厂。开发态用 Mock（零凭证跑通全流程）；生产态必须设 BEACON_PAY_VENDOR=wxpay。
//
// 🔒 安全不变式：**生产态永远不会是 Mock 通道**。
// Mock 通道 = 谁都能点一下「模拟支付成功」把自己升到团队版 = 免费升档。
// 所以生产态未配 vendor 不是「回退 Mock」而是「拒绝服务」，见下面工厂里的 throw。
// 这正是账号接管漏洞的同款结构（那次是「是否 Mock」被当成了「是否 dev」的开关，
// 而生产模板默认回退 Mock）—— 这里「是否 Mock」只由 **BEACON_PAY_VENDOR 是否配置**决定，
// 且生产态缺配是**硬失败**，不存在静默回退的分支。
//
// 懒校验（同 lib/sms/provider.ts:42、lib/crypto.ts:20）：只在第一次真正取通道时校验并缓存。
// 不能在模块顶层 throw —— billing 页面会被 next build 收集页面数据时加载，
// 而构建期 NODE_ENV=production 且没有 env，顶层 throw 会把构建打挂。
// 推迟到调用点后：构建不受影响，生产上第一次下单就炸 —— 依旧 fail-fast。

let cached: PayProvider | null = null;

export type WxPayEnv = {
  appid: string;
  mchid: string;
  serialNo: string;
  privateKeyPem: string;
  apiV3Key: string;
  publicKeyPem: string;
  publicKeyId: string;
  notifyUrl: string;
};

const REQUIRED: Record<keyof WxPayEnv, string> = {
  appid: 'BEACON_WXPAY_APPID',
  mchid: 'BEACON_WXPAY_MCHID',
  serialNo: 'BEACON_WXPAY_SERIAL_NO',
  privateKeyPem: 'BEACON_WXPAY_PRIVATE_KEY',
  apiV3Key: 'BEACON_WXPAY_APIV3_KEY',
  publicKeyPem: 'BEACON_WXPAY_PUBLIC_KEY',
  publicKeyId: 'BEACON_WXPAY_PUBLIC_KEY_ID',
  notifyUrl: 'BEACON_WXPAY_NOTIFY_URL',
};

/** 读齐微信支付 env 并做格式校验。配置错要在第一次调用就炸，不能等用户付了钱才发现。 */
export function readWxPayEnv(): WxPayEnv {
  const got = Object.fromEntries(
    Object.entries(REQUIRED).map(([k, envName]) => [k, process.env[envName]?.trim() ?? '']),
  ) as Record<keyof WxPayEnv, string>;

  const missing = (Object.keys(REQUIRED) as (keyof WxPayEnv)[]).filter((k) => !got[k]).map((k) => REQUIRED[k]);
  if (missing.length) {
    throw new Error(`BEACON_PAY_VENDOR=wxpay 但缺少必需环境变量：${missing.join('、')}`);
  }

  // APIv3 密钥必须 32 字节，否则回调解密时才炸 —— 那时候钱已经收了
  if (Buffer.from(got.apiV3Key, 'utf8').length !== 32) {
    throw new Error(`${REQUIRED.apiV3Key} 必须是 32 个字符（APIv3 密钥），当前 ${got.apiV3Key.length} 个`);
  }
  // 微信支付公钥 ID 固定 PUB_KEY_ID_ 前缀。填成平台证书序列号是最容易犯的错，直接拦掉。
  if (!got.publicKeyId.startsWith('PUB_KEY_ID_')) {
    throw new Error(
      `${REQUIRED.publicKeyId} 必须以 PUB_KEY_ID_ 开头（微信支付公钥 ID）。\n` +
        '若你拿到的是 40 位十六进制串，那是**平台证书序列号**，不是公钥 ID —— 本实现只支持公钥模式。',
    );
  }
  // notify_url 的三条硬约束（官方文档明确），配错了微信直接不回调，排查起来极痛苦
  if (!got.notifyUrl.startsWith('https://')) {
    throw new Error(`${REQUIRED.notifyUrl} 必须是 https:// 开头的完整全路径`);
  }
  if (got.notifyUrl.includes('?')) {
    throw new Error(`${REQUIRED.notifyUrl} 不能带 query 参数（微信硬约束）`);
  }
  if (/localhost|127\.0\.0\.1|(^|\/\/)(10|192\.168)\./.test(got.notifyUrl)) {
    throw new Error(`${REQUIRED.notifyUrl} 不能是 localhost / 内网地址，必须外网可达`);
  }
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(got.privateKeyPem)) {
    throw new Error(`${REQUIRED.privateKeyPem} 必须是 apiclient_key.pem 的完整 PEM 全文（含 BEGIN/END 行）`);
  }
  if (!/-----BEGIN PUBLIC KEY-----/.test(got.publicKeyPem)) {
    throw new Error(`${REQUIRED.publicKeyPem} 必须是微信支付公钥的完整 PEM 全文（含 BEGIN/END 行）`);
  }
  return got;
}

export function getPayProvider(): PayProvider {
  if (cached) return cached;
  const vendor = process.env.BEACON_PAY_VENDOR?.trim();

  // 未配置 vendor（含空串）
  if (!vendor) {
    // 生产态：绝不静默回退 Mock。回退等于开了一条无声的免费升档通道。宁可炸掉，不可将就。
    if (isProd()) {
      throw new Error(
        '[beacon/pay] 生产环境安全阻塞：未配置 BEACON_PAY_VENDOR。\n' +
          '生产环境必须配置真实支付通道 —— 回退 Mock 通道会让任何人点一下「模拟支付成功」就升到付费档，\n' +
          '等同于免费发放套餐。\n' +
          '请设置 BEACON_PAY_VENDOR=wxpay 并配齐 BEACON_WXPAY_* 系列变量（见 .env.production.example §13）。\n' +
          '（本地开发请勿设置 NODE_ENV=production / BEACON_ENV=prod。）',
      );
    }
    // dev 态零基础设施可跑：无任何凭证也能看完整 UI、跑通全流程
    cached = new MockPayProvider();
    return cached;
  }

  if (vendor !== 'wxpay') {
    throw new Error(`BEACON_PAY_VENDOR=${vendor} 不支持，当前仅支持 wxpay（留空则使用 dev 态 Mock 通道）`);
  }

  const env = readWxPayEnv();
  cached = new WxPayNativeProvider({
    appid: env.appid,
    mchid: env.mchid,
    serialNo: env.serialNo,
    privateKeyPem: env.privateKeyPem,
    notifyUrl: env.notifyUrl,
  });
  return cached;
}

/** 支付功能是否已配置成真实通道（UI 用来提示「当前是模拟通道」）。 */
export function payVendorConfigured(): boolean {
  return process.env.BEACON_PAY_VENDOR?.trim() === 'wxpay';
}

/** 单测用：清掉工厂缓存，让 vi.stubEnv 能生效。 */
export function __resetPayProviderCache(): void {
  cached = null;
}
