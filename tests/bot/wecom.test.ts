import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { wecomSignature, wecomDecrypt, wecomExtractXml } from '@/lib/bot/wecom';

// 企微入站密码学：SHA1 验签 + AES-256-CBC 解密 + XML 提取（与官方文档口径对齐）。

describe('wecomSignature · 回调验签', () => {
  const token = 'test-token';
  const ts = '1700000000';
  const nonce = 'abc123';
  const encrypt = 'encrypted-content';

  function makeSignature(t: string, ts: string, n: string, e: string): string {
    const arr = [t, ts, n, e].sort();
    return crypto.createHash('sha1').update(arr.join('')).digest('hex');
  }

  it('正确签名通过', () => {
    const expected = makeSignature(token, ts, nonce, encrypt);
    expect(wecomSignature(token, ts, nonce, encrypt)).toBe(expected);
  });

  it('同输入确定性', () => {
    const a = wecomSignature(token, ts, nonce, encrypt);
    const b = wecomSignature(token, ts, nonce, encrypt);
    expect(a).toBe(b);
  });

  it('参数顺序无关（sort）', () => {
    const a = wecomSignature('d', 'c', 'b', 'a');
    const b = wecomSignature('a', 'b', 'c', 'd');
    expect(a).toBe(b);
  });

  it('篡改任一参数 → 签名变化', () => {
    const base = wecomSignature(token, ts, nonce, encrypt);
    expect(wecomSignature('wrong', ts, nonce, encrypt)).not.toBe(base);
    expect(wecomSignature(token, '999', nonce, encrypt)).not.toBe(base);
    expect(wecomSignature(token, ts, 'xxx', encrypt)).not.toBe(base);
    expect(wecomSignature(token, ts, nonce, 'yyy')).not.toBe(base);
  });
});

describe('wecomDecrypt · AES-256-CBC 解密', () => {
  // 按企微官方方案造密文：EncodingAESKey 43 字符 + '=' → base64 → 32B key，IV = 前 16B
  // 明文格式：random(16) + msgLen(4B BE) + msg + receiveid
  function encrypt(encodingAESKey: string, msg: string, receiveid = 'corpid'): string {
    const aesKey = Buffer.from(encodingAESKey + '=', 'base64');
    const iv = aesKey.subarray(0, 16);
    const random = crypto.randomBytes(16);
    const msgBuf = Buffer.from(msg, 'utf8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(msgBuf.length);
    const recvBuf = Buffer.from(receiveid, 'utf8');
    const plain = Buffer.concat([random, lenBuf, msgBuf, recvBuf]);
    // PKCS7 padding
    const blockSize = 32;
    const pad = blockSize - (plain.length % blockSize);
    const padBuf = Buffer.alloc(pad, pad);
    const padded = Buffer.concat([plain, padBuf]);
    const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
  }

  // 43 个 base64 字符的 EncodingAESKey
  const aesKey = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

  it('能还原明文', () => {
    const msg = '你好企微';
    const ciphertext = encrypt(aesKey, msg);
    expect(wecomDecrypt(aesKey, ciphertext)).toBe(msg);
  });

  it('JSON 明文完整还原', () => {
    const obj = { MsgType: 'text', Content: '测试消息' };
    const ciphertext = encrypt(aesKey, JSON.stringify(obj));
    expect(JSON.parse(wecomDecrypt(aesKey, ciphertext))).toEqual(obj);
  });

  it('错误密钥 → 抛异常', () => {
    const msg = 'hello';
    const ciphertext = encrypt(aesKey, msg);
    const wrongKey = 'ABCDEFG0123456789abcdefghijklmnopqrstuvwxy';
    expect(() => wecomDecrypt(wrongKey, ciphertext)).toThrow();
  });
});

describe('wecomExtractXml · XML 标签提取', () => {
  it('CDATA 包裹', () => {
    const xml = '<xml><Content><![CDATA[你好]]></Content></xml>';
    expect(wecomExtractXml(xml, 'Content')).toBe('你好');
  });

  it('普通标签', () => {
    const xml = '<xml><MsgType>text</MsgType></xml>';
    expect(wecomExtractXml(xml, 'MsgType')).toBe('text');
  });

  it('多标签各取各', () => {
    const xml = '<xml><ToUserName><![CDATA[corp]]></ToUserName><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[/帮助]]></Content></xml>';
    expect(wecomExtractXml(xml, 'ToUserName')).toBe('corp');
    expect(wecomExtractXml(xml, 'MsgType')).toBe('text');
    expect(wecomExtractXml(xml, 'Content')).toBe('/帮助');
  });

  it('不存在的标签 → 空串', () => {
    expect(wecomExtractXml('<xml></xml>', 'Missing')).toBe('');
  });

  it('空 XML → 空串（不抛异常）', () => {
    expect(wecomExtractXml('', 'Any')).toBe('');
  });
});
