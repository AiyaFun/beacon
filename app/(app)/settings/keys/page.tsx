import { headers } from 'next/headers';
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { parseJson } from '@/lib/json';
import { decryptKey, maskKey } from '@/lib/crypto';
import { readBotSecrets } from '@/lib/bot';
import { can } from '@/lib/rbac';
import { LLM_FUNCTIONS, type LlmFunction, looksNonChatModel } from '@/lib/constants';
import { listIngestTokens } from '@/lib/ingest/token';
import { Card, Stat, Empty } from '@/components/ui';
import { Icon } from '@/components/icons';
import { ProviderForm } from '../ProviderForm';
import { ProviderRow } from '../ProviderRow';
import { FunctionRouting } from '../FunctionRouting';
import { IngestTokenCard } from '../IngestTokenCard';
import { PublishChannelCard, type CredView } from '../PublishChannelCard';
import { BotIntegrationCard, type BotRow } from '../BotIntegrationCard';
import { CheckAllCard } from './CheckAllCard';
import { HubHeader } from '@/components/HubHeader';

export const dynamic = 'force-dynamic';

// 接入与密钥：**这个产品里所有要填 Key 的地方，都在这一页**。
//
// 【为什么合并】此前它们散在三处：模型 Key 与采集令牌在「模型与设置」，机器人密钥在
// 「机器人与通知」，公众号 AppSecret 又被塞在「数据源」那张卡片里（位置纯属历史意外）。
// 用户要配一套接入，得在三个页面之间来回找；而「哪些接入还没配 / 配了通不通」
// 在任何一页都看不全。合并之后，这一页回答两个问题：**填在哪**、**通不通**。
//
// 运行类设置（自动化任务、数据源、语义向量）留在 /settings —— 那些不是密钥，
// 混进来只会让这一页重新变长。

const VENDOR_LABEL: Record<string, string> = {
  deepseek: 'DeepSeek', qwen: '通义千问', kimi: 'Kimi', glm: '智谱 GLM',
  hunyuan: '腾讯混元', doubao: '字节豆包', baichuan: '百川智能', minimax: 'MiniMax',
  yi: '零一万物', spark: '讯飞星火', stepfun: '阶跃星辰', sensenova: '商汤日日新',
  openai: 'OpenAI', claude: 'Claude', gemini: 'Gemini', groq: 'Groq',
  mistral: 'Mistral AI', perplexity: 'Perplexity', together: 'Together AI',
  deepinfra: 'DeepInfra', custom: '自定义',
};

const STATUS_META: Record<string, { dot: string; text: string }> = {
  ok: { dot: 'dot-green', text: '连通正常' },
  failed: { dot: 'dot-red', text: '连通失败' },
  untested: { dot: 'dot-amber', text: '未测试' },
};

const FN_META: Record<LlmFunction, { name: string; tier: string; desc: string; overridable: boolean }> = {
  scoring: { name: '选题打分', tier: '便宜小模型', desc: '高频调用，用便宜模型控成本；要求支持 JSON 输出', overridable: true },
  generation: { name: '内容生成', tier: '强模型', desc: '各平台变体生成，质量优先，用旗舰模型', overridable: true },
  advisor: { name: '智囊团会诊', tier: '强模型', desc: '12 人物多视角推理，低频高价值', overridable: true },
  compliance: { name: '合规复检', tier: '跟随生成', desc: '并入生成调用；出口过滤始终由平台侧执行', overridable: false },
  chat: { name: 'AI 助手对话', tier: '中档模型', desc: '交互式问答；执行模式不单独配的话也走这条', overridable: true },
  diagnosis: { name: '算法教练诊断/优化', tier: '中档模型', desc: '创作工坊实时诊断的 LLM 优化与教练点评', overridable: true },
  video: { name: '视频理解', tier: '仅火山方舟', desc: '视频拆解只走你自己的豆包渠道（平台不垫付：一次视频抵几十次文本）', overridable: true },
  image: { name: '封面生图', tier: '火山方舟即梦', desc: 'AI 封面与正文配图走即梦，自动复用你的任一豆包渠道的 Key，无需单独配置', overridable: true },
  // 【不配也能跑，配了才更稳】执行模式必须稳定地发**结构化工具调用**，而这件事各家模型
  // 差别很大：会把调用写成正文的模型，用户看到的是「它说做了，其实没做」。
  // 不指这一项就沿用「AI 助手对话」那条，行为与以前完全一致。
  agent: { name: '执行模式（任务台派活）', tier: '会用工具的模型', desc: '不配就跟随「AI 助手对话」。派活时它要连续调用工具，模型对 function calling 的支持越稳越好', overridable: true },
};

export default async function KeysPage() {
  const s = await getSession();
  const canManage = can(s.role, 'byok.manage');

  const h = await headers();
  const proto = h.get('x-forwarded-proto') ?? 'https';
  const host = h.get('host');
  const callbackBase = (host ? `${proto}://${host}` : process.env.BEACON_PUBLIC_URL || 'https://beacon.iyunci.cn').replace(/\/$/, '');

  const [providers, workspace, ingestTokens, pubCreds, botIntegrations] = await Promise.all([
    prisma.modelProvider.findMany({ where: { tenantId: s.tenantId }, orderBy: { createdAt: 'asc' } }),
    prisma.workspace.findUnique({ where: { id: s.workspaceId }, select: { ingestToken: true } }),
    listIngestTokens(s.workspaceId),
    // 走官方接口的平台都在这一张表里（公众号 / 微博），一次取回来按平台分
    prisma.publishCredential.findMany({
      where: { accountId: s.accountId },
      select: {
        platform: true,
        appId: true,
        status: true,
        lastError: true,
        linkUrl: true,
        externalUid: true,
        tokenExpiresAt: true,
      },
    }),
    prisma.botIntegration.findMany({ where: { workspaceId: s.workspaceId }, orderBy: { createdAt: 'asc' } }),
  ]);
  const credOf = (platform: string): CredView => {
    const c = pubCreds.find((x) => x.platform === platform);
    return c ? { ...c, tokenExpiresAt: c.tokenExpiresAt ? c.tokenExpiresAt.toISOString() : null } : null;
  };
  const wxCred = credOf('wechat');
  const wbCred = credOf('weibo');

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
      allowCommands: parseJson<string[]>(b.allowCommands, []),
      agentId: secrets.agentId ?? null,
      hasSignSecret: !!secrets.signSecret,
      hasAppSecret: !!secrets.appSecret,
      hasVerificationToken: !!secrets.verificationToken,
      hasEncryptKey: !!secrets.encryptKey,
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

  // 「连通正常」只数真的通过对话测试的：图像/视频渠道没做过实调用，算进来就是虚报
  const okCount = providers.filter((p) => p.status === 'ok' && !looksNonChatModel(p.model)).length;
  const arkCount = providers.filter((p) => p.vendor === 'doubao').length;

  const routedProviderId = (fn: LlmFunction): string => {
    for (const p of providers) {
      const routing = parseJson<Record<string, string>>(p.routing, {});
      if (routing[fn] === p.id) return p.id;
    }
    return '';
  };
  const routableProviders = providers.map((p) => ({ id: p.id, label: p.label, vendor: p.vendor, status: p.status }));

  return (
    <>
      <HubHeader
        title="接入与密钥"
        hint="模型 Key、生图、发布通道、采集令牌、机器人——所有要填 Key 的地方都在这一页"
        action={<Link href="/settings" className="btn btn-sm btn-ghost"><Icon.settings size={13} /> 运行设置</Link>}
      />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="模型渠道" value={providers.length} foot={`${okCount} 条连通正常`} />
        <Stat label="生图能力" value={arkCount > 0 ? '已就绪' : '未配'} foot={arkCount > 0 ? '复用你的方舟 Key' : '需要一条火山方舟渠道'} />
        <Stat
          label="发布通道"
          value={[wxCred && '公众号', wbCred && '微博'].filter(Boolean).join(' · ') || '未配'}
          foot="公众号写草稿箱 · 微博直接发出"
        />
        <Stat label="机器人" value={botRows.filter((b) => b.enabled).length} foot={`共 ${botRows.length} 个`} />
      </div>

      <CheckAllCard readOnly={!canManage} />

      <Card
        title="模型渠道（BYOK）"
        sub="加密存储 · 只写不读 · 用你自己的 AI 账号，平台只收工具钱"
        style={{ marginBottom: 16 }}
        action={<span className="badge badge-brand"><Icon.cpu size={13} /> OpenAI 兼容协议</span>}
      >
        {providers.length === 0 ? (
          <Empty icon="🔌" text="还没有配置模型渠道，用下方表单添加你的第一把 Key" />
        ) : (
          <div className="stack" style={{ gap: 12, marginBottom: 18 }}>
            {providers.map((p) => {
              // 图像/视频模型的 status='ok' 只表示「没有理由判它坏」——连通性测试对它们
              // 走的是「不判 failed」那条路，并没有真的验通。如实标成「出图时验证」，
              // 不然一个连不上的端点也会显示「连通正常」。
              const nonChat = looksNonChatModel(p.model);
              const st = p.status === 'ok' && nonChat
                ? { dot: 'dot-amber', text: '出图时验证' }
                : (STATUS_META[p.status] ?? STATUS_META.untested);
              const masked = maskKey(decryptKey(p.apiKeyEnc));
              return (
                <div key={p.id} className="card" style={{ padding: 14, boxShadow: 'none', background: 'var(--surface-2)' }}>
                  <div className="row-between wrap" style={{ gap: 10 }}>
                    <div className="row wrap" style={{ gap: 10, alignItems: 'center' }}>
                      <b>{p.label}</b>
                      <span className="badge badge-gray">{VENDOR_LABEL[p.vendor] ?? p.vendor}</span>
                      {p.region === 'overseas'
                        ? <span className="badge badge-amber">海外·限企业版</span>
                        : <span className="badge badge-green">国内已备案</span>}
                      {p.isDefault && <span className="badge badge-brand">默认</span>}
                      <span className="row" style={{ gap: 5, alignItems: 'center' }}>
                        <span className={`dot ${st.dot}`} />
                        <span className="small muted">{st.text}</span>
                      </span>
                    </div>
                  </div>
                  <div className="wrap small muted mono" style={{ gap: 14, margin: '8px 0 10px' }}>
                    <span>模型 {p.model}</span>
                    <span>Key {masked}</span>
                    <span>{p.baseUrl}</span>
                  </div>
                  <ProviderRow id={p.id} isDefault={p.isDefault} />
                </div>
              );
            })}
          </div>
        )}

        <div className="divider" />
        <div className="card-title" style={{ margin: '4px 0 12px' }}>
          添加渠道 <span className="card-sub">从白名单供应商选择</span>
        </div>
        <ProviderForm />

        <div className="divider" style={{ margin: '18px 0 12px' }} />
        <div className="card-title" style={{ marginBottom: 6 }}>
          按功能路由 <span className="card-sub">打分用便宜的，写稿用好的；未指定的走默认渠道</span>
        </div>
        <div className="stack" style={{ gap: 8 }}>
          {LLM_FUNCTIONS.map((fn) => {
            const m = FN_META[fn];
            return (
              <div key={fn} className="row-between wrap" style={{ gap: 8, padding: '8px 0', borderTop: '1px solid var(--surface-2)' }}>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                    <b className="small">{m.name}</b>
                    <span className="badge badge-gray">{m.tier}</span>
                    {!m.overridable && <span className="badge badge-amber">不可覆盖</span>}
                  </div>
                  <div className="small muted" style={{ marginTop: 3 }}>{m.desc}</div>
                </div>
                {m.overridable ? (
                  <FunctionRouting
                    fn={fn}
                    current={routedProviderId(fn)}
                    providers={routableProviders}
                    doubaoOnly={fn === 'image' || fn === 'video'}
                  />
                ) : (
                  <span className="small mono">跟随生成</span>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      <PublishChannelCard wechat={wxCred} weibo={wbCred} readOnly={!canManage} />

      <Card
        title="插件采集令牌"
        sub="浏览器插件用它回传数据 · 一枚令牌只授权「写入本工作区」这一件事"
        style={{ marginBottom: 16 }}
      >
        <p className="small muted" style={{ marginBottom: 10, lineHeight: 1.7 }}>
          <Link href="/extension" style={{ color: 'var(--brand)', fontWeight: 600 }}>下载并安装「烽火台采集助手」→</Link>
          （Chrome / Edge / 360 / Brave），把下方令牌填进插件设置。
          它也是「一键发布」把内容交给插件、以及插件上报解析失效样本用的同一枚令牌。
        </p>
        <IngestTokenCard active={ingestTokens.active} revoked={ingestTokens.revoked} legacyToken={workspace?.ingestToken ?? null} />
      </Card>

      <Card
        title="机器人接入"
        sub="飞书 / 钉钉 / 企微：出站推送 + 入站 ChatOps"
        style={{ marginBottom: 16 }}
        action={<Link href="/notifications" className="btn btn-sm btn-ghost">推送什么、什么时候推 →</Link>}
      >
        <p className="small muted" style={{ marginBottom: 12, lineHeight: 1.7 }}>
          这里只管<b>凭据</b>（Webhook 地址、App Secret 等）。<b>推送哪些事件、几点推、群里能用哪些命令</b>
          在每条机器人的展开项里配，整体说明见
          <Link href="/help" style={{ color: 'var(--brand)', fontWeight: 600, marginLeft: 4 }}>使用帮助 →</Link>
        </p>
        <BotIntegrationCard rows={botRows} callbackBase={callbackBase} />
      </Card>

      <Card title="合规边界" sub="用自己的 Key，不等于平台不管合规">
        <div className="stack" style={{ gap: 10 }}>
          <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <Icon.shield size={16} className="" />
            <span className="small">
              <b>国内公开发布的内容，默认用已备案模型。</b>面向境内公众提供 AI 生成服务的责任方始终是烽火台，不因 Key 是谁的而改变。
            </span>
          </div>
          <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <Icon.x size={16} className="" />
            <span className="small">
              <b>海外模型只开放给企业版的出海内容场景。</b>数据出境前需先完成合规审查与脱敏；Key 是否有效、供应商条款怎么约定，由你自己负责。
            </span>
          </div>
          <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <Icon.check size={16} className="" />
            <span className="small">
              <b>内容离开平台前，永远先过合规检测。</b>红线词库 + AI 二次复核 + AIGC 标识 + 日志留存都在平台侧执行；自备 Key 只改变谁付模型的钱，不改变谁对发出去的内容负责。
            </span>
          </div>
          <div className="alert-gradient-amber" style={{ padding: '10px 14px', marginTop: 4 }}>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <span className="row" style={{ color: 'var(--amber)', flexShrink: 0 }}>
                <Icon.shield size={16} />
              </span>
              <span className="small" style={{ opacity: 0.9 }}>
                不支持自由填写任意中转地址接境外模型——那属于无资质 API 中转，产品层面不开放。
              </span>
            </div>
          </div>
        </div>
      </Card>
    </>
  );
}
