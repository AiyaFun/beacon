import { getWecomAccessToken } from './wecom';
import { createLogger } from '../logger';
import { splitWechatText } from './wechat-text';

const log = createLogger({ module: 'bot-wechat-kf' });

// 微信客服（官方通道，2026-09-01）。微信用户 → 企业的客服账号 → 这里。
//
// 【协议】企微回调只送一个「有新消息」的信号（kf_msg_or_event 事件带一次性 Token），
// 消息本体要拿 Token+cursor 调 kf/sync_msg 拉取；回复走 kf/send_msg。
// access_token 用企微管理后台「微信客服」页生成的 Secret 换（与自建应用的 gettoken 同端点）。
//
// 【为什么没有「推送」函数】客服消息有 48 小时窗口规则：只能回复近期主动咨询的用户。
// 定时推送在这条通道上不存在——lib/bot/index.ts 的 sendVia 分发对 wechat_kf
// 走 default 分支如实拒绝，别在这里补一个伪装成广播的接口。

const QY = 'https://qyapi.weixin.qq.com/cgi-bin';

export type KfMessage = {
  msgid: string;
  msgtype: string;
  text?: { content?: string };
  external_userid?: string;
  open_kfid?: string;
  origin?: number; // 3=微信用户发来；4=系统事件；5=客服人员发送（我们自己发的回执，必须跳过防自嗨循环）
  /** msgtype=event 时的事件体。enter_session 带 welcome_code：进入会话那一刻可以发一条欢迎语 */
  event?: { event_type?: string; open_kfid?: string; external_userid?: string; welcome_code?: string; scene?: string };
};

export async function kfSyncMsg(
  corpId: string,
  secret: string,
  eventToken: string,
  cursor?: string,
  openKfId?: string,
): Promise<{ ok: boolean; msgs: KfMessage[]; nextCursor?: string; hasMore: boolean; error?: string }> {
  const { token, error } = await getWecomAccessToken(corpId, secret);
  if (!token) return { ok: false, msgs: [], hasMore: false, error: error ?? '取 access_token 失败' };
  try {
    const res = await fetch(`${QY}/kf/sync_msg?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // open_kfid 能带就带：企业有多个客服账号时，不带会把别的账号的消息也拉进来（且频控更严）
      body: JSON.stringify({
        token: eventToken,
        ...(cursor ? { cursor } : {}),
        ...(openKfId ? { open_kfid: openKfId } : {}),
        limit: 100,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as {
      errcode?: number; errmsg?: string; msg_list?: KfMessage[]; next_cursor?: string; has_more?: number;
    };
    if (data.errcode) return { ok: false, msgs: [], hasMore: false, error: `sync_msg ${data.errcode}: ${data.errmsg}` };
    return { ok: true, msgs: data.msg_list ?? [], nextCursor: data.next_cursor, hasMore: data.has_more === 1 };
  } catch (e) {
    return { ok: false, msgs: [], hasMore: false, error: (e as Error).message };
  }
}

async function kfPost(token: string, path: string, body: unknown): Promise<{ errcode?: number; errmsg?: string } & Record<string, unknown>> {
  const res = await fetch(`${QY}/${path}?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return (await res.json()) as { errcode?: number; errmsg?: string } & Record<string, unknown>;
}

/**
 * 回一段文本。超过单条上限就**拆成几条按序发**（lib/bot/wechat-text.ts），不再截断——
 * 对话回复被截掉后半截，用户看到的是一句没说完的话。
 * 任一段发失败即停（后面的段没有前面的段没意义），返回那一段的错误。
 */
export async function kfSendText(
  corpId: string,
  secret: string,
  openKfId: string,
  externalUserId: string,
  text: string,
): Promise<{ ok: boolean; error?: string; parts?: number }> {
  const { token, error } = await getWecomAccessToken(corpId, secret);
  if (!token) return { ok: false, error: error ?? '取 access_token 失败' };
  const parts = splitWechatText(text);
  if (parts.length === 0) return { ok: true, parts: 0 };
  try {
    for (const content of parts) {
      const data = await kfPost(token, 'kf/send_msg', {
        touser: externalUserId,
        open_kfid: openKfId,
        msgtype: 'text',
        text: { content },
      });
      if (data.errcode) return { ok: false, error: `send_msg ${data.errcode}: ${data.errmsg}` };
    }
    return { ok: true, parts: parts.length };
  } catch (e) {
    log.warn('微信客服回复失败', { err: e });
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * 用户「进入会话」那一刻的欢迎语（kf/send_msg_on_event，凭 enter_session 事件里的 welcome_code）。
 * 这是一对一渠道里的「身份行开场」：群里靠 @机器人 时的 persona 开场，客服会话里就靠这一条——
 * 用户扫码进来先知道对面是谁、能做什么，而不是对着空白输入框猜。
 * welcome_code 只在企微后台**没配**自动欢迎语时才下发，且 20 秒内有效——发失败不算错，静默即可。
 */
export async function kfSendWelcome(
  corpId: string,
  secret: string,
  welcomeCode: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  const { token, error } = await getWecomAccessToken(corpId, secret);
  if (!token) return { ok: false, error: error ?? '取 access_token 失败' };
  try {
    const data = await kfPost(token, 'kf/send_msg_on_event', {
      code: welcomeCode,
      msgtype: 'text',
      text: { content: splitWechatText(text)[0] ?? text },
    });
    if (data.errcode) return { ok: false, error: `send_msg_on_event ${data.errcode}: ${data.errmsg}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * 列出这个企业的微信客服账号（kf/account/list）。体检用：
 * ① 证明 Secret 是「微信客服」的 Secret 而不是自建应用的（后者换得到 token 但调不了 kf/*）；
 * ② 把客服账号名列出来，用户一眼对上「我配的是哪个客服号」。
 */
export async function kfListAccounts(
  corpId: string,
  secret: string,
): Promise<{ ok: boolean; accounts: { openKfId: string; name: string }[]; error?: string }> {
  const { token, error } = await getWecomAccessToken(corpId, secret);
  if (!token) return { ok: false, accounts: [], error: error ?? '取 access_token 失败' };
  try {
    const data = await kfPost(token, 'kf/account/list', { offset: 0, limit: 100 });
    if (data.errcode) return { ok: false, accounts: [], error: `account/list ${data.errcode}: ${data.errmsg}` };
    const list = (data.account_list as { open_kfid?: string; name?: string }[] | undefined) ?? [];
    return { ok: true, accounts: list.map((a) => ({ openKfId: a.open_kfid ?? '', name: a.name ?? '' })) };
  } catch (e) {
    return { ok: false, accounts: [], error: (e as Error).message };
  }
}

// ── 同一集成的拉取必须串行：2026-09-03 搬到 lib/bot/serialize.ts（router 入口也用它），这里只转出口 ──
export { runSerialized } from './serialize';

// ── msgid 去重：2026-09-02 搬到 lib/bot/seen.ts 与飞书/企微/钉钉共用，这里只转出口 ──
export { markSeen } from './seen';
