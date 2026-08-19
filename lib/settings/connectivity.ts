import { prisma } from '../db';
import { decryptKey } from '../crypto';
import { parseJson } from '../json';
import { looksNonChatModel } from '../constants';
import { pingProvider } from '../llm/connectivity';
import { imageConfigured, imageSource, imageMisroutedVendor } from '../llm/image';
import { embedderInfo } from '../vector/embed';
import { readBotSecrets } from '../bot';
import { listIngestTokens } from '../ingest/token';
import { wxAccessToken, resetWxTokenCache } from '../publish/wechat-mp';

// ── 一键检测：把这个工作区所有「接入」挨个探一遍 ──────────────────────────────
//
// 【一条硬要求：不许有副作用】检测是用户随手点的，一次点击不该
//   · 往他的群里发一条测试消息（机器人「测试发送」是另一个按钮，那是用户明确要发）；
//   · 真出一张图（图像按张计费，点一下检测花掉几毛钱是荒唐的）；
//   · 改动任何配置。
// 所以这里只做两类事：**换取凭证**（token 类，平台侧无痕）与**读本地状态**。
// 做不到静默检测的（纯 Webhook 机器人）如实说「测不了，只能发一条试」，不假装绿灯。

export type CheckRow = {
  /** 分组：给界面分块用 */
  group: 'model' | 'image' | 'publish' | 'bot' | 'ingest' | 'vector';
  name: string;
  /** ok=通 | warn=能用但有话说 / 测不了 | fail=不通 | idle=没配（不算错） */
  state: 'ok' | 'warn' | 'fail' | 'idle';
  detail: string;
  /** 怎么修（只在 fail/warn 时给） */
  fix?: string;
};

export type CheckReport = { rows: CheckRow[]; ranAt: string };

export async function checkTenantConnections(ctx: {
  tenantId: string;
  workspaceId: string;
  accountId: string;
}): Promise<CheckReport> {
  const [providers, wxCred, bots, tokens] = await Promise.all([
    prisma.modelProvider.findMany({ where: { tenantId: ctx.tenantId }, orderBy: { createdAt: 'asc' } }),
    prisma.publishCredential.findUnique({
      where: { accountId_platform: { accountId: ctx.accountId, platform: 'wechat' } },
    }),
    prisma.botIntegration.findMany({ where: { workspaceId: ctx.workspaceId } }),
    listIngestTokens(ctx.workspaceId),
  ]);

  const rows: CheckRow[] = [];

  // ── 模型渠道：逐条真 ping（这一步会烧极少量 token，是用户点检测时可预期的）──
  if (providers.length === 0) {
    rows.push({
      group: 'model',
      name: '模型渠道',
      state: 'idle',
      detail: '没有配置自己的 Key，AI 功能走平台默认渠道或示例内容',
      fix: '在下方「模型渠道」添加一条，用你自己的模型账号',
    });
  } else {
    const pings = await Promise.all(
      providers.map(async (p) => {
        const routing = parseJson<Record<string, string>>(p.routing, {});
        const nonChat = routing.image === p.id || routing.video === p.id || looksNonChatModel(p.model);
        const r = await pingProvider({
          label: p.label,
          baseUrl: p.baseUrl,
          apiKey: decryptKey(p.apiKeyEnc),
          model: p.model,
          nonChat,
        });
        // 顺手把状态写回去：用户点一次检测，列表上的小圆点也该跟着变
        await prisma.modelProvider.update({ where: { id: p.id }, data: { status: r.status } }).catch(() => {});
        return { p, r, nonChat };
      }),
    );
    for (const { p, r, nonChat } of pings) {
      rows.push({
        group: 'model',
        name: `模型渠道 · ${p.label}`,
        state: r.ok ? (nonChat ? 'warn' : 'ok') : 'fail',
        detail: r.detail,
        fix: r.ok ? undefined : '检查 Key 是否有效、模型名是否拼对、账号是否欠费',
      });
    }
  }

  // ── 生图：只看「配没配得上」，**不真出图**（按张计费）──
  const [imgOk, imgSrc, misrouted] = await Promise.all([
    imageConfigured(ctx.tenantId),
    imageSource(ctx.tenantId),
    imageMisroutedVendor(),
  ]);
  if (misrouted) {
    rows.push({
      group: 'image',
      name: '生图渠道',
      state: 'fail',
      detail: `平台把「封面生图」指到了「${misrouted}」，但生图只能走火山方舟（即梦）`,
      fix: '让平台管理员把「封面生图」改指到一条火山方舟渠道',
    });
  } else if (imgOk) {
    rows.push({
      group: 'image',
      name: '生图渠道',
      state: 'warn',
      detail: `已就绪（${imgSrc === 'platform' ? '用平台渠道，走平台额度' : '用你自己的方舟 Key'}）· 检测不真出图，避免产生费用`,
    });
  } else {
    rows.push({
      group: 'image',
      name: '生图渠道',
      state: 'idle',
      detail: '没有可用的生图渠道，封面与配图无法生成',
      fix: '加一条「火山引擎 豆包」渠道即可（同一把方舟 Key 文本/生图通用）',
    });
  }

  // ── 公众号发布凭证：换一次 access_token（平台侧无痕，不发任何内容）──
  if (!wxCred) {
    rows.push({ group: 'publish', name: '公众号发布通道', state: 'idle', detail: '未配置，公众号只能手动发布' });
  } else {
    resetWxTokenCache(); // 不能拿上一枚缓存的 token 蒙混过关
    const r = await wxAccessToken(wxCred.appId, decryptKey(wxCred.appSecretEnc));
    await prisma.publishCredential
      .update({
        where: { id: wxCred.id },
        data: { status: r.ok ? 'ok' : 'failed', lastError: r.ok ? null : r.error.slice(0, 300) },
      })
      .catch(() => {});
    rows.push({
      group: 'publish',
      name: '公众号发布通道',
      state: r.ok ? 'ok' : 'fail',
      detail: r.ok ? '凭证有效，可直发草稿箱' : r.error,
      fix: r.ok ? undefined : '多半是服务器 IP 不在公众号后台的白名单里，或 AppSecret 重置过',
    });
  }

  // ── 机器人：只换 token，不发消息 ──
  if (bots.length === 0) {
    rows.push({ group: 'bot', name: '机器人', state: 'idle', detail: '未配置' });
  } else {
    for (const b of bots) {
      rows.push(await checkBot(b));
    }
  }

  // ── 采集令牌：本地判定，不走网络 ──
  const active = tokens.active.length;
  rows.push({
    group: 'ingest',
    name: '插件采集令牌',
    state: active > 0 ? 'ok' : 'idle',
    detail: active > 0 ? `${active} 枚生效中` : '还没签发令牌，插件无法回传数据',
    fix: active > 0 ? undefined : '在下方「插件采集令牌」签发一枚，填进插件设置',
  });

  // ── 语义向量：读实况，不走网络 ──
  const embed = embedderInfo();
  rows.push({
    group: 'vector',
    name: '语义向量',
    state: embed.mocked ? 'warn' : 'ok',
    detail: embed.mocked ? '未配嵌入模型，记忆召回与话题聚类按字面相似度近似' : `真实嵌入模型：${embed.model}`,
    fix: embed.mocked ? '配置嵌入模型后召回质量会明显变好（服务端 env）' : undefined,
  });

  return { rows, ranAt: new Date().toISOString() };
}

async function checkBot(b: {
  id: string;
  provider: string;
  label: string;
  webhookUrl: string | null;
  inboundKey: string | null;
  secretsEnc: string;
  enabled: boolean;
}): Promise<CheckRow> {
  const name = `机器人 · ${b.label}`;
  if (!b.enabled) return { group: 'bot', name, state: 'idle', detail: '已停用' };

  const sec = readBotSecrets(b.secretsEnc);
  try {
    if (b.provider === 'feishu' && b.inboundKey && sec.appSecret) {
      const { feishuTenantAccessToken } = await import('../bot/feishu');
      const r = await feishuTenantAccessToken(b.inboundKey, sec.appSecret);
      return r.token
        ? { group: 'bot', name, state: 'ok', detail: '自建应用凭据有效' }
        : { group: 'bot', name, state: 'fail', detail: r.error ?? '换取 token 失败', fix: '核对 App ID / App Secret' };
    }
    if (b.provider === 'dingtalk' && b.inboundKey && sec.appSecret) {
      const { getDingtalkAccessToken } = await import('../bot/dingtalk');
      const r = await getDingtalkAccessToken(b.inboundKey, sec.appSecret);
      return r.token
        ? { group: 'bot', name, state: 'ok', detail: '自建应用凭据有效' }
        : { group: 'bot', name, state: 'fail', detail: r.error ?? '换取 token 失败', fix: '核对 AppKey / AppSecret' };
    }
    if (b.provider === 'wecom' && sec.corpId && sec.appSecret) {
      const { getWecomAccessToken } = await import('../bot/wecom');
      const r = await getWecomAccessToken(sec.corpId, sec.appSecret);
      return r.token
        ? { group: 'bot', name, state: 'ok', detail: '自建应用凭据有效' }
        : { group: 'bot', name, state: 'fail', detail: r.error ?? '换取 token 失败', fix: '核对 CorpID / Secret' };
    }
  } catch (e) {
    return { group: 'bot', name, state: 'fail', detail: (e as Error).message.slice(0, 120) };
  }

  // 纯 Webhook：唯一的验证方式就是**真发一条**，那有副作用，不放进一键检测。
  if (b.webhookUrl) {
    return {
      group: 'bot',
      name,
      state: 'warn',
      detail: 'Webhook 模式无法静默检测（验证它只能真发一条消息）',
      fix: '用这一条上的「测试发送」按钮，会往群里发一条测试消息',
    };
  }
  return { group: 'bot', name, state: 'fail', detail: '既没有 Webhook 地址，也没有自建应用凭据' };
}
