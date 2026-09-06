import { WebSocket } from 'undici';

// 企业微信「智能机器人」长连接协议（2026-09-05）。
// 文档：https://developer.work.weixin.qq.com/document/path/101463
//
// 帧全是 JSON：
//   → {cmd:'aibot_subscribe', headers:{req_id}, body:{bot_id, secret}}      连上后第一帧，鉴权
//   → {cmd:'ping', headers:{req_id}}                                          每 30 秒一次
//   ← {errcode, errmsg, headers:{req_id}}                                     上面两种的回应
//   ← {cmd:'aibot_msg_callback', headers:{req_id}, body:{msgid, chatid?, chattype:'single'|'group',
//        from:{userid}, msgtype:'text'|…, text:{content}}}                    有人 @机器人 / 私聊它
//   → {cmd:'aibot_respond_msg', headers:{req_id}, body:{msgtype:'stream', stream:{id, finish, content}}}
//        回复：req_id 必须是那条回调的；同一 stream.id 可以分多帧，finish=true 收口（10 分钟内）。
//        content 是**到目前为止的全文**（流式展示替换而不是追加）。
// 限制：每个会话 30 条/分钟；每个机器人**只许一条活连接**（新连接会把旧的顶掉）。
//
// 🔒 这里只做帧的拼与拆，不碰库、不碰路由；socket 的生命周期在 wecom-aibot-poller.ts。

export const AIBOT_WS_URL = 'wss://openws.work.weixin.qq.com';
export const AIBOT_PING_MS = 30_000;
/** 流式回复必须在这个时限内收口；留半分钟余量给网络 */
export const AIBOT_STREAM_TTL_MS = 9.5 * 60_000;
/** 一帧 content 的长度上限（协议没公布，按企微文本消息的 2048 字节口径保守取） */
export const AIBOT_TEXT_MAX = 1800;

export type AibotFrame = { cmd?: string; headers?: { req_id?: string }; body?: Record<string, unknown>; errcode?: number; errmsg?: string };

export type AibotInbound = {
  reqId: string;
  msgId: string;
  chatId: string;
  chatType: 'single' | 'group';
  userId: string;
  /** 文本内容；非文字消息为空串（调用方回「只认文字」） */
  text: string;
  msgType: string;
};

let seq = 0;
export function reqId(prefix = 'r'): string {
  seq = (seq + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`;
}

export function subscribeFrame(botId: string, secret: string): string {
  return JSON.stringify({ cmd: 'aibot_subscribe', headers: { req_id: reqId('sub') }, body: { bot_id: botId, secret } });
}

export function pingFrame(): string {
  return JSON.stringify({ cmd: 'ping', headers: { req_id: reqId('ping') } });
}

/** 回复帧。content 是全文；finish=true 收口。超长截断而不是拒发（截断不打回）。 */
export function respondFrame(inboundReqId: string, streamId: string, content: string, finish: boolean): string {
  const text = content.length > AIBOT_TEXT_MAX ? `${content.slice(0, AIBOT_TEXT_MAX - 1)}…` : content;
  return JSON.stringify({
    cmd: 'aibot_respond_msg',
    headers: { req_id: inboundReqId },
    body: { msgtype: 'stream', stream: { id: streamId, finish, content: text } },
  });
}

export function parseFrame(raw: unknown): AibotFrame | null {
  try {
    const s = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    const o = JSON.parse(s) as AibotFrame;
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

/** 把回调帧拆成归一化入站；不是回调帧返回 null。 */
export function parseInbound(f: AibotFrame): AibotInbound | null {
  if (f.cmd !== 'aibot_msg_callback') return null;
  const b = (f.body ?? {}) as Record<string, unknown>;
  const req = f.headers?.req_id;
  const msgId = typeof b.msgid === 'string' ? b.msgid : '';
  const from = (b.from ?? {}) as Record<string, unknown>;
  const userId = typeof from.userid === 'string' ? from.userid : '';
  if (!req || !msgId || !userId) return null;
  const chatType: 'single' | 'group' = b.chattype === 'group' ? 'group' : 'single';
  const chatId = chatType === 'group' && typeof b.chatid === 'string' && b.chatid ? b.chatid : userId;
  const msgType = typeof b.msgtype === 'string' ? b.msgtype : '';
  const text = msgType === 'text' ? String(((b.text ?? {}) as Record<string, unknown>).content ?? '').trim() : '';
  return { reqId: req, msgId, chatId, chatType, userId, text, msgType };
}

/** 群里 @机器人 的文本会带 @昵称 前缀；去掉它再进路由（与飞书/企微应用的入站口径一致） */
export function stripMention(text: string): string {
  return text.replace(/^(@\S+\s*)+/, '').trim();
}

/**
 * 最小 socket 抽象：poller 只依赖这四样，测试用假 socket 注入（不用真连企微）。
 */
export type AibotSocket = {
  send(data: string): void;
  close(): void;
  onMessage(cb: (raw: unknown) => void): void;
  onClose(cb: (reason: string) => void): void;
  onOpen(cb: () => void): void;
};

export type SocketFactory = (url: string) => AibotSocket;

/** 真连接：undici 自带 WebSocket，零新依赖（Node 20 没有稳定的全局 WebSocket） */
export const realSocketFactory: SocketFactory = (url) => {
  const ws = new WebSocket(url);
  return {
    send: (d) => ws.send(d),
    close: () => { try { ws.close(); } catch { /* 已关 */ } },
    onMessage: (cb) => ws.addEventListener('message', (ev) => cb((ev as { data: unknown }).data)),
    onClose: (cb) => {
      ws.addEventListener('close', (ev) => cb(`close ${(ev as { code?: number }).code ?? ''}`));
      ws.addEventListener('error', (ev) => cb(`error ${(ev as { message?: string }).message ?? ''}`));
    },
    onOpen: (cb) => ws.addEventListener('open', () => cb()),
  };
};
