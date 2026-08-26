import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getPayProvider, readWxPayEnv, payVendorConfigured, __resetPayProviderCache } from '@/lib/pay/provider';
import { MockPayProvider } from '@/lib/pay/mock';

// 🔒 这个文件守的是一条不变式：**生产态永远不会是 Mock 支付通道**。
// Mock 通道在生产可达 = 点一下「模拟支付成功」就升团队版 = 免费升档。
// 这与「Mock 短信通道 = 任意账号接管」是同一个结构的洞（那次的根因是
// 「是否 Mock」被当成了「是否 dev」的开关，而生产模板默认回退 Mock）。

const PRIV = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUB = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();

function stubAll(over: Record<string, string> = {}) {
  const base: Record<string, string> = {
    BEACON_PAY_VENDOR: 'wxpay',
    BEACON_WXPAY_APPID: 'wxd678efh567hg6787',
    BEACON_WXPAY_MCHID: ['1900', '007291'].join(''),
    BEACON_WXPAY_SERIAL_NO: '408B07E79B8269FEC3D5D3E6AB8ED163A6A380DB',
    BEACON_WXPAY_PRIVATE_KEY: PRIV,
    BEACON_WXPAY_APIV3_KEY: 'k'.repeat(32),
    BEACON_WXPAY_PUBLIC_KEY: PUB,
    BEACON_WXPAY_PUBLIC_KEY_ID: 'PUB_KEY_ID_0000000000000024101100397200000006',
    BEACON_WXPAY_NOTIFY_URL: 'https://beacon.example.com/api/pay/notify',
    ...over,
  };
  for (const [k, v] of Object.entries(base)) vi.stubEnv(k, v);
}

beforeEach(() => {
  vi.unstubAllEnvs();
  __resetPayProviderCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  __resetPayProviderCache();
});

describe('pay/provider · 生产态绝不回退 Mock（免费升档防线）', () => {
  it('🔒 生产态 + 未配 vendor → **throw**，不是回退 Mock', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => getPayProvider()).toThrow(/生产环境安全阻塞/);
  });

  it('🔒 BEACON_ENV=prod 也算生产态（判定口径与 lib/env.ts 一致，不能漏一半条件）', () => {
    vi.stubEnv('BEACON_ENV', 'prod');
    expect(() => getPayProvider()).toThrow(/生产环境安全阻塞/);
  });

  it('🔒 报错文案点明后果与出路（不是一句没头没脑的 missing env）', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => getPayProvider()).toThrow(/免费升档|免费发放套餐/);
    expect(() => getPayProvider()).toThrow(/BEACON_PAY_VENDOR=wxpay/);
  });

  it('🔒 生产态直接 new MockPayProvider() 也炸（纵深防御：不指望上游永远不写错）', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => new MockPayProvider()).toThrow(/免费升档/);
  });

  it('🔒 生产态 + 配了 vendor 但缺凭证 → throw（不会悄悄降级）', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BEACON_PAY_VENDOR', 'wxpay');
    expect(() => getPayProvider()).toThrow(/缺少必需环境变量/);
  });

  it('🔒 生产态配齐凭证 → 拿到的是真实通道且 mocked=false', () => {
    vi.stubEnv('NODE_ENV', 'production');
    stubAll();
    const p = getPayProvider();
    expect(p.mocked).toBe(false);
    expect(p.name).toBe('wxpay-native');
  });

  it('dev 态未配 vendor → Mock 通道（零基础设施可跑，这条是铁律）', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const p = getPayProvider();
    expect(p.mocked).toBe(true);
    expect(p.name).toBe('mock-pay');
  });

  it('未知 vendor → throw（不静默回退）', () => {
    vi.stubEnv('BEACON_PAY_VENDOR', 'alipay');
    expect(() => getPayProvider()).toThrow(/不支持/);
  });

  it('payVendorConfigured 只认真实通道', () => {
    expect(payVendorConfigured()).toBe(false);
    vi.stubEnv('BEACON_PAY_VENDOR', 'wxpay');
    expect(payVendorConfigured()).toBe(true);
  });

  it('懒校验：模块导入本身不 throw（否则 next build 收集页面数据时会被打挂）', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(import('@/lib/pay/provider')).resolves.toBeTruthy();
  });
});

describe('pay/provider · 凭证格式校验（配错要现在炸，不能等用户付了钱才发现）', () => {
  it('缺哪个变量就报哪个', () => {
    stubAll({ BEACON_WXPAY_MCHID: '' });
    expect(() => readWxPayEnv()).toThrow(/BEACON_WXPAY_MCHID/);
  });

  it('🔒 APIv3 密钥不是 32 字节 → 拦（否则回调解密时才炸，那时钱已经收了）', () => {
    stubAll({ BEACON_WXPAY_APIV3_KEY: 'short' });
    expect(() => readWxPayEnv()).toThrow(/32 个字符/);
  });

  it('🔒 公钥 ID 填成了平台证书序列号 → 拦（最容易犯的错）', () => {
    stubAll({ BEACON_WXPAY_PUBLIC_KEY_ID: '408B07E79B8269FEC3D5D3E6AB8ED163A6A380DB' });
    expect(() => readWxPayEnv()).toThrow(/PUB_KEY_ID_/);
    expect(() => readWxPayEnv()).toThrow(/平台证书序列号/); // 文案要点破他填错了什么
  });

  it('notify_url 的三条硬约束', () => {
    stubAll({ BEACON_WXPAY_NOTIFY_URL: 'http://beacon.example.com/api/pay/notify' });
    expect(() => readWxPayEnv()).toThrow(/https/);
    stubAll({ BEACON_WXPAY_NOTIFY_URL: 'https://beacon.example.com/api/pay/notify?x=1' });
    expect(() => readWxPayEnv()).toThrow(/query/);
    stubAll({ BEACON_WXPAY_NOTIFY_URL: 'https://localhost:3000/api/pay/notify' });
    expect(() => readWxPayEnv()).toThrow(/内网/);
    stubAll({ BEACON_WXPAY_NOTIFY_URL: 'https://192.168.1.5/api/pay/notify' });
    expect(() => readWxPayEnv()).toThrow(/内网/);
  });

  it('私钥/公钥必须是 PEM 全文（只贴了 base64 正文是常见错误）', () => {
    stubAll({ BEACON_WXPAY_PRIVATE_KEY: 'MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSi' });
    expect(() => readWxPayEnv()).toThrow(/PEM 全文/);
    stubAll({ BEACON_WXPAY_PUBLIC_KEY: 'not a pem' });
    expect(() => readWxPayEnv()).toThrow(/PEM 全文/);
  });

  it('配齐 → 通过', () => {
    stubAll();
    const e = readWxPayEnv();
    expect(e.mchid).toBe(['1900', '007291'].join(''));
    expect(e.publicKeyId).toMatch(/^PUB_KEY_ID_/);
  });
});
