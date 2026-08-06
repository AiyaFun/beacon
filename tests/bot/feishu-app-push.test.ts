import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendFeishuApp, feishuTenantAccessToken, feishuListBotChats } from '@/lib/bot/feishu';
import type { PushMessage } from '@/lib/bot/types';

// 自建应用主动推送链路：取 token → 列群 → 逐群发。
// 这条链路踩过的坑：缺 im:chat:readonly 权限时飞书报 99991672，
// 老实现把它吞成空数组 → 误报「机器人未加入任何群聊」，让人一直白折腾拉机器人进群。
// 下面几条把「错误必须如实透出」钉死。

const MSG: PushMessage = { kind: 'text', text: 'hi' };

function mockFetch(handler: (url: string) => { ok?: boolean; status?: number; body: any }) {
  vi.stubGlobal('fetch', vi.fn(async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    const { ok = true, status = 200, body } = handler(url);
    return { ok, status, json: async () => body } as any;
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('feishuTenantAccessToken · 错误如实返回', () => {
  it('成功 → 返回 token', async () => {
    mockFetch(() => ({ body: { code: 0, tenant_access_token: 't-abc' } }));
    expect(await feishuTenantAccessToken('cli_x', 'sec')).toEqual({ token: 't-abc' });
  });

  it('凭据错 → 带回飞书原文与错误码（不是笼统「获取失败」）', async () => {
    mockFetch(() => ({ body: { code: 10003, msg: 'app not found' } }));
    const r = await feishuTenantAccessToken('cli_bad', 'sec');
    expect(r.token).toBeNull();
    expect(r.error).toContain('app not found');
    expect(r.error).toContain('10003');
  });
});

describe('feishuListBotChats · 权限错误不再被吞成空列表', () => {
  it('成功 → 返回 chat_id 列表', async () => {
    mockFetch(() => ({ body: { code: 0, data: { items: [{ chat_id: 'oc_1' }, { chat_id: 'oc_2' }] } } }));
    expect(await feishuListBotChats('t')).toEqual({ chatIds: ['oc_1', 'oc_2'] });
  });

  it('缺权限 99991672 → 返回 error 而不是静默空数组', async () => {
    mockFetch(() => ({ body: { code: 99991672, msg: 'Access denied' } }));
    const r = await feishuListBotChats('t');
    expect(r.chatIds).toEqual([]);
    expect(r.error).toContain('99991672');
  });

  it('真的没进群 → 空列表且无 error（与缺权限可区分）', async () => {
    mockFetch(() => ({ body: { code: 0, data: { items: [] } } }));
    expect(await feishuListBotChats('t')).toEqual({ chatIds: [] });
  });
});

describe('sendFeishuApp · 失败原因必须可执行', () => {
  it('缺 im:chat:readonly → 指向「权限管理」开通群信息权限，不再谎报没进群', async () => {
    mockFetch((url) => {
      if (url.includes('tenant_access_token')) return { body: { code: 0, tenant_access_token: 't' } };
      return { body: { code: 99991672, msg: 'Access denied' } };
    });
    const r = await sendFeishuApp('cli_x', 'sec', MSG);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('im:chat:readonly');
    expect(r.error).not.toContain('未加入任何群聊'); // 关键：不能再误导
  });

  it('token 取不到 → 错误里带飞书原文', async () => {
    mockFetch(() => ({ body: { code: 10003, msg: 'invalid app_secret' } }));
    const r = await sendFeishuApp('cli_x', 'bad', MSG);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('invalid app_secret');
  });

  it('权限正常但确实没进群 → 才提示去拉机器人进群', async () => {
    mockFetch((url) => {
      if (url.includes('tenant_access_token')) return { body: { code: 0, tenant_access_token: 't' } };
      return { body: { code: 0, data: { items: [] } } };
    });
    const r = await sendFeishuApp('cli_x', 'sec', MSG);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('未加入任何群聊');
  });

  it('一切正常 → 逐群发送成功', async () => {
    mockFetch((url) => {
      if (url.includes('tenant_access_token')) return { body: { code: 0, tenant_access_token: 't' } };
      if (url.includes('/im/v1/chats')) return { body: { code: 0, data: { items: [{ chat_id: 'oc_1' }] } } };
      return { body: { code: 0 } }; // 发消息
    });
    expect(await sendFeishuApp('cli_x', 'sec', MSG)).toEqual({ ok: true });
  });

  it('多群时部分成功即算成功（单群失败不拖垮整体）', async () => {
    let sendCount = 0;
    mockFetch((url) => {
      if (url.includes('tenant_access_token')) return { body: { code: 0, tenant_access_token: 't' } };
      if (url.includes('/im/v1/chats')) return { body: { code: 0, data: { items: [{ chat_id: 'oc_1' }, { chat_id: 'oc_2' }] } } };
      sendCount++;
      return sendCount === 1 ? { body: { code: 230001, msg: 'bot not in chat' } } : { body: { code: 0 } };
    });
    expect(await sendFeishuApp('cli_x', 'sec', MSG)).toEqual({ ok: true });
  });
});
