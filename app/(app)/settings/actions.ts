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
import { OpenAICompatibleProvider } from '@/lib/llm/openai-compatible';
import { checkVendorEndpoint, canUseOverseas } from '@/lib/constants';

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
  revalidatePath('/settings');
  return { ok: true };
}

// ── 连通性测试：用该配置构造最小调用，探测可用性 ──
export async function actTestProvider(id: string) {
  const s = await getSession();
  requireRole(s, 'byok.manage');
  const p = await prisma.modelProvider.findFirst({ where: { id, tenantId: s.tenantId } });
  if (!p) return { ok: false, error: '渠道不存在' };
  const provider = new OpenAICompatibleProvider({
    name: p.label,
    baseUrl: p.baseUrl,
    apiKey: decryptKey(p.apiKeyEnc),
    model: p.model,
  });
  let status: 'ok' | 'failed' = 'failed';
  let detail = '';
  try {
    const r = await provider.complete([{ role: 'user', content: 'ping' }], { temperature: 0 });
    status = r.text.length >= 0 ? 'ok' : 'failed';
  } catch (e) {
    status = 'failed';
    detail = (e as Error).message.slice(0, 120);
  }
  await prisma.modelProvider.update({ where: { id: p.id }, data: { status } });
  revalidatePath('/settings');
  return { ok: status === 'ok', status, detail };
}

// ── 删除渠道 ──
export async function actDeleteProvider(id: string) {
  const s = await getSession();
  requireRole(s, 'byok.manage');
  await prisma.modelProvider.deleteMany({ where: { id, tenantId: s.tenantId } });
  revalidatePath('/settings');
  return { ok: true };
}

// ── 设为默认渠道 ──
export async function actSetDefault(id: string) {
  const s = await getSession();
  requireRole(s, 'byok.manage');
  await prisma.modelProvider.updateMany({ where: { tenantId: s.tenantId }, data: { isDefault: false } });
  await prisma.modelProvider.updateMany({ where: { id, tenantId: s.tenantId }, data: { isDefault: true } });
  revalidatePath('/settings');
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
  revalidatePath('/settings');
  revalidatePath('/extension');
  return { ok: true as const, ...r };
}

export async function actRevokeIngestToken(id: string) {
  const s = await getSession();
  requireRole(s, 'competitor.manage');
  const { revokeIngestToken } = await import('@/lib/ingest/token');
  const r = await revokeIngestToken(s.workspaceId, id, `由 ${s.memberName} 手动吊销`);
  revalidatePath('/settings');
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
  revalidatePath('/settings');
  revalidatePath('/extension');
  return { ok: true };
}

/** 停用采集：一枚不剩地全部吊销，含旧的工作区级令牌。 */
export async function actDisableIngestToken() {
  const s = await getSession();
  requireRole(s, 'competitor.manage');
  const { revokeAllIngestTokens } = await import('@/lib/ingest/token');
  const r = await revokeAllIngestTokens(s.workspaceId, `由 ${s.memberName} 全部停用`);
  revalidatePath('/settings');
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
  if (bound.ok) revalidatePath('/settings');
  return bound;
}

export async function actUnbindPhone() {
  const s = await getSession();
  assertNotDemo(s.tenantId);
  const r = await unbindPhoneFromMember(s.memberId);
  if (r.ok) revalidatePath('/settings');
  return r;
}

export async function actUnbindWechat() {
  const s = await getSession();
  assertNotDemo(s.tenantId);
  const r = await unbindWechatFromMember(s.memberId);
  if (r.ok) revalidatePath('/settings');
  return r;
}

// 邮箱绑定已下线（2026-07-30）：产品决定不铺邮件通道，到期/账单提醒改走
// 「站内通知 + 顶部横幅 + 机器人推送」三条腿（见 lib/jobs/handlers.ts plan_expiry_notice
// 与 components/ExpiryBanner.tsx）。发票沟通仍用 billing 页上的客服微信/邮箱（静态联系方式）。
