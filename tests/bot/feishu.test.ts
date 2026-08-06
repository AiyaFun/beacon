import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  feishuSign,
  feishuVerifySignature,
  feishuDecrypt,
  feishuWebhookBody,
  feishuPassesMentionGate,
} from '@/lib/bot/feishu';

// 飞书出/入站密码学：与官方文档口径逐条对齐（用独立重算做基准，锁死回归）。

describe('feishuSign · 群机器人签名', () => {
  it('与官方口径一致：HmacSHA256(key=`${ts}\\n${secret}`, data="") base64', () => {
    const secret = 'my-secret';
    const ts = 1700000000;
    const expected = crypto.createHmac('sha256', `${ts}\n${secret}`).update('').digest('base64');
    expect(feishuSign(secret, ts)).toBe(expected);
  });
  it('同输入确定性、换密钥即变', () => {
    expect(feishuSign('a', 100)).toBe(feishuSign('a', 100));
    expect(feishuSign('a', 100)).not.toBe(feishuSign('b', 100));
  });
});

describe('feishuVerifySignature · 事件验签', () => {
  const encryptKey = 'enc-key-123';
  const timestamp = '1700000000';
  const nonce = 'abc';
  const rawBody = '{"encrypt":"xxx"}';
  const good = crypto.createHash('sha256').update(timestamp + nonce + encryptKey + rawBody).digest('hex');

  it('正确签名通过', () => {
    expect(feishuVerifySignature({ timestamp, nonce, encryptKey, rawBody, signature: good })).toBe(true);
  });
  it('篡改 body → 拒绝', () => {
    expect(feishuVerifySignature({ timestamp, nonce, encryptKey, rawBody: rawBody + 'x', signature: good })).toBe(false);
  });
  it('空/错签名 → 拒绝（不抛异常）', () => {
    expect(feishuVerifySignature({ timestamp, nonce, encryptKey, rawBody, signature: '' })).toBe(false);
    expect(feishuVerifySignature({ timestamp, nonce, encryptKey, rawBody, signature: 'deadbeef' })).toBe(false);
  });
});

describe('feishuDecrypt · 事件解密', () => {
  // 按官方方案造密文：key=sha256(encryptKey)，iv 前置 16B，AES-256-CBC
  function encrypt(encryptKey: string, plain: string): string {
    const key = crypto.createHash('sha256').update(encryptKey).digest();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, enc]).toString('base64');
  }

  it('能还原明文 JSON', () => {
    const key = 'test-encrypt-key';
    const obj = { type: 'url_verification', challenge: 'ch-1', token: 'tk' };
    const cipher = encrypt(key, JSON.stringify(obj));
    expect(JSON.parse(feishuDecrypt(key, cipher))).toEqual(obj);
  });
});

describe('feishuWebhookBody · 消息体', () => {
  it('text：无密钥不带签名', () => {
    const b = feishuWebhookBody({ kind: 'text', text: 'hi' });
    expect(b.msg_type).toBe('text');
    expect((b.content as any).text).toBe('hi');
    expect(b.sign).toBeUndefined();
  });
  it('text：有密钥带 timestamp + sign', () => {
    const b = feishuWebhookBody({ kind: 'text', text: 'hi' }, 'sec');
    expect(b.timestamp).toBeTruthy();
    expect(b.sign).toBeTruthy();
  });
  it('card：走 interactive，带标题与按钮', () => {
    const b = feishuWebhookBody({ kind: 'card', title: 'T', lines: ['a', 'b'], link: { text: '打开', url: 'https://x' } });
    expect(b.msg_type).toBe('interactive');
    const card = b.card as any;
    expect(card.header.title.content).toBe('T');
    const hasButton = JSON.stringify(card.elements).includes('打开');
    expect(hasButton).toBe(true);
  });
});

describe('feishuPassesMentionGate · 群里必须 @ 才回', () => {
  it('单聊：不需要 @，每句话都是对它说的', () => {
    expect(feishuPassesMentionGate({ chat_type: 'p2p' })).toBe(true);
  });

  it('🔒 群聊没有任何 @ → 不应答（申请了「接收群聊全部消息」权限时的噪声闸）', () => {
    expect(feishuPassesMentionGate({ chat_type: 'group' })).toBe(false);
    expect(feishuPassesMentionGate({ chat_type: 'group', mentions: [] })).toBe(false);
  });

  it('群聊有 @ → 放行到第二道（认是不是 @ 的自己）', () => {
    expect(feishuPassesMentionGate({ chat_type: 'group', mentions: [{ key: '@_user_1' }] })).toBe(true);
  });

  it('chat_type 缺失（旧结构/单聊）→ 放行，不因为字段没给就哑掉', () => {
    expect(feishuPassesMentionGate({})).toBe(true);
  });
});
