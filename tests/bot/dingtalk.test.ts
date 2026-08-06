import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { dingtalkVerifySign, stripDingtalkAtPrefix } from '@/lib/bot/dingtalk';

// 钉钉入站密码学：HMAC-SHA256 签名验证（与官方文档口径对齐）。

describe('dingtalkVerifySign · 机器人回调签名', () => {
  const secret = 'test-app-secret';
  const ts = '1700000000000';

  function makeSign(timestamp: string, appSecret: string): string {
    const str = `${timestamp}\n${appSecret}`;
    return crypto.createHmac('sha256', appSecret).update(str).digest('base64');
  }

  it('正确签名通过', () => {
    const sign = makeSign(ts, secret);
    expect(dingtalkVerifySign(ts, secret, sign)).toBe(true);
  });

  it('同输入确定性', () => {
    const a = makeSign(ts, secret);
    const b = makeSign(ts, secret);
    expect(a).toBe(b);
    expect(dingtalkVerifySign(ts, secret, a)).toBe(true);
  });

  it('timestamp 不同 → 签名不同', () => {
    const a = makeSign('1700000000000', secret);
    const b = makeSign('1700000001000', secret);
    expect(a).not.toBe(b);
  });

  it('密钥不同 → 拒绝', () => {
    const sign = makeSign(ts, secret);
    expect(dingtalkVerifySign(ts, 'wrong-secret', sign)).toBe(false);
  });

  it('空签名 → 拒绝（不抛异常）', () => {
    expect(dingtalkVerifySign(ts, secret, '')).toBe(false);
  });

  it('篡改签名 → 拒绝', () => {
    const sign = makeSign(ts, secret);
    const tampered = Buffer.from(sign, 'base64');
    tampered[0] ^= 0xff;
    expect(dingtalkVerifySign(ts, secret, tampered.toString('base64'))).toBe(false);
  });
});

describe('stripDingtalkAtPrefix · 剥掉 @机器人 前缀', () => {
  it('🔒 「@烽火台 /热点」→ 斜杠命令顶格，才不会被当成选题文本收录', () => {
    expect(stripDingtalkAtPrefix('@烽火台 /热点')).toBe('/热点');
  });

  it('连续 @ 多人也剥干净', () => {
    expect(stripDingtalkAtPrefix('@烽火台 @小明 我这条为什么没火')).toBe('我这条为什么没火');
  });

  it('正文里的 @ 不动（只剥开头）', () => {
    expect(stripDingtalkAtPrefix('@烽火台 帮我看看 @提及 这个用法')).toBe('帮我看看 @提及 这个用法');
  });

  it('没有 @ 前缀时原样返回', () => {
    expect(stripDingtalkAtPrefix('  露营装备测评  ')).toBe('露营装备测评');
  });
});
