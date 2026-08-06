import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { prisma } from '@/lib/db';
import { writeBotSecrets } from '@/lib/bot';
import { GET, POST } from '@/app/api/bot/wecom/events/[key]/route';

// 企微自建应用回调端点：GET URL 验证 / POST 消息解密处理 / 验签 / 未知 key 404。

const CORP_ID = 'wwTestCorp';
const AGENT_ID = '1000002';
const KEY = `${CORP_ID}_${AGENT_ID}`;
const TOKEN = 'test-verification-token';
const ENCODING_AES_KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'; // 43 chars

function wecomSign(token: string, timestamp: string, nonce: string, encrypt: string): string {
  const arr = [token, timestamp, nonce, encrypt].sort();
  return crypto.createHash('sha1').update(arr.join('')).digest('hex');
}

function wecomEncrypt(encodingAESKey: string, msg: string, receiveid = 'corpid'): string {
  const aesKey = Buffer.from(encodingAESKey + '=', 'base64');
  const iv = aesKey.subarray(0, 16);
  const random = crypto.randomBytes(16);
  const msgBuf = Buffer.from(msg, 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length);
  const recvBuf = Buffer.from(receiveid, 'utf8');
  const plain = Buffer.concat([random, lenBuf, msgBuf, recvBuf]);
  const blockSize = 32;
  const pad = blockSize - (plain.length % blockSize);
  const padBuf = Buffer.alloc(pad, pad);
  const padded = Buffer.concat([plain, padBuf]);
  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}

beforeEach(async () => {
  await prisma.tenant.deleteMany({});
  await prisma.tenant.create({ data: { id: 't1', name: 'T', plan: 'free' } });
  await prisma.workspace.create({ data: { id: 'w1', tenantId: 't1', name: 'W' } });
  await prisma.botIntegration.create({
    data: {
      workspaceId: 'w1',
      provider: 'wecom',
      label: '企微测试',
      inboundKey: KEY,
      secretsEnc: writeBotSecrets({
        verificationToken: TOKEN,
        encryptKey: ENCODING_AES_KEY,
        corpId: CORP_ID,
        appSecret: 'fake-secret',
        agentId: AGENT_ID,
      }),
      pushEvents: '[]',
    },
  });
});

function makeGet(key: string, params: Record<string, string>) {
  const url = new URL(`http://localhost/api/bot/wecom/events/${key}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const req = new Request(url.toString(), { method: 'GET' });
  return GET(req, { params: Promise.resolve({ key }) });
}

function makePost(key: string, body: string, params: Record<string, string>) {
  const url = new URL(`http://localhost/api/bot/wecom/events/${key}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const req = new Request(url.toString(), {
    method: 'POST',
    headers: { 'content-type': 'text/xml' },
    body,
  });
  return POST(req, { params: Promise.resolve({ key }) });
}

describe('GET /api/bot/wecom/events/[key] · URL 验证', () => {
  it('未知 key → 404', async () => {
    const res = await makeGet('unknown_key', {});
    expect(res.status).toBe(404);
  });

  it('验签失败 → 401', async () => {
    const echostr = wecomEncrypt(ENCODING_AES_KEY, 'echo-test');
    const res = await makeGet(KEY, {
      msg_signature: 'wrong-sig',
      timestamp: '1700000000',
      nonce: 'abc',
      echostr,
    });
    expect(res.status).toBe(401);
  });

  it('验签正确 → 200 + 返回解密后的明文', async () => {
    const echostr = wecomEncrypt(ENCODING_AES_KEY, 'echo-challenge');
    const ts = '1700000000';
    const nonce = 'abc';
    const sig = wecomSign(TOKEN, ts, nonce, echostr);
    const res = await makeGet(KEY, { msg_signature: sig, timestamp: ts, nonce, echostr });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('echo-challenge');
  });
});

describe('POST /api/bot/wecom/events/[key] · 消息接收', () => {
  it('未知 key → 404', async () => {
    const res = await makePost('unknown_key', '<xml></xml>', {});
    expect(res.status).toBe(404);
  });

  it('缺少 Encrypt 字段 → 静默 ack', async () => {
    const res = await makePost(KEY, '<xml><NoEncrypt>x</NoEncrypt></xml>', {
      msg_signature: '', timestamp: '1700000000', nonce: 'abc',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('success');
  });

  it('验签失败 → 401', async () => {
    const innerXml = '<xml><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[/帮助]]></Content><FromUserName><![CDATA[user1]]></FromUserName></xml>';
    const encrypt = wecomEncrypt(ENCODING_AES_KEY, innerXml);
    const body = `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`;
    const res = await makePost(KEY, body, {
      msg_signature: 'wrong-sig', timestamp: '1700000000', nonce: 'abc',
    });
    expect(res.status).toBe(401);
  });

  it('文本消息 → 快速 ack "success"', async () => {
    const innerXml = '<xml><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[/帮助]]></Content><FromUserName><![CDATA[user1]]></FromUserName></xml>';
    const encrypt = wecomEncrypt(ENCODING_AES_KEY, innerXml);
    const body = `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`;
    const ts = '1700000000';
    const nonce = 'abc';
    const sig = wecomSign(TOKEN, ts, nonce, encrypt);
    const res = await makePost(KEY, body, { msg_signature: sig, timestamp: ts, nonce });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('success');
  });

  it('非文本消息 → 静默 ack', async () => {
    const innerXml = '<xml><MsgType><![CDATA[image]]></MsgType><FromUserName><![CDATA[user1]]></FromUserName></xml>';
    const encrypt = wecomEncrypt(ENCODING_AES_KEY, innerXml);
    const body = `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`;
    const ts = '1700000000';
    const nonce = 'abc';
    const sig = wecomSign(TOKEN, ts, nonce, encrypt);
    const res = await makePost(KEY, body, { msg_signature: sig, timestamp: ts, nonce });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('success');
  });
});
