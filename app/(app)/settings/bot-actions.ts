'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { requireRole } from '@/lib/rbac';
import { toJson, parseJson } from '@/lib/json';
import { readBotSecrets, writeBotSecrets, testPush } from '@/lib/bot';
import { BOT_PROVIDERS, PUSH_EVENTS, sanitizeAllowCommands, type BotSecrets } from '@/lib/bot/types';

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
};

export async function actSaveBot(data: SaveInput) {
  const s = await getSession();
  requireRole(s, 'byok.manage');

  const provider = String(data.provider ?? '').trim();
  if (!SUPPORTED.has(provider)) return { ok: false, error: '暂不支持该平台机器人' };

  // 两种接入模式互斥：选了自建应用就不留 webhook，反之亦然。
  // 不这么收口的话，编辑态会把旧值原样带回来，库里两种并存，推送选路只能靠优先级去赌。
  const mode = data.botMode;
  const webhookUrl = mode === 'app' ? '' : String(data.webhookUrl ?? '').trim();
  const appId = mode === 'webhook' ? '' : String(data.appId ?? '').trim();
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

  const pushEvents = (data.pushEvents ?? []).filter((e) => VALID_EVENTS.has(e));
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
    corpId: provider === 'wecom' ? ((data.appId ?? '').trim() || prevSecrets.corpId) : prevSecrets.corpId,
    agentId: (data.agentId ?? '').trim() || prevSecrets.agentId,
  };

  // 企微 inboundKey 用 corpId_agentId 组合保证全局唯一
  const agentIdVal = (data.agentId ?? '').trim();
  let inboundKey = appId || null;
  if (provider === 'wecom' && appId && agentIdVal) {
    inboundKey = `${appId}_${agentIdVal}`;
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
  revalidatePath('/settings');
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
  const r = await diagnoseBot(it.provider, it.webhookUrl, it.inboundKey, readBotSecrets(it.secretsEnc));
  return { ok: true as const, ...r };
}

export async function actTestBot(id: string) {
  const s = await getSession();
  requireRole(s, 'byok.manage');
  const r = await testPush(id, s.workspaceId);
  revalidatePath('/settings');
  return r;
}

export async function actToggleBot(id: string, enabled: boolean) {
  const s = await getSession();
  requireRole(s, 'byok.manage');
  await prisma.botIntegration.updateMany({ where: { id, workspaceId: s.workspaceId }, data: { enabled } });
  revalidatePath('/settings');
  return { ok: true };
}

export async function actDeleteBot(id: string) {
  const s = await getSession();
  requireRole(s, 'byok.manage');
  await prisma.botIntegration.deleteMany({ where: { id, workspaceId: s.workspaceId } });
  revalidatePath('/settings');
  return { ok: true };
}
