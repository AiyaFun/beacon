import { feishuTenantAccessToken, feishuListBotChats, feishuSendToChat } from './feishu';
import { getDingtalkAccessToken, sendDingtalkApp } from './dingtalk';
import { getWecomAccessToken, sendWecomApp } from './wecom';
import type { BotSecrets, PushMessage } from './types';

// 机器人体检：把「测试失败」拆成逐步结果，每步带上平台原始 code/msg。
// 存在的理由：出站失败的原因高度同质（凭据错 / 权限没开 / 没进群 / 应用没发版），
// 单看一句聚合错误分不清是哪一种，用户只能瞎试。

export type DiagStep = {
  name: string;
  ok: boolean;
  detail: string;
  /** 卡住时给一句可直接照做的修复指引 */
  fix?: string;
};

export type DiagResult = { steps: DiagStep[]; passed: boolean };

const PROBE: PushMessage = {
  kind: 'text',
  text: '烽火台体检消息，看到即说明机器人已打通。',
};

function done(steps: DiagStep[]): DiagResult {
  return { steps, passed: steps.length > 0 && steps.every((s) => s.ok) };
}

export async function diagnoseBot(
  provider: string,
  webhookUrl: string | null,
  inboundKey: string | null,
  secrets: BotSecrets,
): Promise<DiagResult> {
  // 选路必须与 lib/bot/index.ts 的 routeSend 一致，否则体检测的不是真实推送走的那条路。
  const appReady =
    !!inboundKey && !!secrets.appSecret &&
    (provider === 'dingtalk' ? !!secrets.agentId : provider === 'wecom' ? !!(secrets.corpId && secrets.agentId) : true);

  // Webhook 模式没有中间步骤，直接发一条就知道通不通
  if (webhookUrl && !appReady) {
    const { sendVia } = await import('./index');
    const r = await sendVia(provider, webhookUrl, secrets, PROBE);
    return done([
      {
        name: '向 Webhook 地址发送测试消息',
        ok: r.ok,
        detail: r.ok ? '发送成功，去群里看看' : r.error ?? '发送失败',
        fix: r.ok ? undefined : '核对 Webhook 地址是否完整、机器人是否还在群里；开了加签就要填加签密钥',
      },
    ]);
  }

  if (!inboundKey) {
    return done([{ name: '读取配置', ok: false, detail: '既没有 Webhook 地址，也没有自建应用凭据' }]);
  }

  const r =
    provider === 'feishu' ? await diagnoseFeishu(inboundKey, secrets)
    : provider === 'dingtalk' ? await diagnoseDingtalk(inboundKey, secrets)
    : provider === 'wecom' ? await diagnoseWecom(secrets)
    : done([{ name: '体检', ok: false, detail: `${provider} 暂不支持自建应用体检` }]);

  // 两种模式都留着配置时明确说清楚走的是哪条——历史上正是这里的静默优先级坑了人
  if (webhookUrl) {
    r.steps.unshift({
      name: '⓪ 选路',
      ok: true,
      detail: '同时存在群 Webhook 与自建应用凭据，按自建应用模式推送（Webhook 未被使用，可在下方清掉）',
    });
  }
  return r;
}

// ── 飞书：换 token → 列群 → 真发一条。三步各自会因不同原因失败，必须分开报。 ──
async function diagnoseFeishu(appId: string, secrets: BotSecrets): Promise<DiagResult> {
  const steps: DiagStep[] = [];

  if (!secrets.appSecret) {
    steps.push({ name: '① 换取 tenant_access_token', ok: false, detail: '没有保存 App Secret', fix: '在下方「App Secret」填入飞书开放平台「凭证与基础信息」里的值' });
    return done(steps);
  }

  const { token, error: tokenErr } = await feishuTenantAccessToken(appId, secrets.appSecret);
  steps.push({
    name: '① 换取 tenant_access_token',
    ok: !!token,
    detail: token ? `成功（App ID ${appId}）` : tokenErr ?? '飞书未返回 token',
    fix: token ? undefined : '核对 App ID / App Secret 是否与开放平台一致（注意别把 App Secret 和 Verification Token 弄混）',
  });
  if (!token) return done(steps);

  const { chatIds, error: chatsErr } = await feishuListBotChats(token);
  const chatsOk = !chatsErr;
  steps.push({
    name: '② 读取机器人所在的群列表',
    ok: chatsOk,
    detail: chatsOk ? `机器人当前在 ${chatIds.length} 个群` : chatsErr!,
    fix: chatsOk ? undefined : '在「权限管理」开通 im:chat:readonly（获取群组信息），然后重新发布版本',
  });
  if (!chatsOk) return done(steps);

  if (chatIds.length === 0) {
    steps.push({
      name: '③ 发送测试消息',
      ok: false,
      detail: '机器人一个群都没进，没有可发送的目标',
      fix: '在飞书群里「设置 → 群机器人 → 添加机器人」，把你的自建应用加进去',
    });
    return done(steps);
  }

  const r = await feishuSendToChat(token, chatIds[0], PROBE);
  const isBotDisabled = /bot not enabled|机器人未启用/i.test(r.error ?? '');
  steps.push({
    name: '③ 发送测试消息',
    ok: r.ok,
    detail: r.ok ? '发送成功，去群里看看' : r.error ?? '发送失败',
    fix: r.ok
      ? undefined
      : isBotDisabled
        ? '应用没有开启机器人能力，或开了但没发版生效：①「应用功能 → 机器人」点启用 ②「权限管理」确认有 im:message:send_as_bot ③「版本管理与发布」创建版本并发布 ④ 企业内发布通常要管理员审核，状态还是「审核中」时不生效，要等变成已发布'
        : '按上面的 code/msg 对照飞书错误码文档',
  });
  return done(steps);
}

// ── 钉钉：换 token → 发工作通知 ──
async function diagnoseDingtalk(appKey: string, secrets: BotSecrets): Promise<DiagResult> {
  const steps: DiagStep[] = [];
  if (!secrets.appSecret || !secrets.agentId) {
    steps.push({ name: '① 读取配置', ok: false, detail: '缺少 AppSecret 或 AgentId', fix: '在下方补齐 AppSecret 与 AgentId' });
    return done(steps);
  }

  const { token, error } = await getDingtalkAccessToken(appKey, secrets.appSecret);
  steps.push({
    name: '① 换取 access_token',
    ok: !!token,
    detail: token ? `成功（AppKey ${appKey}）` : error ?? '钉钉未返回 token',
    fix: token ? undefined : '核对 AppKey / AppSecret 是否与钉钉开放平台一致',
  });
  if (!token) return done(steps);

  const r = await sendDingtalkApp(appKey, secrets.appSecret, secrets.agentId, PROBE);
  steps.push({
    name: '② 发送工作通知',
    ok: r.ok,
    detail: r.ok ? '发送成功，看钉钉消息列表' : r.error ?? '发送失败',
    fix: r.ok ? undefined : '在「权限管理」开通「企业内部机器人发送消息」，并确认 AgentId 正确、应用已发布',
  });
  return done(steps);
}

// ── 企微：换 token → 发应用消息 ──
async function diagnoseWecom(secrets: BotSecrets): Promise<DiagResult> {
  const steps: DiagStep[] = [];
  if (!secrets.corpId || !secrets.appSecret || !secrets.agentId) {
    steps.push({ name: '① 读取配置', ok: false, detail: '缺少 CorpID / Secret / AgentID', fix: '在下方补齐这三项' });
    return done(steps);
  }

  const { token, error } = await getWecomAccessToken(secrets.corpId, secrets.appSecret);
  steps.push({
    name: '① 换取 access_token',
    ok: !!token,
    detail: token ? `成功（CorpID ${secrets.corpId}）` : error ?? '企微未返回 token',
    fix: token ? undefined : '核对 CorpID 与应用 Secret 是否一致',
  });
  if (!token) return done(steps);

  const r = await sendWecomApp(secrets.corpId, secrets.appSecret, secrets.agentId, PROBE);
  steps.push({
    name: '② 发送应用消息',
    ok: r.ok,
    detail: r.ok ? '发送成功，看企业微信工作台' : r.error ?? '发送失败',
    fix: r.ok ? undefined : '确认 AgentID 正确、应用「可见范围」已包含你自己',
  });
  return done(steps);
}
