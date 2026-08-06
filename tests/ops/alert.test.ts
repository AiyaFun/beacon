import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { allowOpsAlert, providerOfWebhook, payloadsFor, opsAlertConfigured, resetOpsAlertState, sendOpsAlert } from '@/lib/ops/alert';

// 运维告警是「监控腿」，它自己不能把主流程或群聊搞坏：
// 崩溃循环 → 冷却/配额挡住；webhook 挂了 → 不许抛。

describe('运维告警出口', () => {
  const saved = process.env.BEACON_OPS_WEBHOOK;
  beforeEach(() => {
    resetOpsAlertState();
    delete process.env.BEACON_OPS_WEBHOOK;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.BEACON_OPS_WEBHOOK;
    else process.env.BEACON_OPS_WEBHOOK = saved;
    vi.unstubAllGlobals();
    resetOpsAlertState();
  });

  it('按域名认服务商，认不出标 unknown', () => {
    expect(providerOfWebhook('https://open.feishu.cn/open-apis/bot/v2/hook/x')).toBe('feishu');
    expect(providerOfWebhook('https://oapi.dingtalk.com/robot/send?access_token=x')).toBe('dingtalk');
    expect(providerOfWebhook('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x')).toBe('wecom');
    expect(providerOfWebhook('https://hooks.slack.com/services/x')).toBe('slack');
    expect(providerOfWebhook('https://example.com/hook')).toBe('unknown');
  });

  it('认出来就发一种形状，认不出就两种都发（收得到哪条算哪条）', () => {
    expect(payloadsFor('feishu', 'hi')).toEqual([{ msg_type: 'text', content: { text: 'hi' } }]);
    expect(payloadsFor('dingtalk', 'hi')).toEqual([{ msgtype: 'text', text: { content: 'hi' } }]);
    expect(payloadsFor('unknown', 'hi')).toHaveLength(2);
  });

  it('没配 webhook = 未启用（如实返回，不假装发了）', async () => {
    expect(opsAlertConfigured()).toBe(false);
    const r = await sendOpsAlert({ level: 'error', title: 'x', lines: [], fingerprint: 'f' });
    expect(r).toEqual({ sent: false, reason: 'not_configured' });
  });

  it('同一指纹 10 分钟内只放行一次（崩溃循环不刷屏）', () => {
    const t0 = 1_000_000;
    expect(allowOpsAlert('boom', t0)).toBe(true);
    expect(allowOpsAlert('boom', t0 + 60_000)).toBe(false);
    expect(allowOpsAlert('boom', t0 + 10 * 60_000 + 1)).toBe(true);
  });

  it('不同指纹各自独立，但每小时总量封顶 12 条', () => {
    const t0 = 2_000_000;
    let allowed = 0;
    for (let i = 0; i < 20; i++) if (allowOpsAlert(`err-${i}`, t0 + i)) allowed++;
    expect(allowed).toBe(12);
    // 跨过整点窗口后重新放行
    expect(allowOpsAlert('err-99', t0 + 3600_001)).toBe(true);
  });

  it('webhook 打不通也不抛，只如实回 sent:false', async () => {
    process.env.BEACON_OPS_WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/x';
    vi.stubGlobal('fetch', async () => {
      throw new Error('网络不通');
    });
    const r = await sendOpsAlert({ level: 'error', title: '服务端异常', lines: ['x'], fingerprint: 'net' });
    expect(r.sent).toBe(false);
    expect(r.reason).toBeTruthy();
  });
});
