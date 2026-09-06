import { headers } from 'next/headers';
import { backgroundSchedulerRuns } from '@/lib/jobs/queue';
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { parseJson } from '@/lib/json';
import { decryptKey, maskKey } from '@/lib/crypto';
import { readBotSecrets } from '@/lib/bot';
import { loadBotChats } from '@/lib/bot/overview';
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
import { getServerLang } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';

const VENDOR_LABEL: Record<string, { zh: string; en: string }> = {
  deepseek: { zh: 'DeepSeek', en: 'DeepSeek' },
  qwen: { zh: '通义千问', en: 'Tongyi Qwen' },
  kimi: { zh: 'Kimi', en: 'Kimi' },
  glm: { zh: '智谱 GLM', en: 'Zhipu GLM' },
  hunyuan: { zh: '腾讯混元', en: 'Tencent Hunyuan' },
  doubao: { zh: '字节豆包', en: 'ByteDance Doubao' },
  baichuan: { zh: '百川智能', en: 'Baichuan' },
  minimax: { zh: 'MiniMax', en: 'MiniMax' },
  yi: { zh: '零一万物', en: '01.AI' },
  spark: { zh: '讯飞星火', en: 'iFlytek Spark' },
  stepfun: { zh: '阶跃星辰', en: 'StepFun' },
  sensenova: { zh: '商汤日日新', en: 'SenseNova' },
  openai: { zh: 'OpenAI', en: 'OpenAI' },
  claude: { zh: 'Claude', en: 'Claude' },
  gemini: { zh: 'Gemini', en: 'Gemini' },
  groq: { zh: 'Groq', en: 'Groq' },
  mistral: { zh: 'Mistral AI', en: 'Mistral AI' },
  perplexity: { zh: 'Perplexity', en: 'Perplexity' },
  together: { zh: 'Together AI', en: 'Together AI' },
  deepinfra: { zh: 'DeepInfra', en: 'DeepInfra' },
  custom: { zh: '自定义', en: 'Custom' },
};

const STATUS_META: Record<string, { dot: string; textZh: string; textEn: string }> = {
  ok: { dot: 'dot-green', textZh: '连通正常', textEn: 'Connected' },
  failed: { dot: 'dot-red', textZh: '连通失败', textEn: 'Failed' },
  untested: { dot: 'dot-amber', textZh: '未测试', textEn: 'Untested' },
};

const FN_META: Record<LlmFunction, { name: string; nameEn: string; tier: string; tierEn: string; desc: string; descEn: string; overridable: boolean }> = {
  scoring: { name: '选题打分', nameEn: 'Topic Scoring', tier: '便宜小模型', tierEn: 'Cost-Effective Small Model', desc: '高频调用，用便宜模型控成本；要求支持 JSON 输出', descEn: 'High-frequency calls, cost-effective; requires JSON output support', overridable: true },
  generation: { name: '内容生成', nameEn: 'Content Generation', tier: '强模型', tierEn: 'Flagship Model', desc: '各平台变体生成，质量优先，用旗舰模型', descEn: 'Platform-specific variations, quality prioritized', overridable: true },
  advisor: { name: '智囊团会诊', nameEn: 'Advisor Council', tier: '强模型', tierEn: 'Flagship Model', desc: '12 人物多视角推理，低频高价值', descEn: '12-persona multi-angle reasoning, high value', overridable: true },
  compliance: { name: '合规复检', nameEn: 'Compliance Re-check', tier: '跟随生成', tierEn: 'Follows Generation', desc: '并入生成调用；出口过滤始终由平台侧执行', descEn: 'Merged into generation; outbound filtering enforced by platform', overridable: false },
  chat: { name: 'AI 助手对话', nameEn: 'AI Assistant Chat', tier: '中档模型', tierEn: 'Mid-Tier Model', desc: '交互式问答；执行模式不单独配的话也走这条', descEn: 'Interactive Q&A; execution mode defaults to this if unassigned', overridable: true },
  diagnosis: { name: '算法教练诊断/优化', nameEn: 'Algorithm Coach Diagnosis', tier: '中档模型', tierEn: 'Mid-Tier Model', desc: '创作工坊实时诊断的 LLM 优化与教练点评', descEn: 'Real-time studio diagnostics & coach reviews', overridable: true },
  video: { name: '视频理解', nameEn: 'Video Understanding', tier: '仅火山方舟', tierEn: 'Volcengine Ark Only', desc: '视频拆解只走你自己的豆包渠道（平台不垫付：一次视频抵几十次文本）', descEn: 'Video breakdown uses your Doubao channel (platform does not advance costs)', overridable: true },
  image: { name: '封面生图', nameEn: 'Cover Image Gen', tier: '火山方舟即梦', tierEn: 'Volcengine Jimeng', desc: 'AI 封面与正文配图走即梦，自动复用你的任一豆包渠道的 Key，无需单独配置', descEn: 'AI covers and post images use Jimeng, auto-reusing any Doubao channel key', overridable: true },
  agent: { name: '执行模式（任务台派活）', nameEn: 'Agent Mode (Task Dispatch)', tier: '会用工具的模型', tierEn: 'Tool-Use Model', desc: '不配就跟随「AI 助手对话」。派活时它要连续调用工具，模型对 function calling 的支持越稳越好', descEn: 'Defaults to AI Assistant Chat. Requires solid function calling support for sequential tool use', overridable: true },
};

export default async function KeysPage() {
  const [s, lang] = await Promise.all([getSession(), getServerLang()]);
  const isEn = lang === 'en';
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

  // 渠道卡上的智能体下拉：本租户可见的全部模板（内置+自建）。
  // 只取 id/name/emoji——persona 在对话时由 router 现查，别把长文本塞进每次页面渲染。
  const agentOptions = (await prisma.workflowTemplate.findMany({
    where: { OR: [{ isBuiltin: true }, { tenantId: s.tenantId }] },
    orderBy: [{ isBuiltin: 'desc' }, { createdAt: 'asc' }],
    select: { id: true, name: true, emoji: true },
  })).map((t) => ({ id: t.id, name: `${t.emoji} ${t.name}` }));

  // 会话画像：每个机器人在哪些群、和哪些人聊过（渠道卡「用户 / 群聊」真数 + 「群聊与用户」列表）
  const chatsByBot = await loadBotChats(s.workspaceId);

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
      agentTemplateId: b.agentTemplateId,
      chats: chatsByBot.get(b.id) ?? [],
      // 微信 iLink：绑定的微信 ID 与登录态是否过期都不是密钥，回显给卡片（看到接的是哪个号、过期了提示重扫）
      ilinkUserId: secrets.ilinkUserId ?? null,
      ilinkExpired: !!secrets.ilinkExpired,
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
        title={isEn ? 'Integrations & API Keys' : '接入与密钥'}
        hint={isEn ? 'Model keys, image generation, publishing channels, ingest tokens, bots — all credentials in one place' : '模型 Key、生图、发布通道、采集令牌、机器人——所有要填 Key 的地方都在这一页'}
        action={<Link href="/settings" className="btn btn-sm btn-ghost"><Icon.settings size={13} /> {isEn ? 'Runtime Settings' : '运行设置'}</Link>}
      />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label={isEn ? 'Model Channels' : '模型渠道'} value={providers.length} foot={isEn ? `${okCount} operational` : `${okCount} 条连通正常`} />
        <Stat label={isEn ? 'Image Gen' : '生图能力'} value={arkCount > 0 ? (isEn ? 'Ready' : '已就绪') : (isEn ? 'Unconfigured' : '未配')} foot={arkCount > 0 ? (isEn ? 'Reusing Volcengine Ark Key' : '复用你的方舟 Key') : (isEn ? 'Requires Volcengine Ark channel' : '需要一条火山方舟渠道')} />
        <Stat
          label={isEn ? 'Publishing Channels' : '发布通道'}
          value={[wxCred && (isEn ? 'WeChat OA' : '公众号'), wbCred && (isEn ? 'Weibo' : '微博')].filter(Boolean).join(' · ') || (isEn ? 'Unconfigured' : '未配')}
          foot={isEn ? 'WeChat OA drafts · Weibo direct posting' : '公众号写草稿箱 · 微博直接发出'}
        />
        <Stat label={isEn ? 'Bots' : '机器人'} value={botRows.filter((b) => b.enabled).length} foot={isEn ? `${botRows.length} total` : `共 ${botRows.length} 个`} />
      </div>

      <CheckAllCard readOnly={!canManage} />

      <Card
        title={isEn ? 'Model Channels (BYOK)' : '模型渠道（BYOK）'}
        sub={isEn ? 'Encrypted storage · Write-only · Bring your own AI keys, platform only charges tooling fee' : '加密存储 · 只写不读 · 用你自己的 AI 账号，平台只收工具钱'}
        style={{ marginBottom: 16 }}
        action={<span className="badge badge-brand"><Icon.cpu size={13} /> {isEn ? 'OpenAI Compatible' : 'OpenAI 兼容协议'}</span>}
      >
        {providers.length === 0 ? (
          <Empty icon="🔌" text={isEn ? 'No model channels configured yet. Use the form below to add your first API key.' : '还没有配置模型渠道，用下方表单添加你的第一把 Key'} />
        ) : (
          <div className="stack" style={{ gap: 12, marginBottom: 18 }}>
            {providers.map((p) => {
              // 图像/视频模型的 status='ok' 只表示「没有理由判它坏」——连通性测试对它们
              // 走的是「不判 failed」那条路，并没有真的验通。如实标成「出图时验证」，
              // 不然一个连不上的端点也会显示「连通正常」。
              const nonChat = looksNonChatModel(p.model);
              const st = p.status === 'ok' && nonChat
                ? { dot: 'dot-amber', text: isEn ? 'Verified upon gen' : '出图时验证' }
                : {
                    dot: (STATUS_META[p.status] ?? STATUS_META.untested).dot,
                    text: isEn ? (STATUS_META[p.status] ?? STATUS_META.untested).textEn : (STATUS_META[p.status] ?? STATUS_META.untested).textZh,
                  };
              const masked = maskKey(decryptKey(p.apiKeyEnc));
              const vendorInfo = VENDOR_LABEL[p.vendor];
              const vendorName = vendorInfo ? (isEn ? vendorInfo.en : vendorInfo.zh) : p.vendor;
              return (
                <div key={p.id} className="card" style={{ padding: 14, boxShadow: 'none', background: 'var(--surface-2)' }}>
                  <div className="row-between wrap" style={{ gap: 10 }}>
                    <div className="row wrap" style={{ gap: 10, alignItems: 'center' }}>
                      <b>{p.label}</b>
                      <span className="badge badge-gray">{vendorName}</span>
                      {p.region === 'overseas'
                        ? <span className="badge badge-amber">{isEn ? 'Overseas · Enterprise Only' : '海外·限企业版'}</span>
                        : <span className="badge badge-green">{isEn ? 'China ICP Registered' : '国内已备案'}</span>}
                      {p.isDefault && <span className="badge badge-brand">{isEn ? 'Default' : '默认'}</span>}
                      <span className="row" style={{ gap: 5, alignItems: 'center' }}>
                        <span className={`dot ${st.dot}`} />
                        <span className="small muted">{st.text}</span>
                      </span>
                    </div>
                  </div>
                  <div className="wrap small muted mono" style={{ gap: 14, margin: '8px 0 10px' }}>
                    <span>{isEn ? 'Model' : '模型'} {p.model}</span>
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
          {isEn ? 'Add Channel' : '添加渠道'} <span className="card-sub">{isEn ? 'Select from whitelisted providers' : '从白名单供应商选择'}</span>
        </div>
        <ProviderForm />

        <div className="divider" style={{ margin: '18px 0 12px' }} />
        <div className="card-title" style={{ marginBottom: 6 }}>
          {isEn ? 'Function Routing' : '按功能路由'} <span className="card-sub">{isEn ? 'Use cheaper models for scoring, stronger models for drafting; unassigned defaults to primary' : '打分用便宜的，写稿用好的；未指定的走默认渠道'}</span>
        </div>
        <div className="stack" style={{ gap: 8 }}>
          {LLM_FUNCTIONS.map((fn) => {
            const m = FN_META[fn];
            return (
              <div key={fn} className="row-between wrap" style={{ gap: 8, padding: '8px 0', borderTop: '1px solid var(--surface-2)' }}>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                    <b className="small">{isEn ? m.nameEn : m.name}</b>
                    <span className="badge badge-gray">{isEn ? m.tierEn : m.tier}</span>
                    {!m.overridable && <span className="badge badge-amber">{isEn ? 'Non-overridable' : '不可覆盖'}</span>}
                  </div>
                  <div className="small muted" style={{ marginTop: 3 }}>{isEn ? m.descEn : m.desc}</div>
                </div>
                {m.overridable ? (
                  <FunctionRouting
                    fn={fn}
                    current={routedProviderId(fn)}
                    providers={routableProviders}
                    doubaoOnly={fn === 'image' || fn === 'video'}
                  />
                ) : (
                  <span className="small mono">{isEn ? 'Follows generation' : '跟随生成'}</span>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      <PublishChannelCard wechat={wxCred} weibo={wbCred} readOnly={!canManage} />

      <Card
        title={isEn ? 'Extension Ingest Tokens' : '插件采集令牌'}
        sub={isEn ? 'Used by browser extension to push data · Grants write-only access to this workspace' : '浏览器插件用它回传数据 · 一枚令牌只授权「写入本工作区」这一件事'}
        style={{ marginBottom: 16 }}
      >
        <p className="small muted" style={{ marginBottom: 10, lineHeight: 1.7 }}>
          {isEn ? (
            <>
              <Link href="/extension" style={{ color: 'var(--brand)', fontWeight: 600 }}>Download & install "Beacon Ingest Assistant" →</Link>
              {' '}(Chrome / Edge / 360 / Brave), and enter the token below in extension settings.
              It is also used for one-click publishing and diagnostic reporting.
            </>
          ) : (
            <>
              <Link href="/extension" style={{ color: 'var(--brand)', fontWeight: 600 }}>下载并安装「烽火台采集助手」→</Link>
              （Chrome / Edge / 360 / Brave），把下方令牌填进插件设置。
              它也是「一键发布」把内容交给插件、以及插件上报解析失效样本用的同一枚令牌。
            </>
          )}
        </p>
        <IngestTokenCard active={ingestTokens.active} revoked={ingestTokens.revoked} legacyToken={workspace?.ingestToken ?? null} />
      </Card>

      <Card
        title={isEn ? 'Bot Integrations' : '机器人接入'}
        sub={isEn ? 'Feishu / DingTalk / WeCom / WeChat iLink: Outbound push + Inbound ChatOps' : '飞书 / 钉钉 / 企微：出站推送 + 入站 ChatOps'}
        style={{ marginBottom: 16 }}
        action={<Link href="/notifications" className="btn btn-sm btn-ghost">{isEn ? 'Push events & schedule →' : '推送什么、什么时候推 →'}</Link>}
      >
        <p className="small muted" style={{ marginBottom: 12, lineHeight: 1.7 }}>
          {isEn ? (
            <>
              Configure <b>credentials</b> here (Webhook URL, App Secret, etc.). <b>Push event triggers, schedule times, and allowed commands</b> are configured inside each bot item. For details see
              <Link href="/help" style={{ color: 'var(--brand)', fontWeight: 600, marginLeft: 4 }}>Help Guide →</Link>
            </>
          ) : (
            <>
              这里只管<b>凭据</b>（Webhook 地址、App Secret 等）。<b>推送哪些事件、几点推、群里能用哪些命令</b>
              在每条机器人的展开项里配，整体说明见
              <Link href="/help" style={{ color: 'var(--brand)', fontWeight: 600, marginLeft: 4 }}>使用帮助 →</Link>
            </>
          )}
        </p>
        <BotIntegrationCard rows={botRows} callbackBase={callbackBase} agentOptions={agentOptions} pollerRuns={backgroundSchedulerRuns()} />
      </Card>

      <Card title={isEn ? 'Compliance Boundaries' : '合规边界'} sub={isEn ? 'BYOK does not mean no compliance oversight' : '用自己的 Key，不等于平台不管合规'}>
        <div className="stack" style={{ gap: 10 }}>
          <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <Icon.shield size={16} className="" />
            <span className="small">
              {isEn ? (
                <><b>Publicly published content defaults to registered domestic models.</b> Beacon remains the service provider responsible for public-facing AI content within mainland China, regardless of key ownership.</>
              ) : (
                <><b>国内公开发布的内容，默认用已备案模型。</b>面向境内公众提供 AI 生成服务的责任方始终是烽火台，不因 Key 是谁的而改变。</>
              )}
            </span>
          </div>
          <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <Icon.x size={16} className="" />
            <span className="small">
              {isEn ? (
                <><b>Overseas models are restricted to enterprise outbound/global content.</b> Cross-border data flows require prior compliance review and data sanitization. Key validity and vendor TOS compliance are your responsibility.</>
              ) : (
                <><b>海外模型只开放给企业版的出海内容场景。</b>数据出境前需先完成合规审查与脱敏；Key 是否有效、供应商条款怎么约定，由你自己负责。</>
              )}
            </span>
          </div>
          <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <Icon.check size={16} className="" />
            <span className="small">
              {isEn ? (
                <><b>Content always undergoes compliance checks before leaving the platform.</b> Redline vocabulary filters + secondary AI review + AIGC watermarking + audit logging are enforced platform-side. BYOK changes who pays the LLM bill, not who is accountable for outbound content.</>
              ) : (
                <><b>内容离开平台前，永远先过合规检测。</b>红线词库 + AI 二次复核 + AIGC 标识 + 日志留存都在平台侧执行；自备 Key 只改变谁付模型的钱，不改变谁对发出去的内容负责。</>
              )}
            </span>
          </div>
          <div className="alert-gradient-amber" style={{ padding: '10px 14px', marginTop: 4 }}>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <span className="row" style={{ color: 'var(--amber)', flexShrink: 0 }}>
                <Icon.shield size={16} />
              </span>
              <span className="small" style={{ opacity: 0.9 }}>
                {isEn ? 'Arbitrary proxy / relay endpoints for overseas models are not supported — unqualified API proxies are blocked at the product level.' : '不支持自由填写任意中转地址接境外模型——那属于无资质 API 中转，产品层面不开放。'}
              </span>
            </div>
          </div>
        </div>
      </Card>
    </>
  );
}
