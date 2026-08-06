import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 短信通道工厂。核心不变式：**不配 vendor 就回退 Mock**（dev 零基础设施可跑），
// 配了 vendor 但配不全就 fail-fast（不能等用户点「发验证码」时才炸）。
async function freshProvider() {
  vi.resetModules(); // provider.ts 有模块级 cached，必须重置
  return import('@/lib/sms/provider');
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('短信工厂 · dev 回退 Mock', () => {
  it('未配 BEACON_SMS_VENDOR → Mock 通道（零配置可跑，不得破坏）', async () => {
    const { getSmsProvider } = await freshProvider();
    const p = getSmsProvider();
    expect(p.name).toBe('mock-sms');
    expect(p.mocked).toBe(true);
  });

  it('BEACON_SMS_VENDOR 为空串 → 同样回退 Mock', async () => {
    vi.stubEnv('BEACON_SMS_VENDOR', '');
    const { getSmsProvider } = await freshProvider();
    expect(getSmsProvider().mocked).toBe(true);
  });

  it('Mock 通道发码不抛错', async () => {
    const { getSmsProvider } = await freshProvider();
    await expect(getSmsProvider().sendCode('13800138000', '123456')).resolves.toBeUndefined();
  });

  it('工厂结果被缓存：同一进程内多次调用返回同一实例', async () => {
    const { getSmsProvider } = await freshProvider();
    expect(getSmsProvider()).toBe(getSmsProvider());
  });
});

describe('短信工厂 · 配置错误 fail-fast', () => {
  it('不支持的 vendor → throw 且提示留空可回退', async () => {
    vi.stubEnv('BEACON_SMS_VENDOR', 'aliyun'); // 阿里云分支已删除
    const { getSmsProvider } = await freshProvider();
    expect(() => getSmsProvider()).toThrow(/不支持|留空/);
  });

  it('腾讯云同样不支持', async () => {
    vi.stubEnv('BEACON_SMS_VENDOR', 'tencent');
    const { getSmsProvider } = await freshProvider();
    expect(() => getSmsProvider()).toThrow(/不支持/);
  });

  const REQUIRED = ['BEACON_VOLC_SMS_AK', 'BEACON_VOLC_SMS_SK', 'BEACON_VOLC_SMS_SIGN'];
  for (const missing of REQUIRED) {
    it(`vendor=volcengine 但缺 ${missing} → throw 且点名缺哪个`, async () => {
      vi.stubEnv('BEACON_SMS_VENDOR', 'volcengine');
      for (const k of REQUIRED) vi.stubEnv(k, k === missing ? '' : 'v');
      const { getSmsProvider } = await freshProvider();
      expect(() => getSmsProvider()).toThrow(new RegExp(missing));
    });
  }

  it('三个都缺 → 错误信息一次列全（不用挤牙膏式排查）', async () => {
    vi.stubEnv('BEACON_SMS_VENDOR', 'volcengine');
    const { getSmsProvider } = await freshProvider();
    const run = () => getSmsProvider();
    for (const k of REQUIRED) expect(run).toThrow(new RegExp(k));
  });
});

describe('短信工厂 · 生产通道装配', () => {
  beforeEach(() => {
    vi.stubEnv('BEACON_SMS_VENDOR', 'volcengine');
    vi.stubEnv('BEACON_VOLC_SMS_AK', 'AK-x');
    vi.stubEnv('BEACON_VOLC_SMS_SK', 'SK-x');
    vi.stubEnv('BEACON_VOLC_SMS_SIGN', '烽火台');
  });

  it('三个必填齐全 → 得到火山真实通道且 mocked=false', async () => {
    const { getSmsProvider } = await freshProvider();
    const p = getSmsProvider();
    expect(p.name).toBe('volcengine-sms');
    expect(p.mocked).toBe(false);
  });

  it('可选项缺省时用内置默认（消息组/模板/变量名/region）', async () => {
    const { getSmsProvider } = await freshProvider();
    expect(() => getSmsProvider()).not.toThrow();
  });

  it('mocked=false 意味着 devCode 不会回显 —— 生产不得把验证码给前端', async () => {
    const { getSmsProvider } = await freshProvider();
    expect(getSmsProvider().mocked).toBe(false);
  });
});
