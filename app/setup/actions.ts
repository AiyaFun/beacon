'use server';

import { cookies, headers } from 'next/headers';
import { prisma } from '@/lib/db';
import { AUTH_COOKIE, createSession } from '@/lib/auth';
import { AUTH_COOKIE_MAX_AGE_S, authCookieSecure } from '@/lib/auth-constants';
import { checkRateLimit, getClientIp, ipKey, retryHint } from '@/lib/ratelimit';
import { encryptKey } from '@/lib/crypto';
import { llmVendor } from '@/lib/constants';
import { writeBotSecrets } from '@/lib/bot';
import { generateIngestToken } from '@/lib/ingest/token';
import { LEGAL_VERSION } from '@/lib/legal';
import { assertSetupAllowed, SetupClosedError, resetInitializedCache } from '@/lib/setup/state';
import { edition } from '@/lib/edition';

// 装机向导的服务端动作。
//
// 【为什么是「一次性提交」而不是逐步保存】
// 向导要建的是一整套互相依赖的东西：租户 → 工作区 → owner → 模型渠道 → 机器人。
// 逐步保存的话，任何一步失败都会留下半套数据，而此时**还没有任何管理员能进去收拾**——
// 库里已经有了 Member，`isInitialized()` 就变成 true，向导自己也进不去了，只能重装。
// 所以全部字段在客户端收齐，服务端一个事务写完，要么全成要么全不成。

// 装机口令闸门：同 IP 每 10 分钟 10 次。口令由安装脚本随机生成（32 位 hex），
// 本身不可爆破；这道闸挡的是「局域网里有人对着这一页乱试」把日志刷满。
const SETUP_LIMIT = { limit: 10, windowMs: 600_000 };

export type SetupInput = {
  token: string;
  companyName: string;
  adminName: string;
  llm: { vendor: string; apiKey: string; model?: string };
  /** OA 可以留到装完再配（有些客户装机时还没建好企业应用）。 */
  oa?: {
    provider: 'feishu' | 'dingtalk' | 'wecom';
    appId: string;
    appSecret: string;
    verificationToken?: string;
    encryptKey?: string;
    corpId?: string;
    webhookUrl?: string;
  };
};

export type SetupResult = {
  ok: boolean;
  message?: string;
  /** 装完直接给用户看的采集令牌（插件设置页要粘贴它）。只在这一次返回。 */
  ingestToken?: string;
};

export async function actCompleteSetup(input: SetupInput): Promise<SetupResult> {
  const h = await headers();
  const rl = await checkRateLimit(ipKey('setup:complete', getClientIp(h)), SETUP_LIMIT);
  if (!rl.ok) return { ok: false, message: `尝试过于频繁，请${retryHint(rl.resetAt)}再试` };

  try {
    await assertSetupAllowed(input.token);
  } catch (err) {
    if (err instanceof SetupClosedError) return { ok: false, message: err.message };
    throw err;
  }

  const companyName = input.companyName?.trim() || '我的团队';
  const adminName = input.adminName?.trim() || '管理员';

  // 模型渠道：向导只让用户从白名单里**选厂商**，baseUrl 一律取白名单里的值。
  // 这里刻意不走 checkVendorEndpoint —— 那个函数是给「用户提交了 baseUrl」的表单用的，
  // 而向导根本不提供这个输入框，端点没有任何用户可控的余地。
  const v = llmVendor(input.llm?.vendor ?? '');
  if (!v) return { ok: false, message: `模型厂商不在支持列表里：${input.llm?.vendor ?? '(空)'}` };
  const apiKey = input.llm?.apiKey?.trim() ?? '';
  if (apiKey.length < 8) return { ok: false, message: '请填写有效的模型 API Key' };

  const ingestToken = generateIngestToken();

  const memberId = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      // plan=enterprise：企业版没有套餐概念，但 plan 字段在很多地方参与判断，
      // 给最高档避免它在某处被当成 free 限流。配额本身已由 quotaEnabled() 关掉。
      data: { name: companyName, plan: 'enterprise', status: 'active' },
    });
    const workspace = await tx.workspace.create({
      data: { tenantId: tenant.id, name: companyName, ingestToken },
    });
    const member = await tx.member.create({
      data: {
        tenantId: tenant.id,
        name: adminName,
        role: 'owner',
        status: 'active',
        // 装机者即本实例的运营者，装机这一步就是他对法律文本的确认动作。
        consentAt: new Date(),
        consentVersion: LEGAL_VERSION,
      },
    });
    await tx.modelProvider.create({
      data: {
        tenantId: tenant.id,
        label: v.name,
        vendor: v.key,
        baseUrl: v.baseUrl,
        apiKeyEnc: encryptKey(apiKey),
        model: input.llm.model?.trim() || v.model,
        region: v.region,
        isDefault: true,
        status: 'untested',
      },
    });
    if (input.oa?.appId && input.oa?.appSecret) {
      await tx.botIntegration.create({
        data: {
          workspaceId: workspace.id,
          provider: input.oa.provider,
          label: `${companyName} 企业应用`,
          enabled: true,
          webhookUrl: input.oa.webhookUrl?.trim() || null,
          inboundKey: input.oa.appId.trim(),
          secretsEnc: writeBotSecrets({
            appSecret: input.oa.appSecret.trim(),
            verificationToken: input.oa.verificationToken?.trim() || undefined,
            encryptKey: input.oa.encryptKey?.trim() || undefined,
            corpId: input.oa.corpId?.trim() || undefined,
          }),
        },
      });
    }
    return member.id;
  });

  // 事务成功之后才认「已初始化」——中途失败时缓存必须还是 false，否则向导再也进不来。
  resetInitializedCache();

  const token = await createSession(memberId, h.get('user-agent') ?? undefined);
  const store = await cookies();
  store.set(AUTH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: authCookieSecure(),
    path: '/',
    maxAge: AUTH_COOKIE_MAX_AGE_S,
  });

  return { ok: true, ingestToken };
}

/** 只校验口令，给向导第一步做即时反馈（不写任何数据）。 */
export async function actCheckSetupToken(token: string): Promise<{ ok: boolean; message?: string }> {
  const h = await headers();
  const rl = await checkRateLimit(ipKey('setup:token', getClientIp(h)), SETUP_LIMIT);
  if (!rl.ok) return { ok: false, message: `尝试过于频繁，请${retryHint(rl.resetAt)}再试` };
  try {
    await assertSetupAllowed(token);
    return { ok: true };
  } catch (err) {
    if (err instanceof SetupClosedError) return { ok: false, message: err.message };
    throw err;
  }
}

/** 给页面显示「这是哪个版本」。 */
export async function actEdition(): Promise<string> {
  return edition();
}
