import { describe, it, expect, vi, afterEach } from 'vitest';
import { diagnoseBot } from '@/lib/bot/diagnose';

// 体检要能把「出站失败」拆成可区分的几类：凭据错 / 权限没开 / 没进群 / 应用没发版。
// 只报一句聚合错误的话，用户分不清该去后台改哪里——下面把每类的落点钉死。

function mockFetch(handler: (url: string) => any) {
  vi.stubGlobal('fetch', vi.fn(async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    return { ok: true, status: 200, json: async () => handler(url) } as any;
  }));
}

afterEach(() => vi.unstubAllGlobals());

const FEISHU_OK_TOKEN = { code: 0, tenant_access_token: 't' };

describe('diagnoseBot · 飞书自建应用', () => {
  it('凭据错 → 卡在第①步，指向核对 App ID/Secret', async () => {
    mockFetch(() => ({ code: 10003, msg: 'invalid app_secret' }));
    const r = await diagnoseBot('feishu', null, 'cli_x', { appSecret: 'bad' });
    expect(r.passed).toBe(false);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0].ok).toBe(false);
    expect(r.steps[0].detail).toContain('invalid app_secret');
    expect(r.steps[0].fix).toContain('App Secret');
  });

  it('没存 App Secret → 直接指出缺什么，不去打网络', async () => {
    mockFetch(() => ({}));
    const r = await diagnoseBot('feishu', null, 'cli_x', {});
    expect(r.passed).toBe(false);
    expect(r.steps[0].detail).toContain('没有保存 App Secret');
  });

  it('缺群信息权限 → 卡在第②步，指向 im:chat:readonly', async () => {
    mockFetch((url) => (url.includes('tenant_access_token') ? FEISHU_OK_TOKEN : { code: 99991672, msg: 'Access denied' }));
    const r = await diagnoseBot('feishu', null, 'cli_x', { appSecret: 's' });
    expect(r.steps[0].ok).toBe(true);
    expect(r.steps[1].ok).toBe(false);
    expect(r.steps[1].fix).toContain('im:chat:readonly');
  });

  it('权限正常但没进群 → 卡在第③步，指向把机器人拉进群', async () => {
    mockFetch((url) => {
      if (url.includes('tenant_access_token')) return FEISHU_OK_TOKEN;
      return { code: 0, data: { items: [] } };
    });
    const r = await diagnoseBot('feishu', null, 'cli_x', { appSecret: 's' });
    expect(r.steps[1].ok).toBe(true);
    expect(r.steps[2].ok).toBe(false);
    expect(r.steps[2].fix).toContain('添加机器人');
  });

  it('Bot Not Enabled → 卡在第③步，指向开机器人能力+发版+等审核', async () => {
    mockFetch((url) => {
      if (url.includes('tenant_access_token')) return FEISHU_OK_TOKEN;
      if (url.includes('/im/v1/chats')) return { code: 0, data: { items: [{ chat_id: 'oc_1' }] } };
      return { code: 230098, msg: 'Bot Not Enabled' };
    });
    const r = await diagnoseBot('feishu', null, 'cli_x', { appSecret: 's' });
    expect(r.passed).toBe(false);
    expect(r.steps[2].ok).toBe(false);
    expect(r.steps[2].detail).toContain('Bot Not Enabled');
    expect(r.steps[2].fix).toContain('机器人');
    expect(r.steps[2].fix).toContain('审核');
  });

  it('三步全通 → passed=true', async () => {
    mockFetch((url) => {
      if (url.includes('tenant_access_token')) return FEISHU_OK_TOKEN;
      if (url.includes('/im/v1/chats')) return { code: 0, data: { items: [{ chat_id: 'oc_1' }] } };
      return { code: 0 };
    });
    const r = await diagnoseBot('feishu', null, 'cli_x', { appSecret: 's' });
    expect(r.passed).toBe(true);
    expect(r.steps).toHaveLength(3);
    expect(r.steps.every((s) => s.ok)).toBe(true);
  });
});

describe('diagnoseBot · 其它形态', () => {
  it('Webhook 模式 → 只有一步（没有中间环节可卡）', async () => {
    mockFetch(() => ({ code: 0 }));
    const r = await diagnoseBot('feishu', 'https://open.feishu.cn/open-apis/bot/v2/hook/x', null, {});
    expect(r.steps).toHaveLength(1);
    expect(r.passed).toBe(true);
  });

  it('钉钉缺 AgentId → 直接指出缺什么', async () => {
    mockFetch(() => ({}));
    const r = await diagnoseBot('dingtalk', null, 'appkey', { appSecret: 's' });
    expect(r.passed).toBe(false);
    expect(r.steps[0].detail).toContain('AgentId');
  });

  it('企微缺 CorpID → 直接指出缺什么', async () => {
    mockFetch(() => ({}));
    const r = await diagnoseBot('wecom', null, 'ww_1', { appSecret: 's', agentId: '1' });
    expect(r.passed).toBe(false);
    expect(r.steps[0].detail).toContain('CorpID');
  });

  it('什么都没配 → 明确报「两种都没有」', async () => {
    const r = await diagnoseBot('feishu', null, null, {});
    expect(r.passed).toBe(false);
    expect(r.steps[0].detail).toContain('既没有');
  });
});
