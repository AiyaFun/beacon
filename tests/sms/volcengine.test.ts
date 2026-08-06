import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VolcengineSmsProvider } from '@/lib/sms/volcengine';

// 火山短信真实通道的**响应处理**：错误码映射、成败判定、重试策略。
// fetch 全程被 mock —— 这里测的是我们对火山响应的解读，不是火山服务本身。

const cfg = {
  accessKeyId: 'AK-test',
  secretAccessKey: 'SK-test',
  smsAccount: '1b6d4896',
  sign: '烽火台',
  templateId: 'S1T_test',
  paramName: 'code',
  region: 'cn-north-1',
};

const provider = () => new VolcengineSmsProvider(cfg);

// 火山的坑：失败时 HTTP 依然 200，Result.MessageID 依然有值，
// 唯一可靠判据是 ResponseMetadata.Error.Code
const errRes = (code: string, message = '原始英文消息') =>
  new Response(
    JSON.stringify({
      ResponseMetadata: { RequestId: 'req-1', Error: { Code: code, Message: message } },
      Result: { MessageID: ['msg-still-present'] },
    }),
    { status: 200 },
  );

const okRes = () =>
  new Response(JSON.stringify({ ResponseMetadata: { RequestId: 'req-1' }, Result: { MessageID: ['msg-1'] } }), {
    status: 200,
  });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers({ shouldAdvanceTime: true }); // 让退避 sleep 不真的等
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('火山短信 · 成败判定', () => {
  it('无 Error.Code → 成功', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(okRes()));
    await expect(provider().sendCode('13800138000', '123456')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('HTTP 200 + MessageID 有值 + Error.Code 存在 → 正确判为失败', async () => {
    // 照着 HTTP 状态码或 MessageID 判成败会把失败当成功——这条锁住正确判据
    fetchMock.mockImplementation(() => Promise.resolve(errRes('RE:0004')));
    await expect(provider().sendCode('13800138000', '123456')).rejects.toThrow(/RE:0004/);
  });
});

describe('火山短信 · 错误码 → 中文可诊断信息', () => {
  const CASES: Array<[string, RegExp]> = [
    ['RE:0000', /鉴权失败|AK\/SK/],
    ['RE:0001', /未开通短信服务/],
    ['RE:0002', /已被关停/],
    ['RE:0003', /消息组ID|消息组 ID|不是消息组名称/],
    ['RE:0004', /签名|未过审/],
    ['RE:0005', /模板|未过审/],
    ['RE:0006', /手机号格式/],
    ['RE:0007', /白名单/],
    ['RE:0009', /参数错误/],
    ['RE:0010', /欠费/],
    ['RE:0011', /地区/],
    ['RE:0012', /短信类型/],
    ['RE:0013', /阈值|上限/],
  ];

  for (const [code, re] of CASES) {
    it(`${code} → 中文提示命中 ${re}`, async () => {
      fetchMock.mockImplementation(() => Promise.resolve(errRes(code)));
      await expect(provider().sendCode('13800138000', '123456')).rejects.toThrow(re);
    });
  }

  it('RE:0007 给出可照做的排查方向（换机器/扩容后需重新加白）', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(errRes('RE:0007')));
    await expect(provider().sendCode('13800138000', '123456')).rejects.toThrow(
      /服务器 IP 未加入火山短信白名单（换机器\/扩容后需重新加白）/,
    );
  });

  it('错误信息里带上原始错误码，便于对着文档查', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(errRes('RE:0004')));
    await expect(provider().sendCode('13800138000', '123456')).rejects.toThrow(/\[RE:0004\]/);
  });

  it('default 兜底：未知错误码回落到火山原始 Message，不吞掉信息', async () => {
    // 文档明说存在未列出的「公共错误码」，映射表不能写成穷举
    fetchMock.mockImplementation(() => Promise.resolve(errRes('SomeUnknownPublicCode', 'Invalid parameter foo')));
    await expect(provider().sendCode('13800138000', '123456')).rejects.toThrow(/Invalid parameter foo/);
  });

  it('未知错误码且无 Message → 兜底文案指向公共错误码文档', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ ResponseMetadata: { Error: { Code: 'Weird' } } }), { status: 200 })),
    );
    await expect(provider().sendCode('13800138000', '123456')).rejects.toThrow(/未知错误码|公共错误码/);
  });
});

describe('火山短信 · 重试策略', () => {
  it('RE:0500 可重试：共发 3 次后放弃', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(errRes('RE:0500')));
    // 先挂上 rejects 断言再推时钟：否则退避期间 promise 已 reject 而无 handler，
    // 会冒出 unhandled rejection（用例仍绿，但 CI 日志被污染）。
    const assertion = expect(provider().sendCode('13800138000', '123456')).rejects.toThrow(/RE:0500/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('RE:0013 可重试（超阈值）', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(errRes('RE:0013')));
    // 先挂上 rejects 断言再推时钟：否则退避期间 promise 已 reject 而无 handler，
    // 会冒出 unhandled rejection（用例仍绿，但 CI 日志被污染）。
    const assertion = expect(provider().sendCode('13800138000', '123456')).rejects.toThrow(/RE:0013/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('RE:0500 首次失败、第二次成功 → 整体成功', async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve(errRes('RE:0500'))).mockImplementationOnce(() => Promise.resolve(okRes()));
    const assertion = expect(provider().sendCode('13800138000', '123456')).resolves.toBeUndefined();
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('RE:0007 不可重试：只发一次（配置问题重试只浪费配额）', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(errRes('RE:0007')));
    await expect(provider().sendCode('13800138000', '123456')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('未知公共错误码不可重试：只发一次', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(errRes('SomeUnknownCode')));
    await expect(provider().sendCode('13800138000', '123456')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('网络层失败不重试（验证码场景宁可让用户重发，也不冒重复下发/重复计费的风险）', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    await expect(provider().sendCode('13800138000', '123456')).rejects.toThrow(/请求失败.*ECONNRESET/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('返回非 JSON → 明确报错并附带响应片段', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response('<html>502 Bad Gateway</html>', { status: 502 })));
    await expect(provider().sendCode('13800138000', '123456')).rejects.toThrow(/非 JSON.*502/s);
  });
});

describe('火山短信 · 请求构造（契约锁）', () => {
  async function captureRequest() {
    fetchMock.mockImplementation(() => Promise.resolve(okRes()));
    await provider().sendCode('13800138000', '123456');
    const [url, init] = fetchMock.mock.calls[0];
    return { url: String(url), init: init as RequestInit, body: JSON.parse(String(init.body)) };
  }

  it('Action/Version 走 query string，不在 body 里', async () => {
    const { url, body } = await captureRequest();
    expect(url).toContain('Action=SendSms');
    expect(url).toContain('Version=2020-01-01');
    expect(body.Action).toBeUndefined();
  });

  it('打到正确的 host', async () => {
    expect((await captureRequest()).url.startsWith('https://sms.volcengineapi.com/')).toBe(true);
  });

  it('TemplateID 的 ID 大写（写成 TemplateId 会被后端拒）', async () => {
    const { body } = await captureRequest();
    expect(body).toHaveProperty('TemplateID', 'S1T_test');
    expect(body).not.toHaveProperty('TemplateId');
  });

  it('TemplateParam 是被转义的嵌套 JSON 字符串，不是对象', async () => {
    const { body } = await captureRequest();
    expect(typeof body.TemplateParam).toBe('string');
    expect(JSON.parse(body.TemplateParam)).toEqual({ code: '123456' });
  });

  it('paramName 可配置（模板变量名 code vs content 是最易错的一个）', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(okRes()));
    await new VolcengineSmsProvider({ ...cfg, paramName: 'content' }).sendCode('13800138000', '123456');
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(JSON.parse(body.TemplateParam)).toEqual({ content: '123456' });
  });

  it('字段名一律 PascalCase 且不传 UserExtCode（文档零记载，语义未知）', async () => {
    const { body } = await captureRequest();
    expect(Object.keys(body).sort()).toEqual(['PhoneNumbers', 'Sign', 'SmsAccount', 'Tag', 'TemplateID', 'TemplateParam']);
  });

  it('X-Content-Sha256 与实际发出的 body 一致（签什么发什么）', async () => {
    const { init, body: _ } = await captureRequest();
    const headers = init.headers as Record<string, string>;
    const crypto = await import('node:crypto');
    const actual = crypto.createHash('sha256').update(String(init.body), 'utf8').digest('hex');
    expect(headers['X-Content-Sha256']).toBe(actual);
  });

  it('Content-Type 显式 application/json，不带 charset（带了就与签名不符）', async () => {
    const headers = (await captureRequest()).init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('Authorization 走 Go SDK 四头路线', async () => {
    const headers = (await captureRequest()).init.headers as Record<string, string>;
    expect(headers.Authorization).toContain('SignedHeaders=content-type;host;x-content-sha256;x-date');
    expect(headers.Authorization).toContain('/volcSMS/request'); // service 大小写敏感
  });

  it('每次发送的 Tag 唯一（回执对账用）', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(okRes()));
    const p = provider();
    await p.sendCode('13800138000', '111111');
    await p.sendCode('13800138000', '222222');
    const tags = fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)).Tag);
    expect(tags[0]).not.toBe(tags[1]);
  });

  it('mocked=false（真实通道不得回显验证码给前端）', () => {
    expect(provider().mocked).toBe(false);
  });
});
