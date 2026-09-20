import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { dmImage, telegramTokenOf, MAX_BOT_IMAGE_BYTES } from '@/lib/bot/image';

// 机器人私聊发图（2026-09-17）。四家的上传接口各不相同，这一组钉的是：
//   · 凭据不齐时**如实说发不了**（unsupported），让上层降级成文字，而不是当成一次网络失败去重试；
//   · 各家真的走了自己那条「先上传素材、再发消息」的两步路；
//   · 体积闸在最前面（企微 2MB 是最小的那个，取它当统一口径）。
//
// 真机没法在测试里验（要真的企业应用凭据），所以这里验的是**请求形状**：
// 哪个地址、带没带 token、两步顺序对不对。形状错了真机一定错，形状对了真机才有的谈。

const calls: { url: string; method?: string }[] = [];

function mockFetch(responder: (url: string) => unknown) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method });
    return { ok: true, status: 200, json: async () => responder(url) } as unknown as Response;
  });
}

const IMG = { data: Buffer.from('jpeg-bytes'), mime: 'image/jpeg' };

beforeEach(() => { calls.length = 0; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('凭据不齐 → 如实说发不了（unsupported）', () => {
  it('飞书没配自建应用', async () => {
    const r = await dmImage({ provider: 'feishu', secrets: {}, inboundKey: null, webhookUrl: 'https://open.feishu.cn/hook/x', userId: 'ou_a', image: IMG, caption: 'c' });
    expect(r.ok).toBe(false);
    expect(r.unsupported).toBe(true);
    expect(r.error).toMatch(/自建应用/);
  });

  it('企微缺 CorpID / AgentID', async () => {
    const r = await dmImage({ provider: 'wecom', secrets: { appSecret: 's' }, inboundKey: null, webhookUrl: null, userId: 'u1', image: IMG, caption: 'c' });
    expect(r.unsupported).toBe(true);
  });

  it('钉钉缺 AgentId', async () => {
    const r = await dmImage({ provider: 'dingtalk', secrets: { appSecret: 's' }, inboundKey: 'ak', webhookUrl: null, userId: 'u1', image: IMG, caption: 'c' });
    expect(r.unsupported).toBe(true);
  });

  it('Telegram 的 webhook 里读不出 bot token', async () => {
    const r = await dmImage({ provider: 'telegram', secrets: {}, inboundKey: null, webhookUrl: 'https://example.com/hook', userId: '123', image: IMG, caption: 'c' });
    expect(r.unsupported).toBe(true);
  });

  it('不认识的渠道（slack / 微信客服…）也如实说，不装作发过了', async () => {
    const r = await dmImage({ provider: 'slack', secrets: {}, inboundKey: null, webhookUrl: null, userId: 'u', image: IMG, caption: 'c' });
    expect(r.unsupported).toBe(true);
  });

  it('不知道发给谁 → 不发', async () => {
    const r = await dmImage({ provider: 'feishu', secrets: { appSecret: 's' }, inboundKey: 'cli', webhookUrl: null, userId: '', image: IMG, caption: 'c' });
    expect(r.unsupported).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('🔒 体积闸在最前面：超了一次网络请求都不发', async () => {
    const big = { data: Buffer.alloc(MAX_BOT_IMAGE_BYTES + 1), mime: 'image/jpeg' };
    const r = await dmImage({ provider: 'feishu', secrets: { appSecret: 's' }, inboundKey: 'cli', webhookUrl: null, userId: 'ou_a', image: big, caption: 'c' });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('各家走的是自己那条两步路', () => {
  it('飞书：拿 token → 传 image_key → 发给 open_id（不是群）', async () => {
    vi.stubGlobal('fetch', mockFetch((url) => {
      if (url.includes('tenant_access_token')) return { code: 0, tenant_access_token: 'tk', expire: 7200 };
      if (url.includes('/im/v1/images')) return { code: 0, data: { image_key: 'img_k' } };
      return { code: 0, data: { message_id: 'om_1' } };
    }));
    const r = await dmImage({ provider: 'feishu', secrets: { appSecret: 's' }, inboundKey: 'cli_x', webhookUrl: null, userId: 'ou_a', image: IMG, caption: '扫这个码' });
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.url.includes('/im/v1/images'))).toBe(true);
    expect(calls.some((c) => c.url.includes('receive_id_type=open_id'))).toBe(true);
    expect(calls.some((c) => c.url.includes('receive_id_type=chat_id'))).toBe(false); // 🔒 不进群
  });

  it('企微：media/upload(type=image) → message/send 给 touser', async () => {
    vi.stubGlobal('fetch', mockFetch((url) => {
      if (url.includes('gettoken')) return { errcode: 0, access_token: 'tk', expires_in: 7200 };
      if (url.includes('media/upload')) return { errcode: 0, media_id: 'mid' };
      return { errcode: 0 };
    }));
    const r = await dmImage({ provider: 'wecom', secrets: { appSecret: 's', corpId: 'c', agentId: '1000002' }, inboundKey: null, webhookUrl: null, userId: 'zhangsan', image: IMG, caption: 'c' });
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.url.includes('media/upload') && c.url.includes('type=image'))).toBe(true);
    expect(calls.some((c) => c.url.includes('message/send'))).toBe(true);
  });

  it('钉钉：media/upload → 工作通知 asyncsend_v2', async () => {
    vi.stubGlobal('fetch', mockFetch((url) => {
      if (url.includes('gettoken')) return { errcode: 0, access_token: 'tk', expires_in: 7200 };
      if (url.includes('media/upload')) return { errcode: 0, media_id: 'mid' };
      return { errcode: 0 };
    }));
    const r = await dmImage({ provider: 'dingtalk', secrets: { appSecret: 's', agentId: '77' }, inboundKey: 'ak', webhookUrl: null, userId: 'u1', image: IMG, caption: 'c' });
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.url.includes('media/upload'))).toBe(true);
    expect(calls.some((c) => c.url.includes('asyncsend_v2'))).toBe(true);
  });

  it('Telegram：一步 sendPhoto', async () => {
    vi.stubGlobal('fetch', mockFetch(() => ({ ok: true })));
    const r = await dmImage({ provider: 'telegram', secrets: {}, inboundKey: null, webhookUrl: 'https://api.telegram.org/bot123:ABC/sendMessage', userId: '4242', image: IMG, caption: 'c' });
    expect(r.ok).toBe(true);
    expect(calls[0].url).toContain('/bot123:ABC/sendPhoto');
  });

  it('上传失败 → 不再发消息，如实报错', async () => {
    vi.stubGlobal('fetch', mockFetch((url) => {
      if (url.includes('tenant_access_token')) return { code: 0, tenant_access_token: 'tk', expire: 7200 };
      return { code: 230001, msg: 'no permission' };
    }));
    const r = await dmImage({ provider: 'feishu', secrets: { appSecret: 's' }, inboundKey: 'cli_x', webhookUrl: null, userId: 'ou_a', image: IMG, caption: 'c' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no permission|上传/);
    expect(calls.some((c) => c.url.includes('/im/v1/messages'))).toBe(false);
  });
});

describe('Telegram token 解析', () => {
  it('从 webhook 地址里取出来；取不到就是 null', () => {
    expect(telegramTokenOf('https://api.telegram.org/bot123:ABC/sendMessage')).toBe('123:ABC');
    expect(telegramTokenOf('https://example.com/x')).toBeNull();
    expect(telegramTokenOf(null)).toBeNull();
  });
});
