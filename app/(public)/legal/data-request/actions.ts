'use server';

import { headers } from 'next/headers';
import { prisma } from '@/lib/db';
import { PLATFORMS } from '@/lib/constants';
import { normalizeRemovalTarget } from '@/lib/legal/removal';
import { checkRateLimit, getClientIp, ipKey, retryHint } from '@/lib/ratelimit';

// F9-4 被监控账号移除申请（公开入口）。
// 这是 (public) 组里唯一允许的写操作：只向全局 DataRemovalRequest 表增一条低风险记录，
// 不碰租户配额、不触发 LLM、不越权读任何租户数据——是《个人信息保护法》处理已公开
// 个人信息时权利人拒绝权的落地入口，必须对未登录的被监控主体开放。
const VALID_PLATFORMS = new Set(Object.keys(PLATFORMS));

export async function actSubmitDataRemoval(input: {
  platform: string;
  handle: string;
  contact: string;
  reason?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const platform = (input.platform || '').trim();
  const handle = (input.handle || '').trim().slice(0, 200);
  const contact = (input.contact || '').trim().slice(0, 100);
  const reason = (input.reason || '').trim().slice(0, 1000);

  if (!VALID_PLATFORMS.has(platform)) return { ok: false, error: '请选择有效平台' };
  if (handle.length < 2) return { ok: false, error: '请填写被监控账号的主页链接或标识' };
  if (contact.length < 4) return { ok: false, error: '请留下有效联系方式，便于我们回复处理结果' };

  // 频率限制。这是**未登录、无验证码**的公开写入口，而一条 pending 申请就会让全平台
  // 停采该账号——不限流的话，改个联系方式即可绕过去重反复提交，
  // 批量刷热门账号就能让所有租户的竞对监控集体失明（去重键含 contact，挡不住这条路）。
  // 真实的权利人一次就够，5 次/小时对正常使用绰绰有余。
  const ip = getClientIp(await headers());
  const rl = await checkRateLimit(ipKey('legal:removal', ip), { limit: 5, windowMs: 3600_000 });
  if (!rl.ok) return { ok: false, error: `提交过于频繁，请${retryHint(rl.resetAt)}再试；如有紧急情况请直接联系客服` };

  // 归一化成与 CompetitorAccount.handle 同口径：申请人通常贴整条主页 URL，
  // 而采集侧存的是纯 handle。不归一的话执行闸永远匹配不上，等于白收申请。
  const target = normalizeRemovalTarget(platform, handle);

  // 去重：同账号同联系人未处理的申请只留一条，避免重复提交刷库
  const existing = await prisma.dataRemovalRequest.findFirst({
    where: { platform: target.platform, handle: target.handle, contact, status: 'pending' },
  });
  if (existing) return { ok: false, error: '你已提交过该账号的移除申请，我们正在处理中' };

  await prisma.dataRemovalRequest.create({
    data: { platform: target.platform, handle: target.handle, contact, reason: reason || null },
  });
  return { ok: true };
}
