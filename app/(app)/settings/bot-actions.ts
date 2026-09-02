'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { requireRole } from '@/lib/rbac';
import { toJson } from '@/lib/json';
import { readBotSecrets, writeBotSecrets, testPush } from '@/lib/bot';
import { BOT_PROVIDERS, PUSH_EVENTS, EXTERNAL_DEFAULT_COMMANDS, isReplyOnlyProvider, sanitizeAllowCommands, type BotSecrets } from '@/lib/bot/types';
import { ilinkGetQr, ilinkQrStatus } from '@/lib/bot/wechat-ilink';
import { renderQrSvg } from '@/lib/pay/qr';

// 机器人集成 CRUD + 测试发送（需求③④）。
// 权限：涉及外部推送/密钥/合规责任，与 BYOK 同级 —— 仅 owner/admin（byok.manage）。
// 密钥永不回显：secretsEnc 加密入库，表单留空=保持原值（不覆盖）。

const SUPPORTED = new Set<string>(BOT_PROVIDERS.filter((p) => p.supported).map((p) => p.key));
const VALID_EVENTS = new Set<string>(PUSH_EVENTS.map((e) => e.key));

type SaveInput = {
  id?: string;
  provider: string;
  label?: string;
  /** 表单当前选的接入模式。两种模式互斥——不显式带上的话，服务端只能靠「哪个字段非空」去猜，
   *  而编辑态里旧 webhookUrl 会被表单原样带回来，猜错就会两种模式并存（见下方 exclusivity 处理）。*/
  botMode?: 'app' | 'webhook';
  webhookUrl?: string;
  signSecret?: string; // 出站签名密钥；留空=不改
  pushEvents?: string[];
  pushSchedule?: string; // 定时推送设置，如 "09:00"
  /** 群里允许触发哪些操作（管理员勾选）。undefined=不改动；见下方 allowCommands 的空数组语义。 */
  allowCommands?: string[];
  // 入站（自建应用事件订阅，需求④）——可选，留空=只配出站
  appId?: string;       // 飞书 App ID / 钉钉 AppKey / 企微 CorpID
  appSecret?: string;   // 留空=不改
  verificationToken?: string; // 留空=不改（飞书/企微）
  encryptKey?: string; // 留空=不改（飞书/企微 EncodingAESKey）
  agentId?: string;    // 钉钉 AgentId / 企微 AgentID
  /** 渠道默认智能体（WorkflowTemplate.id）。表单每次都带：'' = 清空回通用助手，undefined = 不改 */
  agentTemplateId?: string;
};

export async function actSaveBot(data: SaveInput) {
  const s = await getSession();
  requireRole(s, 'byok.manage');

  const provider = String(data.provider ?? '').trim();
  if (!SUPPORTED.has(provider)) return { ok: false, error: '暂不支持该平台机器人' };
  // 微信（iLink）：凭据只来自扫码（actWechatIlinkStatus 落库），这条通用保存路只改名称/智能体/指令白名单
  if (provider === 'wechat') return saveWechatIlinkMeta(s, data);

  // 两种接入模式互斥：选了自建应用就不留 webhook，反之亦然。
  // 不这么收口的话，编辑态会把旧值原样带回来，库里两种并存，推送选路只能靠优先级去赌。
  // 微信客服没有 webhook 这条路：无论表单带什么模式，一律按自建应用字段处理
  const mode = provider === 'wechat_kf' ? 'app' : data.botMode;
  const webhookUrl = mode === 'app' ? '' : String(data.webhookUrl ?? '').trim();
  let appId = mode === 'webhook' ? '' : String(data.appId ?? '').trim();
  // 微信客服的 inboundKey 是 corpId_kf。编辑态若把它原样当 CorpID 带回来，这里剥掉后缀——
  // 否则每编辑一次 inboundKey 就多一节 _kf，回调地址跟着变，企微那边配好的回调静默失效
  if (provider === 'wechat_kf') appId = appId.replace(/_kf$/, '');
  if (!webhookUrl && !appId) {
    return { ok: false, error: '至少填一项：出站 webhook 地址，或入站 App ID' };
  }
  // webhook 必须是对应平台的官方域名，防把密钥往任意地址发
  if (webhookUrl && provider === 'feishu' && !/^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\//.test(webhookUrl)) {
    return { ok: false, error: 'webhook 地址应形如 https://open.feishu.cn/open-apis/bot/v2/hook/xxxx' };
  }
  if (webhookUrl && provider === 'dingtalk' && !/^https:\/\/oapi\.dingtalk\.com\/robot\/send\?/.test(webhookUrl)) {
    return { ok: false, error: 'webhook 地址应形如 https://oapi.dingtalk.com/robot/send?access_token=xxxx' };
  }
  if (webhookUrl && provider === 'wecom' && !/^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?/.test(webhookUrl)) {
    return { ok: false, error: 'webhook 地址应形如 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx' };
  }

  // 只答不推的渠道（微信客服）：表单虽然把推送开关整段藏了，但 events 状态仍带着默认三项提交——
  // 存进去的后果是每天早上晨报到点、推送失败、卡片红一条「推送失败」。在这里清空，不靠前端记得。
  const pushEvents = isReplyOnlyProvider(provider) ? [] : (data.pushEvents ?? []).filter((e) => VALID_EVENTS.has(e));
  const pushSchedule = String(data.pushSchedule ?? '09:00').trim() || '09:00';

  // 入站命令白名单。
  // ⚠️ 存库时**永远补一个 'help'**：库里的空数组表示「从未配置=默认全开」（老数据都是空的），
  // 若管理员把所有开关都关掉却存成空数组，下一次读出来会被当成「全开」——正好反了。
  // 补上 help 让「配过但全关」= ["help"]，与「没配过」= [] 在语义上分得开。
  const allowCommands =
    data.allowCommands === undefined ? undefined : [...new Set([...sanitizeAllowCommands(data.allowCommands), 'help'])];

  // 合并密钥：留空的字段保持原值（表单不回显密钥）
  const existing = data.id
    ? await prisma.botIntegration.findFirst({ where: { id: data.id, workspaceId: s.workspaceId } })
    : null;
  if (data.id && !existing) return { ok: false, error: '集成不存在' };

  const prevSecrets: BotSecrets = existing ? readBotSecrets(existing.secretsEnc) : {};
  const nextSecrets: BotSecrets = {
    signSecret: (data.signSecret ?? '').trim() || prevSecrets.signSecret,
    appSecret: (data.appSecret ?? '').trim() || prevSecrets.appSecret,
    verificationToken: (data.verificationToken ?? '').trim() || prevSecrets.verificationToken,
    encryptKey: (data.encryptKey ?? '').trim() || prevSecrets.encryptKey,
    // 企微自建应用与微信客服都拿 CorpID 换 access_token。此前只有 wecom 写这列，
    // 微信客服的 corpId 永远是空 → 回调通了、解密也过了，却在拉消息前静默退出（永远不回话）
    corpId: provider === 'wecom' || provider === 'wechat_kf' ? (appId || prevSecrets.corpId) : prevSecrets.corpId,
    agentId: (data.agentId ?? '').trim() || prevSecrets.agentId,
  };

  // 企微 inboundKey 用 corpId_agentId 组合保证全局唯一
  const agentIdVal = (data.agentId ?? '').trim();
  let inboundKey = appId || null;
  if (provider === 'wecom' && appId && agentIdVal) {
    inboundKey = `${appId}_${agentIdVal}`;
  }
  // 微信客服：同一企业只有一路客服回调，键 = corpId_kf（与自建应用的 corpId_agentId 错开，
  // 两者可以并存——同一家企业既接内部机器人又接微信客服是正常形态）
  if (provider === 'wechat_kf') {
    if (!appId) return { ok: false, error: '微信客服需要填企业 CorpID' };
    inboundKey = `${appId}_kf`;
  }

  // 渠道默认智能体：'' 清空，非空必须是本租户可见的模板（与 actSetBotAgent 同一道闸——
  // 不校验的话填别人租户的模板 id 就能把别家职责说明拉进自己群）
  let agentTemplateId: string | null | undefined = undefined;
  if (data.agentTemplateId !== undefined) {
    const clean = data.agentTemplateId.trim();
    if (!clean) agentTemplateId = null;
    else {
      const tpl = await prisma.workflowTemplate.findFirst({
        where: { id: clean, OR: [{ isBuiltin: true }, { tenantId: s.tenantId }] },
        select: { id: true },
      });
      if (!tpl) return { ok: false, error: '选的智能体不存在或不属于当前工作区' };
      agentTemplateId = clean;
    }
  }

  const payload = {
    provider,
    label: String(data.label ?? '').trim() || BOT_PROVIDERS.find((p) => p.key === provider)?.name || provider,
    webhookUrl: webhookUrl || null,
    inboundKey,
    secretsEnc: writeBotSecrets(nextSecrets),
    pushEvents: toJson(pushEvents),
    pushSchedule,
    ...(allowCommands ? { allowCommands: toJson(allowCommands) } : {}),
    ...(agentTemplateId !== undefined ? { agentTemplateId } : {}),
  };

  try {
    if (existing) {
      await prisma.botIntegration.update({ where: { id: existing.id }, data: payload });
    } else {
      await prisma.botIntegration.create({ data: { workspaceId: s.workspaceId, ...payload } });
    }
  } catch (e) {
    // inboundKey 全局 @unique：同一飞书应用不能绑到两个工作区
    if (String(e).includes('Unique') || String(e).includes('inboundKey')) {
      return { ok: false, error: '该 App ID 已被其它工作区绑定' };
    }
    return { ok: false, error: '保存失败' };
  }
  revalidatePath('/settings/keys');
  revalidatePath('/notifications');
  return { ok: true };
}

/** 微信 iLink 机器人的可编辑部分：名称 / 渠道默认智能体 / 指令白名单。凭据与绑定动不了——那是扫码的事。 */
async function saveWechatIlinkMeta(s: Awaited<ReturnType<typeof getSession>>, data: SaveInput) {
  if (!data.id) return { ok: false, error: '微信机器人要先扫码绑定（在渠道卡点「接入」）' };
  const existing = await prisma.botIntegration.findFirst({ where: { id: data.id, workspaceId: s.workspaceId, provider: 'wechat' } });
  if (!existing) return { ok: false, error: '集成不存在' };
  let agentTemplateId: string | null | undefined = undefined;
  if (data.agentTemplateId !== undefined) {
    const clean = data.agentTemplateId.trim();
    if (!clean) agentTemplateId = null;
    else {
      const tpl = await prisma.workflowTemplate.findFirst({ where: { id: clean, OR: [{ isBuiltin: true }, { tenantId: s.tenantId }] }, select: { id: true } });
      if (!tpl) return { ok: false, error: '选的智能体不存在或不属于当前工作区' };
      agentTemplateId = clean;
    }
  }
  const allowCommands = data.allowCommands === undefined ? undefined : [...new Set([...sanitizeAllowCommands(data.allowCommands), 'help'])];
  await prisma.botIntegration.update({
    where: { id: existing.id },
    data: {
      label: String(data.label ?? '').trim() || existing.label || '微信',
      ...(allowCommands ? { allowCommands: toJson(allowCommands) } : {}),
      ...(agentTemplateId !== undefined ? { agentTemplateId } : {}),
    },
  });
  revalidatePath('/settings/keys');
  revalidatePath('/notifications');
  return { ok: true };
}

// 「点眼睛看明文」：明文只在点击时按需返回，不随页面数据一起下发——
// 否则任何打开设置页的人（含旁观者/截图/前端缓存）都能从初始 payload 里捞到密钥。
// 权限与保存/测试同级（byok.manage），且限定本工作区。
export async function actRevealBotSecrets(id: string) {
  const s = await getSession();
  requireRole(s, 'byok.manage');
  const it = await prisma.botIntegration.findFirst({ where: { id, workspaceId: s.workspaceId } });
  if (!it) return { ok: false as const, error: '集成不存在' };
  const sec = readBotSecrets(it.secretsEnc);
  return {
    ok: true as const,
    secrets: {
      signSecret: sec.signSecret ?? '',
      appSecret: sec.appSecret ?? '',
      verificationToken: sec.verificationToken ?? '',
      encryptKey: sec.encryptKey ?? '',
    },
  };
}

// 机器人体检：用「实际存库的凭据」逐步跑一遍出站链路，每步单独报平台原始 code/msg。
// 比「测试发送」多的价值是——失败时能指出卡在哪一步、以及该去后台改什么。
export async function actDiagnoseBot(id: string) {
  const s = await getSession();
  requireRole(s, 'byok.manage');
  const it = await prisma.botIntegration.findFirst({ where: { id, workspaceId: s.workspaceId } });
  if (!it) return { ok: false as const, error: '集成不存在' };
  const { diagnoseBot } = await import('@/lib/bot/diagnose');
  const r = await diagnoseBot(it.provider, it.webhookUrl, it.inboundKey, readBotSecrets(it.secretsEnc), { lastInboundAt: it.lastInboundAt });
  return { ok: true as const, ...r };
}

export async function actTestBot(id: string) {
  const s = await getSession();
  requireRole(s, 'byok.manage');
  const r = await testPush(id, s.workspaceId);
  revalidatePath('/settings/keys');
  revalidatePath('/notifications');
  return r;
}

export async function actToggleBot(id: string, enabled: boolean) {
  const s = await getSession();
  requireRole(s, 'byok.manage');
  await prisma.botIntegration.updateMany({ where: { id, workspaceId: s.workspaceId }, data: { enabled } });
  revalidatePath('/settings/keys');
  revalidatePath('/notifications');
  return { ok: true };
}

/**
 * 为渠道绑定/解绑出面的智能体（「为渠道选一个智能体」，2026-09-01）。
 * templateId 空串/null = 解绑，回到通用运营助手。
 * 只认本租户可见的模板（内置或自建）——不校验的话，填别人租户的模板 id
 * 就能把别家的职责说明拉进自己群里当身份用。
 */
export async function actSetBotAgent(id: string, templateId: string | null) {
  const s = await getSession();
  requireRole(s, 'byok.manage');
  const clean = (templateId ?? '').trim() || null;
  if (clean) {
    const tpl = await prisma.workflowTemplate.findFirst({
      where: { id: clean, OR: [{ isBuiltin: true }, { tenantId: s.tenantId }] },
      select: { id: true },
    });
    if (!tpl) return { ok: false, error: '这个智能体不存在或不属于当前工作区' };
  }
  const r = await prisma.botIntegration.updateMany({
    where: { id, workspaceId: s.workspaceId },
    data: { agentTemplateId: clean },
  });
  if (r.count === 0) return { ok: false, error: '机器人不存在' };
  revalidatePath('/settings/keys');
  return { ok: true };
}

export async function actDeleteBot(id: string) {
  const s = await getSession();
  requireRole(s, 'byok.manage');
  await prisma.botIntegration.deleteMany({ where: { id, workspaceId: s.workspaceId } });
  revalidatePath('/settings/keys');
  revalidatePath('/notifications');
  return { ok: true };
}


// ── 群聊列表同步（2026-09-02）──
// 飞书自建应用能列出机器人所在的全部群（im/v1/chats，要 im:chat:readonly——推送用的那份权限里已经有）。
// 消息事件里没有群名，不同步的话渠道页只能显示一串 oc_ 开头的 id。
// 只做 upsert 不做删除：机器人被移出群后这里仍留着那条记录（有历史消息计数），标不标「已退出」以后再说。
export async function actSyncBotChats(id: string): Promise<{ ok: boolean; synced?: number; error?: string }> {
  const s = await getSession();
  requireRole(s, 'byok.manage');
  const it = await prisma.botIntegration.findFirst({ where: { id, workspaceId: s.workspaceId } });
  if (!it) return { ok: false, error: '集成不存在' };
  if (it.provider !== 'feishu' || !it.inboundKey) return { ok: false, error: '只有飞书自建应用能列出机器人所在的群；别的渠道从收到的消息里认' };
  const secrets = readBotSecrets(it.secretsEnc);
  if (!secrets.appSecret) return { ok: false, error: '没有保存 App Secret' };
  const { feishuTenantAccessToken, feishuListBotChats } = await import('@/lib/bot/feishu');
  const { token, error } = await feishuTenantAccessToken(it.inboundKey, secrets.appSecret);
  if (!token) return { ok: false, error: `取 tenant_access_token 失败：${error ?? ''}` };
  const r = await feishuListBotChats(token);
  if (r.error) return { ok: false, error: r.error };
  let synced = 0;
  for (const c of r.chats) {
    await prisma.botConversation.upsert({
      where: { integrationId_chatId: { integrationId: it.id, chatId: c.id } },
      create: { workspaceId: it.workspaceId, integrationId: it.id, chatId: c.id, chatType: 'group', chatName: c.name || null, turnsAt: new Date(0) },
      update: { chatType: 'group', ...(c.name ? { chatName: c.name } : {}) },
    }).catch(() => {});
    synced++;
  }
  revalidatePath('/settings/keys');
  revalidatePath('/notifications');
  return { ok: true, synced };
}

// ── 微信（官方 iLink 机器人接口，2026-09-02）────────────────────────────────
// 扫码即绑：拿码 → 用户在微信里扫 → 状态接口回 bot_token → 落库成一条 BotIntegration。
// 没有任何凭据要用户填；也没有形态闸——这是微信官方接口，SaaS 一样能用。

/** 拿一张登录二维码。返回内联 SVG（lib/pay/qr 零依赖编码）与轮询用的 qrcode 键。 */
export async function actWechatIlinkQr(): Promise<{ ok: boolean; qrcode?: string; qrSvg?: string; error?: string }> {
  const s = await getSession();
  requireRole(s, 'byok.manage');
  const r = await ilinkGetQr();
  if (!r.ok || !r.qrcode || !r.qrUrl) return { ok: false, error: r.error ?? '拿二维码失败' };
  return { ok: true, qrcode: r.qrcode, qrSvg: renderQrSvg(r.qrUrl, { size: 220, label: '微信绑定二维码' }) };
}

/**
 * 等扫码。微信那头会 hold 到状态变化或约 35 秒——前端按序 await，不叠定时器。
 * confirmed 时在这里落库：inboundKey = wxilink_<bot_id>（同一个微信重新扫得到同一个 bot_id，
 * 所以换号=换键、同号=更新同一条），token/游标/绑定成员一并写进加密 secrets。
 */
export async function actWechatIlinkStatus(
  qrcode: string,
  input: { existingId?: string; agentTemplateId?: string | null } = {},
): Promise<{ ok: boolean; status?: string; id?: string; error?: string }> {
  const s = await getSession();
  requireRole(s, 'byok.manage');
  const r = await ilinkQrStatus(qrcode);
  if (!r.ok) return { ok: false, error: r.error ?? '查扫码状态失败' };
  if (r.status !== 'confirmed') return { ok: true, status: r.status };
  if (!r.botToken || !r.botId) return { ok: false, error: 'iLink 已确认但没下发 bot_token / bot_id' };

  const inboundKey = `wxilink_${r.botId}`;
  const byKey = await prisma.botIntegration.findUnique({ where: { inboundKey } });
  if (byKey && byKey.workspaceId !== s.workspaceId) return { ok: false, error: '这个微信已经绑在别的工作区，先去那边解绑' };
  const existing = input.existingId
    ? await prisma.botIntegration.findFirst({ where: { id: input.existingId, workspaceId: s.workspaceId, provider: 'wechat' } })
    : byKey;
  if (input.existingId && !existing) return { ok: false, error: '机器人不存在' };
  if (existing && byKey && byKey.id !== existing.id) return { ok: false, error: '这个微信已绑在另一条机器人上，先删掉那条再扫' };

  const prev: BotSecrets = existing ? readBotSecrets(existing.secretsEnc) : {};
  // 新登录态 = 新会话：游标清空（微信侧 -14 后的官方口径也是「清本地状态重新登录」），expired 清掉
  const secrets: BotSecrets = {
    ...prev,
    ilinkBotToken: r.botToken,
    ilinkBotId: r.botId,
    ilinkUserId: r.userId ?? prev.ilinkUserId,
    ilinkBaseUrl: r.baseUrl || undefined,
    ilinkCursor: '',
    ilinkExpired: false,
    boundMemberId: s.memberId,
  };

  let agentTemplateId: string | null | undefined = undefined;
  if (input.agentTemplateId !== undefined) {
    const clean = (input.agentTemplateId ?? '').trim() || null;
    if (clean) {
      const tpl = await prisma.workflowTemplate.findFirst({ where: { id: clean, OR: [{ isBuiltin: true }, { tenantId: s.tenantId }] }, select: { id: true } });
      if (!tpl) return { ok: false, error: '选的智能体不存在或不属于当前工作区' };
    }
    agentTemplateId = clean;
  }

  let id = existing?.id ?? '';
  try {
    if (existing) {
      await prisma.botIntegration.update({
        where: { id: existing.id },
        data: { inboundKey, secretsEnc: writeBotSecrets(secrets), enabled: true, lastError: null, ...(agentTemplateId !== undefined ? { agentTemplateId } : {}) },
      });
    } else {
      id = (await prisma.botIntegration.create({
        data: {
          workspaceId: s.workspaceId,
          provider: 'wechat',
          label: '微信',
          webhookUrl: null,
          inboundKey,
          secretsEnc: writeBotSecrets(secrets),
          pushEvents: toJson([]),
          pushSchedule: '09:00',
          ...(agentTemplateId !== undefined ? { agentTemplateId } : {}),
        },
      })).id;
    }
  } catch {
    return { ok: false, error: '保存失败' };
  }
  revalidatePath('/settings/keys');
  revalidatePath('/notifications');
  return { ok: true, status: 'confirmed', id };
}
