'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { requireRole } from '@/lib/rbac';
import {
  isValidPhone,
  requestLoginCode,
  consumeVerificationCode,
  bindPhoneToMember,
  unbindPhoneFromMember,
  unbindWechatFromMember,
} from '@/lib/auth';
import { assertNotDemo } from '@/lib/demo/guard';
import { checkRateLimit, getClientIp, ipKey, retryHint } from '@/lib/ratelimit';
import { isProd } from '@/lib/env';
import { getSmsProvider } from '@/lib/sms/provider';
import { encryptKey, decryptKey } from '@/lib/crypto';
import { channelOf } from '@/lib/publish/capability';
import { OpenAICompatibleProvider } from '@/lib/llm/openai-compatible';
import { checkVendorEndpoint, canUseOverseas, LLM_FUNCTIONS, looksNonChatModel } from '@/lib/constants';
import { pingProvider } from '@/lib/llm/connectivity';
import { parseJson } from '@/lib/json';

// F12 模型接入(BYOK)：渠道 CRUD + 连通性测试 + 按功能路由。
// 合规约束（PRD §10.5 / research-11 §4）：region=overseas 仅限企业版 + 出海场景，生成出口仍过合规检测。
// 权限：BYOK 关系到租户钱包与合规责任，仅 owner/admin 可改（byok.manage）。

// ── 添加 provider（BYOK 渠道）──
export async function actAddProvider(data: {
  label: string;
  vendor: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}) {
  const s = await getSession();
  requireRole(s, 'byok.manage');
  const label = String(data.label ?? '').trim();
  const apiKey = String(data.apiKey ?? '').trim();
  const model = String(data.model ?? '').trim();
  if (!label || !apiKey || !model) {
    return { ok: false, error: '请填全 名称 / API Key / 模型名' };
  }
  // ── 端点锁定（PRD §6 F12-1 验收①③ / §10.5 L3「任意端点永不开放」）──
  // server action 就是公开 RPC，客户端的下拉框拦不住任何人；白名单必须在这里焊死。
  const check = checkVendorEndpoint(String(data.vendor ?? ''), String(data.baseUrl ?? '').trim());
  if (!check.ok) return { ok: false, error: check.error };
  const vendor = check.vendor;
  // region 由供应商强绑，不接受用户入参——否则海外端点报个 cn 就绕过了下面的 plan 闸
  const region = vendor.region;
  if (region === 'overseas' && !canUseOverseas(s.plan)) {
    return { ok: false, error: '海外模型渠道仅企业版的出海内容场景可用——当前套餐请先选择国内已备案的供应商（DeepSeek/Qwen/Kimi/GLM）' };
  }
  // 首个渠道自动设为默认
  const existing = await prisma.modelProvider.count({ where: { tenantId: s.tenantId } });
  await prisma.modelProvider.create({
    data: {
      tenantId: s.tenantId,
      label,
      vendor: vendor.key,
      baseUrl: vendor.baseUrl, // 存平台预置值，不存用户提交的字符串
      apiKeyEnc: encryptKey(apiKey), // 信封加密入库，界面永不回显明文
      model,
      region,
      status: 'untested',
      isDefault: existing === 0,
    },
  });
  revalidatePath('/settings/keys');
  return { ok: true };
}

// ── 连通性测试：用该配置构造最小调用，探测可用性 ──
//
// 【为什么不能对图像/视频模型直接判 failed】测试发的是 chat/completions 的 ping。
// 如果这条渠道填的是即梦（doubao-seedream-*）这类**图像模型**，chat 端点必然报错——
// 但那说明的是「这个模型不是对话模型」，不是「这个 Key 不能用」。而 status='failed' 会被
// lib/llm/image.ts 的 resolveImageProvider 与 gateway 的视频解析直接排除（两处都过滤 not:'failed'），
// 于是用户明明配好了 Key，封面却报「还没有可用的生图渠道」——配了却用不了，还查不出为什么。
//
// 所以这里按错误性质分流：**认证类错误**（401/403/invalid api key…）才是真的坏，判 failed；
// 其它错误（模型不存在、参数不合法…）对非对话模型是预期之内，判 ok 并如实说明「没做出图实测」。
// 不做真实出图实测是有意的：一次出图要真花钱，点一下「连通性测试」不该扣用户的钱。
// 'use server' 文件只能导出 async 函数，所以判据放 lib/constants.ts（那里也是端点白名单的家）。
export async function actTestProvider(id: string) {
  const s = await getSession();
  requireRole(s, 'byok.manage');
  const p = await prisma.modelProvider.findFirst({ where: { id, tenantId: s.tenantId } });
  if (!p) return { ok: false, error: '渠道不存在' };
  const routing = parseJson<Record<string, string>>(p.routing, {});
  // 显式路由到图像/视频，或模型名一看就不是对话模型 → 按「非对话模型」口径判定
  const nonChat = routing.image === p.id || routing.video === p.id || looksNonChatModel(p.model);
  // 判定逻辑收在 lib/llm/connectivity.ts（租户设置 / 运维台 / 一键检测三处共用同一份）
  const r = await pingProvider({
    label: p.label,
    baseUrl: p.baseUrl,
    apiKey: decryptKey(p.apiKeyEnc),
    model: p.model,
    nonChat,
  });
  await prisma.modelProvider.update({ where: { id: p.id }, data: { status: r.status } });
  revalidatePath('/settings/keys');
  return { ok: r.ok, status: r.status, detail: r.ok && r.detail === '连通正常' ? '' : r.detail };
}

// ── 按功能路由：把某个功能指到某条渠道 ──
//
// 【修的是什么】ModelProvider.routing 此前**全仓只读不写**：设置页显示「图像 → 平台托管默认」，
// 提示文案还教用户「把某个豆包渠道路由到图像」，但界面上根本没有能路由的地方——是一句做不到的承诺。
//
// 存储口径沿用读侧（lib/llm/gateway.ts / image.ts）：渠道自己的 routing JSON 里存 `{fn: 自己的 id}`，
// 所以指定 fn→P 要做两件事：把 fn 从其它渠道的 routing 里摘掉，再写进 P 的 routing。
// providerId 传空串 = 取消指定，回落到默认渠道/平台托管。
export async function actSetRouting(fn: string, providerId: string) {
  const s = await getSession();
  requireRole(s, 'byok.manage');
  if (!(LLM_FUNCTIONS as readonly string[]).includes(fn)) return { ok: false, error: '未知的功能' };

  const providers = await prisma.modelProvider.findMany({ where: { tenantId: s.tenantId } });
  const target = providerId ? providers.find((p) => p.id === providerId) : null;
  if (providerId && !target) return { ok: false, error: '渠道不存在' };
  // 图像/视频只能走火山方舟：读侧（image.ts:resolveImageProvider / gateway.ts:resolveVideoProvider）
  // 只在 vendor='doubao' 里挑，指到别家等于指了个不会被采纳的值——与其静默无效，不如当场说清楚。
  if (target && (fn === 'image' || fn === 'video') && target.vendor !== 'doubao') {
    return { ok: false, error: `${fn === 'image' ? '封面生图' : '视频理解'}只能用「火山引擎 豆包」渠道` };
  }

  await Promise.all(
    providers.map((p) => {
      const routing = parseJson<Record<string, string>>(p.routing, {});
      const shouldHave = target?.id === p.id;
      const has = routing[fn] === p.id;
      if (shouldHave === has) return null; // 无变化，不写库
      if (shouldHave) routing[fn] = p.id;
      else delete routing[fn];
      return prisma.modelProvider.update({ where: { id: p.id }, data: { routing: JSON.stringify(routing) } });
    }).filter(Boolean) as Promise<unknown>[],
  );
  revalidatePath('/settings/keys');
  return { ok: true };
}

// ── 删除渠道 ──
export async function actDeleteProvider(id: string) {
  const s = await getSession();
  requireRole(s, 'byok.manage');
  await prisma.modelProvider.deleteMany({ where: { id, tenantId: s.tenantId } });
  revalidatePath('/settings/keys');
  return { ok: true };
}

// ── 设为默认渠道 ──
export async function actSetDefault(id: string) {
  const s = await getSession();
  requireRole(s, 'byok.manage');
  await prisma.modelProvider.updateMany({ where: { tenantId: s.tenantId }, data: { isDefault: false } });
  await prisma.modelProvider.updateMany({ where: { id, tenantId: s.tenantId }, data: { isDefault: true } });
  revalidatePath('/settings/keys');
  return { ok: true };
}

// ── 插件采集令牌（竞对监控 authorized 通道，方案三）──
// 浏览器插件回传数据时的鉴权凭证。签发/吊销都要 competitor.manage
// （与竞对监控页同一权限——令牌授权的正是"补充竞对数据"这件事）。
//
// 2026-07-30 起**按设备签发**（lib/ingest/token.ts）：此前整个工作区共用一枚，
// 吊销只有全有或全无两档——成员离职、设备丢了、只想收回自己那一台，全都做不到。

export async function actIssueIngestToken(force = false) {
  const s = await getSession();
  requireRole(s, 'competitor.manage');
  const { issueIngestToken, deviceLabelFromUA } = await import('@/lib/ingest/token');
  // 标签在服务端按 UA 生成，不接受客户端自报：那是要进「已授权设备」列表的说明字段，
  // 让客户端填 = 一个可以随便伪造、看起来却很权威的名字。
  const label = deviceLabelFromUA((await headers()).get('user-agent'));
  const r = await issueIngestToken({ workspaceId: s.workspaceId, memberId: s.memberId, label, force });
  revalidatePath('/settings/keys');
  revalidatePath('/extension');
  return { ok: true as const, ...r };
}

export async function actRevokeIngestToken(id: string) {
  const s = await getSession();
  requireRole(s, 'competitor.manage');
  const { revokeIngestToken } = await import('@/lib/ingest/token');
  const r = await revokeIngestToken(s.workspaceId, id, `由 ${s.memberName} 手动吊销`);
  revalidatePath('/settings/keys');
  revalidatePath('/extension');
  return r;
}

/**
 * 只吊销旧的工作区级令牌（Workspace.ingestToken）。
 * 单独一个 action 而不是给 actRevokeIngestToken 传个哨兵 id：那一枚不在 IngestToken 表里，
 * 混在同一个入口里迟早写出「按 id 查不到就当成 legacy」这种猜法。
 */
export async function actRevokeLegacyIngestToken() {
  const s = await getSession();
  requireRole(s, 'competitor.manage');
  await prisma.workspace.updateMany({ where: { id: s.workspaceId }, data: { ingestToken: null } });
  revalidatePath('/settings/keys');
  revalidatePath('/extension');
  return { ok: true };
}

/** 停用采集：一枚不剩地全部吊销，含旧的工作区级令牌。 */
export async function actDisableIngestToken() {
  const s = await getSession();
  requireRole(s, 'competitor.manage');
  const { revokeAllIngestTokens } = await import('@/lib/ingest/token');
  const r = await revokeAllIngestTokens(s.workspaceId, `由 ${s.memberName} 全部停用`);
  revalidatePath('/settings/keys');
  revalidatePath('/extension');
  return { ok: true, ...r };
}

// ── 账号与安全：绑定手机号 / 微信 ──────────────────────────────
// 微信绑定走 OAuth 流（/api/auth/wechat/redirect?mode=bind → callback 落库），
// 这里只有手机号绑定的两个 action。操作对象是"自己的 member 行"，不动租户资源，
// 故不加 requireRole——任何角色都可以给自己的账号补登录方式。演示租户除外。

export async function actRequestBindPhoneCode(phone: string) {
  const s = await getSession();
  assertNotDemo(s.tenantId);
  const p = String(phone ?? '').trim();
  if (!isValidPhone(p)) return { ok: false, message: '手机号格式不正确' };
  // 占用提前查：给用户即时反馈，省一条真实短信。唯一约束仍是最终裁判（bindPhoneToMember）。
  const existing = await prisma.member.findUnique({ where: { phone: p }, select: { id: true } });
  if (existing && existing.id !== s.memberId) {
    return { ok: false, message: '该手机号已注册其他账号，如需合并请联系客服' };
  }
  // IP 限流：同登录发码口径（真实短信按条计费；dev Mock 通道不烧钱不限）。
  if (isProd() || !getSmsProvider().mocked) {
    const ip = getClientIp(await headers());
    const rl = await checkRateLimit(ipKey('bind:send', ip), { limit: 10, windowMs: 3600_000 });
    if (!rl.ok) return { ok: false, message: `操作过于频繁，请${retryHint(rl.resetAt)}再试` };
  }
  return requestLoginCode(p);
}

export async function actBindPhone(phone: string, code: string) {
  const s = await getSession();
  assertNotDemo(s.tenantId);
  const p = String(phone ?? '').trim();
  const ip = getClientIp(await headers());
  const rl = await checkRateLimit(ipKey('bind:verify', ip), { limit: 20, windowMs: 600_000 });
  if (!rl.ok) return { ok: false, message: `验证尝试过于频繁，请${retryHint(rl.resetAt)}再试` };
  const codeCheck = await consumeVerificationCode(p, String(code ?? '').trim());
  if (!codeCheck.ok) return codeCheck;
  const bound = await bindPhoneToMember(s.memberId, p);
  if (bound.ok) revalidatePath('/settings/account');
  return bound;
}

export async function actUnbindPhone() {
  const s = await getSession();
  assertNotDemo(s.tenantId);
  const r = await unbindPhoneFromMember(s.memberId);
  if (r.ok) revalidatePath('/settings/account');
  return r;
}

export async function actUnbindWechat() {
  const s = await getSession();
  assertNotDemo(s.tenantId);
  const r = await unbindWechatFromMember(s.memberId);
  if (r.ok) revalidatePath('/settings/account');
  return r;
}

// 邮箱绑定已下线（2026-07-30）：产品决定不铺邮件通道，到期/账单提醒改走
// 「站内通知 + 顶部横幅 + 机器人推送」三条腿（见 lib/jobs/handlers.ts plan_expiry_notice
// 与 components/ExpiryBanner.tsx）。发票沟通仍用 billing 页上的客服微信/邮箱（静态联系方式）。

// ── 发布通道凭证（目前只有微信公众号用得上）──────────────────────────────────
//
// AppSecret 与模型 Key 同一套信封加密入库，界面永不回显明文。
// 权限收在 byok.manage：它与「模型 Key」是同一类东西——一把能代表你去调平台接口的凭证。
export async function actSavePublishCredential(data: {
  platform: string;
  appId: string;
  appSecret: string;
  /** 仅微博：正文必须带的那条回链（微博强制要求在应用安全域名之下） */
  linkUrl?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const s = await getSession();
  requireRole(s, 'byok.manage');
  // 能填凭证的平台 = 能力矩阵里 channel==='api' 的那些。写死清单会漂：
  // 加了一个接口直发平台却忘了改这里，用户填不进去，还以为是自己填错了。
  if (channelOf(data.platform) !== 'api') return { ok: false, error: '这个平台没有官方接口直发通道，填了也用不上' };
  const appId = data.appId.trim();
  const appSecret = data.appSecret.trim();
  if (!appId || !appSecret) return { ok: false, error: '两个凭证字段都要填' };
  const linkUrl = (data.linkUrl ?? '').trim();
  // 微博的硬要求：正文必须带一条安全域名下的链接。填错格式当场拦下，
  // 别等到发的时候被微博 20032 打回来（那时用户已经以为发出去了）。
  if (data.platform === 'weibo' && linkUrl && !/^https?:\/\/[^\s]+$/.test(linkUrl)) {
    return { ok: false, error: '回链地址要是完整链接（http(s):// 开头），且必须在你微博应用的「安全域名」之下' };
  }

  await prisma.publishCredential.upsert({
    where: { accountId_platform: { accountId: s.accountId, platform: data.platform } },
    create: {
      accountId: s.accountId,
      platform: data.platform,
      appId,
      appSecretEnc: encryptKey(appSecret),
      status: 'untested',
      linkUrl: linkUrl || null,
    },
    // 改了 AppKey/Secret 就把旧 token 作废：那把 token 是用旧应用换的，留着只会发到别的号上去
    update: {
      appId,
      appSecretEnc: encryptKey(appSecret),
      status: 'untested',
      lastError: null,
      linkUrl: linkUrl || null,
      tokenEnc: null,
      tokenExpiresAt: null,
      externalUid: null,
    },
  });
  revalidatePath('/settings/keys');
  return { ok: true };
}

export async function actDeletePublishCredential(platform: string): Promise<{ ok: boolean; error?: string }> {
  const s = await getSession();
  requireRole(s, 'byok.manage');
  await prisma.publishCredential.deleteMany({ where: { accountId: s.accountId, platform } });
  revalidatePath('/settings/keys');
  return { ok: true };
}

/** 连通性测试：只换一次 access_token，不发任何内容（测试不该有副作用）。 */
export async function actTestPublishCredential(platform: string): Promise<{ ok: boolean; error?: string; detail?: string }> {
  const s = await getSession();
  requireRole(s, 'byok.manage');
  const cred = await prisma.publishCredential.findUnique({
    where: { accountId_platform: { accountId: s.accountId, platform } },
  });
  if (!cred) return { ok: false, error: '还没配置这个平台的凭证' };

  // 微博没有「不发内容也能验一次」的接口：换 token 要用户授权、发一条就是真发出去了。
  // 所以这里**如实说测不了**，而不是假装测过（一键检测那条铁律：不发测试消息、不真出图）。
  if (platform === 'weibo') {
    if (!cred.tokenEnc) return { ok: false, error: '还没授权微博账号，点上面的「授权微博」走一次授权' };
    const left = cred.tokenExpiresAt ? Math.floor((cred.tokenExpiresAt.getTime() - Date.now()) / 86_400_000) : null;
    if (left !== null && left <= 0) return { ok: false, error: '微博授权已过期，需要重新授权' };
    return {
      ok: true,
      detail: `已授权${cred.externalUid ? `（微博 uid ${cred.externalUid}）` : ''}${left !== null ? `，约 ${left} 天后过期` : ''}。微博没有无副作用的测试接口，这里只核对授权状态，不发测试内容。`,
    };
  }
  if (platform !== 'wechat') return { ok: false, error: '这个平台还没有可测的接口' };

  const { wxAccessToken, resetWxTokenCache } = await import('@/lib/publish/wechat-mp');
  resetWxTokenCache(); // 测试要打真实请求，不能被上一枚缓存的 token 蒙混过关
  const r = await wxAccessToken(cred.appId, decryptKey(cred.appSecretEnc));
  await prisma.publishCredential.update({
    where: { id: cred.id },
    data: { status: r.ok ? 'ok' : 'failed', lastError: r.ok ? null : r.error.slice(0, 300) },
  });
  revalidatePath('/settings/keys');
  return r.ok ? { ok: true, detail: '凭证有效，可以直发草稿箱' } : { ok: false, error: r.error };
}
