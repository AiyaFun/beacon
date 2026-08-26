import { headers } from 'next/headers';
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { parseJson } from '@/lib/json';
import { maskKey } from '@/lib/crypto';
import { readBotSecrets } from '@/lib/bot';
import { Card, Stat } from '@/components/ui';
import { Icon } from '@/components/icons';
import { BotIntegrationCard, type BotRow } from '../settings/BotIntegrationCard';
import { HubHeader } from '@/components/HubHeader';

export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  const s = await getSession();
  const botIntegrations = await prisma.botIntegration.findMany({
    where: { workspaceId: s.workspaceId },
    orderBy: { createdAt: 'asc' },
  });

  // 获取请求的基础 Origin（用于生成飞书回调地址）
  const h = await headers();
  const proto = h.get('x-forwarded-proto') ?? 'https';
  const host = h.get('host');
  const callbackBase = (host ? `${proto}://${host}` : process.env.BEACON_PUBLIC_URL || 'https://beacon.iyunci.cn').replace(/\/$/, '');

  const botRows: BotRow[] = botIntegrations.map((b) => {
    const secrets = readBotSecrets(b.secretsEnc);
    return {
      id: b.id,
      provider: b.provider,
      label: b.label,
      enabled: b.enabled,
      webhookUrl: b.webhookUrl,
      inboundKey: b.inboundKey,
      pushEvents: parseJson<string[]>(b.pushEvents, []),
      pushSchedule: b.pushSchedule || '09:00',
      // 空数组 = 从未配置 = 默认全开（语义见 lib/bot/types.isCommandAllowed）
      allowCommands: parseJson<string[]>(b.allowCommands, []),
      // AgentId 不是密钥，回显它编辑时才不会「凭空消失」；真密钥只回传「有没有」。
      agentId: secrets.agentId ?? null,
      hasSignSecret: !!secrets.signSecret,
      hasAppSecret: !!secrets.appSecret,
      hasVerificationToken: !!secrets.verificationToken,
      hasEncryptKey: !!secrets.encryptKey,
      // 掩码随页面下发；明文点「👁 显示」时才按需取（见 actRevealBotSecrets）
      maskedSignSecret: maskKey(secrets.signSecret ?? ''),
      maskedAppSecret: maskKey(secrets.appSecret ?? ''),
      maskedVerificationToken: maskKey(secrets.verificationToken ?? ''),
      maskedEncryptKey: maskKey(secrets.encryptKey ?? ''),
      hasInboundSecrets: !!(secrets.appSecret || secrets.verificationToken || secrets.agentId),
      lastOutboundAt: b.lastOutboundAt ? b.lastOutboundAt.toISOString() : null,
      lastInboundAt: b.lastInboundAt ? b.lastInboundAt.toISOString() : null,
      lastError: b.lastError,
    };
  });

  const activeCount = botRows.filter((r) => r.enabled).length;

  return (
    <>
      <HubHeader
        title="机器人与消息通知"
        hint="推送什么、什么时候推、群里能用哪些命令 · 机器人的密钥填在「接入与密钥」"
        action={
          <span className="row" style={{ gap: 8 }}>
            <Link href="/settings/keys" className="btn btn-sm btn-primary"><Icon.cpu size={13} /> 接入与密钥</Link>
            <Link href="/help" className="btn btn-sm btn-ghost"><Icon.help size={13} /> 配置说明</Link>
          </span>
        }
      />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="已配置机器人" value={botRows.length} foot="支持多群配置" />
        <Stat label="启用中机器人" value={activeCount} foot="实时在线监测" />
        <Stat label="出站推送通道" value="已支持" foot="自定义 Webhook" />
        <Stat label="入站 ChatOps" value="已支持" foot="飞书消息接收" />
      </div>

      <Card
        title="配置机器人 / 消息通知"
        sub="支持出站消息推送与入站 ChatOps 交互"
        style={{ marginBottom: 16 }}
        action={<span className="badge badge-brand"><Icon.chat size={13} /> 出站推送 + 入站 ChatOps</span>}
      >
        {botRows.length === 0 && (
          <div className="alert-gradient-amber" style={{ padding: '10px 14px', marginBottom: 12 }}>
            <span className="small">
              还没有机器人。<b>先去「接入与密钥」把机器人凭据填上</b>（Webhook 地址或自建应用的 App Secret），
              填完这一页就能配推送内容与时间。
              <Link href="/settings/keys" style={{ color: 'var(--brand)', fontWeight: 600, marginLeft: 4 }}>去填 →</Link>
            </span>
          </div>
        )}
        <p className="small muted" style={{ marginBottom: 12, lineHeight: 1.7 }}>
          <b>出站推送</b>：把每日选题推荐、热点刷新、合规拦截告警、学习小结自动推到飞书群——只要粘贴群自定义机器人 webhook。
          <br />
          <b>入站收录 (ChatOps)</b>：在群里发竞对/文章链接即收录成选题，发 <code className="mono">/热点</code> <code className="mono">/选题</code> <code className="mono">/采集</code> <code className="mono">/优化</code> 直接驱动内容引擎（收录进候选池、生成仍全程过合规、不自动发布）。
          <br />
          <b>群里 @ 它对话</b>：直接 @机器人 提问就能连着聊（记得住上下文，带你的人设与真实数据回答）；发 <code className="mono">/分析</code> 给账号做一次数据体检并拿到反馈，<code className="mono">/账号 名字</code> 指定这个群管的是哪个号。
          <a href="/help" style={{ color: 'var(--brand)', fontWeight: 600, marginLeft: 4 }}>📖 详细设置步骤 →</a>
        </p>
        <BotIntegrationCard rows={botRows} callbackBase={callbackBase} />
      </Card>
    </>
  );
}
