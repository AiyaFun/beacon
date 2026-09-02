'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { actSaveBot, actTestBot, actToggleBot, actDeleteBot, actRevealBotSecrets, actDiagnoseBot, actSetBotAgent } from './bot-actions';
import { BOT_PROVIDERS, PUSH_EVENTS, TOGGLEABLE_COMMANDS, DEFAULT_OFF_COMMANDS, EXTERNAL_DEFAULT_COMMANDS, botProviderName, isReplyOnlyProvider, isExternalProvider } from '@/lib/bot/types';
import { Overlay } from '@/components/Overlay';
import { ChannelLogo } from '@/components/ChannelLogos';
import { WechatIlinkConnect } from '@/components/WechatIlinkConnect';
import { BotChatsDialog } from './BotChatsDialog';
import { summarizeChats, type BotChatRow } from '@/lib/bot/chat-summary';
import { fmtDateTime } from '@/lib/format';

// 一键配置飞书机器人（需求③④）。密钥永不回显；表单留空=保持原值。
// 出站（推送）是真·一键：粘贴 webhook → 选事件 → 保存 → 测试发送。
// 入站（ChatOps 收录）是进阶：填自建应用 App ID/Secret/校验串，把回调地址粘到飞书事件订阅。

export type BotRow = {
  id: string;
  provider: string;
  label: string;
  enabled: boolean;
  webhookUrl: string | null;
  inboundKey: string | null;
  agentId: string | null;
  pushEvents: string[];
  pushSchedule: string;
  /** 群里允许触发的操作。**空 = 从未配置 = 默认全开**（不是全关），语义见 lib/bot/types */
  allowCommands: string[];
  hasSignSecret: boolean;
  hasAppSecret: boolean;
  hasVerificationToken: boolean;
  hasEncryptKey: boolean;
  hasInboundSecrets: boolean;
  // 掩码（cli_····ab12）随页面下发；明文点「👁 显示」时才按需拉取
  maskedSignSecret: string;
  maskedAppSecret: string;
  maskedVerificationToken: string;
  maskedEncryptKey: string;
  lastOutboundAt: string | null;
  lastInboundAt: string | null;
  lastError: string | null;
  /** 渠道绑定的智能体（WorkflowTemplate.id）。空 = 通用运营助手 */
  agentTemplateId: string | null;
  /** 这个机器人名下的会话画像（BotConversation：在哪些群、和谁聊过、计数）。渠道卡「用户 / 群聊」真数与抽屉列表都从这来 */
  chats: BotChatRow[];
  /** 微信（iLink）：绑定的微信用户 ID（展示用）与登录态是否过期；其它渠道为 null / false */
  ilinkUserId: string | null;
  ilinkExpired: boolean;
};

const DEFAULT_EVENTS = ['daily_recommend', 'compliance_alert', 'learning_summary'];
// 新建时默认全开，与「库里空数组 = 默认全开」的老语义一致，不让新老两条路给出不同结果。
// 2026-09-02：DEFAULT_OFF_COMMANDS 现在是空数组（dispatch 改默认开），
// 以后新的高危命令进来再用，现在这行 filter 实际什么都不滤。
const ALL_COMMANDS = TOGGLEABLE_COMMANDS
  .filter((c) => !DEFAULT_OFF_COMMANDS.includes(c.key))
  .map((c) => c.key as string);

export function BotIntegrationCard({ rows, callbackBase, agentOptions, pollerRuns = true }: { rows: BotRow[]; callbackBase: string; agentOptions: { id: string; name: string }[]; /** 这台实例有没有后台进程在收微信 iLink 消息（本机开发没有） */ pollerRuns?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState<BotRow | null>(null);
  /** 打开哪个渠道的「群聊与用户」抽屉（provider key） */
  const [chatsFor, setChatsFor] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [msg, setMsg] = useState('');
  const [failed, setFailed] = useState(false);

  // 表单态
  const [botMode, setBotMode] = useState<'app' | 'webhook'>('app');
  const [agentTpl, setAgentTpl] = useState(''); // 渠道默认智能体（''=通用助手）
  const [provider, setProvider] = useState('feishu');
  const [label, setLabel] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [signSecret, setSignSecret] = useState('');
  const [events, setEvents] = useState<string[]>(DEFAULT_EVENTS);
  const [commands, setCommands] = useState<string[]>(ALL_COMMANDS);
  const [pushSchedule, setPushSchedule] = useState('09:00');
  const [showInbound, setShowInbound] = useState(false);
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [verificationToken, setVerificationToken] = useState('');
  const [encryptKey, setEncryptKey] = useState('');
  const [agentId, setAgentId] = useState('');
  const [copied, setCopied] = useState(false);
  // 明文密钥：点「👁 显示」后才从服务端取回，切走/关表单即丢弃（不缓存进 BotRow）
  const [revealed, setRevealed] = useState<Record<string, string> | null>(null);
  // 体检结果：逐步展开卡在哪一步
  const [diag, setDiag] = useState<{ id: string; steps: { name: string; ok: boolean; detail: string; fix?: string }[]; passed: boolean } | null>(null);

  function toggleReveal() {
    if (revealed) { setRevealed(null); return; }
    if (!editing) return;
    start(async () => {
      const r = await actRevealBotSecrets(editing.id);
      if (r.ok) setRevealed(r.secrets);
      else flash(r.error ?? '读取失败', true);
    });
  }

  async function copyCallback() {
    await navigator.clipboard.writeText(callbackUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function flash(m: string, isFail = false) {
    setMsg(m);
    setFailed(isFail);
    setTimeout(() => setMsg(''), 3500);
  }

  function resetForm() {
    setBotMode('app'); setProvider('feishu'); setLabel(''); setWebhookUrl(''); setSignSecret('');
    setEvents(DEFAULT_EVENTS); setCommands(ALL_COMMANDS); setPushSchedule('09:00'); setShowInbound(false);
    setAppId(''); setAppSecret(''); setVerificationToken(''); setEncryptKey(''); setAgentId('');
    setAgentTpl('');
    setRevealed(null);
    setEditing(null);
  }

  function openAdd() { resetForm(); setShowForm(true); }
  // 渠道总览卡上的「接入」：预选好渠道再开表单，用户不用在下拉里再找一遍。
  // telegram/slack 只有出站 webhook 一条路（app/api/bot/ 下没有它们的入站路由），直接落 webhook 模式。
  function openAddFor(key: string) {
    resetForm();
    setProvider(key);
    setBotMode(key === 'telegram' || key === 'slack' ? 'webhook' : 'app');
    // 对外渠道（微信客服）：谁扫码都能聊，新建默认只开低风险指令，不吃「全勾」的默认
    if (isExternalProvider(key)) setCommands([...EXTERNAL_DEFAULT_COMMANDS]);
    setShowForm(true);
  }
  function openEdit(r: BotRow) {
    setEditing(r); setBotMode(r.inboundKey ? 'app' : 'webhook');
    setAgentTpl(r.agentTemplateId ?? '');
    setProvider(r.provider); setLabel(r.label);
    setWebhookUrl(r.webhookUrl ?? ''); setSignSecret('');
    setEvents(r.pushEvents.length ? r.pushEvents : DEFAULT_EVENTS);
    // 空 = 从未配置 = 默认全开，所以这里回填成「全勾」；勾成什么样，群里就是什么样
    setCommands(r.allowCommands.length ? r.allowCommands : ALL_COMMANDS);
    setPushSchedule(r.pushSchedule || '09:00');
    setShowInbound(!!r.inboundKey);
    // 企微的 inboundKey 是 corpId_agentId 组合，编辑时还原各字段；
    // 其余平台（钉钉）的 AgentId 存在 secrets 里，从回传的明文字段还原——不还原会看着像被清空了。
    if (r.provider === 'wecom' && r.inboundKey?.includes('_')) {
      const parts = r.inboundKey.split('_');
      setAppId(parts[0]); setAgentId(parts.slice(1).join('_'));
    } else if (r.provider === 'wechat_kf') {
      // 微信客服的 inboundKey 是 corpId_kf：剥掉后缀还原 CorpID。原样带回去再保存会拼成 corpId_kf_kf，
      // 回调地址跟着变，企微后台配好的那条静默失效
      setAppId((r.inboundKey ?? '').replace(/_kf$/, '')); setAgentId('');
    } else {
      setAppId(r.inboundKey ?? ''); setAgentId(r.agentId ?? '');
    }
    // 真密钥不预填输入框：留空提交=沿用旧值（服务端 `输入 || prevSecrets` 兜底）；
    // 想核对已存的值，用下方「已保存的密钥」区块看掩码/点眼睛看明文。
    setAppSecret(''); setVerificationToken(''); setEncryptKey('');
    setRevealed(null);
    setShowForm(true);
  }

  // 密钥类输入框的占位文案：已存过就明说「留空=不改」，免得看着像丢了。
  function secretHint(saved: boolean | undefined, label: string, whenNew: string) {
    return saved ? `${label}（已保存 · 留空=不改）` : whenNew;
  }

  function toggleEvent(k: string) {
    setEvents((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
  }

  function toggleCommand(k: string) {
    setCommands((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
  }

  function save() {
    start(async () => {
      const r = await actSaveBot({
        id: editing?.id, provider, label, botMode, webhookUrl, signSecret, pushEvents: events, agentTemplateId: agentTpl,
        allowCommands: commands,
        pushSchedule, appId, appSecret, verificationToken, encryptKey, agentId,
      });
      if (r.ok) { flash('已保存'); setShowForm(false); resetForm(); router.refresh(); }
      else flash(r.error ?? '保存失败', true);
    });
  }
  function test(id: string) {
    start(async () => {
      const r = await actTestBot(id);
      flash(r.ok ? '测试消息已发送，去群里看看' : `测试失败：${r.error ?? ''}`, !r.ok);
      router.refresh();
    });
  }
  function diagnose(id: string) {
    setDiag(null);
    start(async () => {
      const r = await actDiagnoseBot(id);
      if (r.ok) setDiag({ id, steps: r.steps, passed: r.passed });
      else flash(r.error ?? '体检失败', true);
    });
  }
  function toggle(r: BotRow) {
    start(async () => { await actToggleBot(r.id, !r.enabled); router.refresh(); });
  }
  function remove(id: string) {
    if (!window.confirm('删除后该机器人不再推送、也不再接收指令。继续？')) return;
    start(async () => { await actDeleteBot(id); flash('已删除'); router.refresh(); });
  }

  // 回调地址带 App ID（多租户下靠它在解密前定位密钥）；未填时给占位提示。
  const callbackKey = provider === 'wecom'
    ? (appId.trim() && agentId.trim() ? `${appId.trim()}_${agentId.trim()}` : '<先填下方 CorpID 和 AgentID>')
    : provider === 'wechat_kf'
      ? (appId.trim() ? `${appId.trim()}_kf` : '<先填下方 CorpID>')
      : (appId.trim() || '<先填下方 App ID>');
  // 微信客服的路由段是 wechat-kf（URL 不用下划线），别用 provider 原值拼
  const callbackUrl = `${callbackBase}/api/bot/${provider === 'wechat_kf' ? 'wechat-kf' : provider}/events/${callbackKey}`;

  // 渠道总览：一屏之内看清「有哪些渠道、各自连没连」。
  // 此前这两件事全藏在表单的平台下拉里——用户得逐个切换才知道自己配了几个（2026-09-01 依用户截图重排）。
  // ⚠️ 准入策略（allowCommands）与智能体挂载**刻意不放进总览卡**：那是已经收口到一处的闸，
  // 拆到每张渠道卡上会变成同一个策略六个入口。
  // 「几小时前」——只到能扫读的粒度，别精确到秒（这里回答的是「它活着吗」，不是审计）
  const ago = (iso: string | null): string | null => {
    if (!iso) return null;
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 0) return null;
    const m = Math.floor(ms / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return `${m} 分钟前`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} 小时前`;
    return `${Math.floor(h / 24)} 天前`;
  };
  const channelStat = BOT_PROVIDERS.map((p) => {
    const mine = rows.filter((r) => r.provider === p.key);
    const first = mine[0] ?? null;
    // 最近活动取出站/入站两个时刻的较新者：只看其中一个，另一个方向的机器人会被冤枉成「没动静」
    const lastActive = mine
      .flatMap((r) => [r.lastOutboundAt, r.lastInboundAt])
      .filter((x): x is string => !!x)
      .sort()
      .pop() ?? null;
    // 推送订阅取各绑定的并集：两个机器人各订两类，渠道整体是四类不是二类
    const eventUnion = new Set(mine.flatMap((r) => r.pushEvents));
    return {
      ...p,
      total: mine.length,
      on: mine.filter((r) => r.enabled).length,
      first,
      lastActive,
      erring: mine.filter((r) => r.lastError).length,
      events: eventUnion.size,
      // 会话画像汇总：去重用户 / 群 / 私聊——全是真数，来自每条入站消息的 touch（lib/bot/conversation.ts）
      ...summarizeChats(mine.flatMap((r) => r.chats)),
      // 接法：有入站路由键 = 自建应用（双向）；只有 webhook = 仅出站
      mode: first
        ? (p.key === 'wechat_kf' ? '微信客服 · 官方对话通道'
          : p.key === 'wechat' ? '官方 iLink 机器人 · 扫码绑定'
          : first.inboundKey ? '自建应用 · 双向' : 'Webhook · 仅出站')
        : null,
    };
  });

  return (
    <div className="stack" style={{ gap: 12 }}>
      {/* 渠道总览（2026-09-01 按用户指定的 Accio /work/app/channels 卡片解剖重排：
          头像头部 + 三格统计 + 智能体/指令权限双栏 + 通栏设置按钮。
          「待处理」那格不搬——beacon 没有配对审核，摆一个恒 0 的格子是装样子；
          换成真实存在的三个量：机器人数 / 群会话数（BotConversation 真表）/ 推送订阅并集。） */}
      <div className="grid grid-2" style={{ gap: 12 }}>
        {channelStat.map((c) => (
          <div key={c.key} className="card" style={{ padding: 16, boxShadow: 'none', border: '1px solid var(--border)' }}>
            {/* 头部：头像 + 名称/接法 + 状态徽标 */}
            <div className="row" style={{ gap: 10, alignItems: 'center' }}>
              <ChannelLogo provider={c.key} size={42} fallback={c.name} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <b style={{ fontSize: 15 }}>{c.name}</b>
                  {c.erring > 0 && <span className="badge badge-red" title="有机器人最近报错，点「设置机器人」看详情">⚠ {c.erring} 个报错</span>}
                </div>
                <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.mode ?? c.hint}
                  {/* Accio 每卡都有的「如何接入?」——beacon 的分步说明就在连接弹窗里按渠道分段，
                      点开即见，不再单独维护第二份文档 */}
                  <button
                    type="button"
                    className="small"
                    style={{ marginLeft: 6, color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                    onClick={() => openAddFor(c.key)}
                  >
                    如何接入?
                  </button>
                </div>
              </div>
              {c.total > 0
                ? <span className="badge badge-green" style={{ flexShrink: 0 }}>已关联{c.on < c.total ? ` · 停用 ${c.total - c.on}` : ''}</span>
                : <span className="badge badge-gray" style={{ flexShrink: 0 }}>未关联</span>}
            </div>

            {/* 三格统计：全是真数，没有的量不摆格子。用户 / 群聊 点开是「群聊与用户」抽屉——
                Accio 卡上这两格就是这么用的：数字告诉你有多少，点进去告诉你是哪些。
                只答不推的渠道（微信 iLink / 微信客服）没有群也没有推送：摆一格「暂不支持群聊」说破，不摆恒 0 */}
            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              {(isReplyOnlyProvider(c.key)
                ? ([['用户', c.users], ['私聊', c.p2p]] as const)
                : ([['用户', c.users], ['群聊', c.groups], ['推送订阅', c.events]] as const)
              ).map(([label, n]) => {
                const drill = label !== '推送订阅' && c.total > 0;
                return (
                  <div
                    key={label}
                    role={drill ? 'button' : undefined}
                    tabIndex={drill ? 0 : undefined}
                    title={drill ? '点开看是哪些群、哪些人' : undefined}
                    onClick={drill ? () => setChatsFor(c.key) : undefined}
                    onKeyDown={drill ? (e) => { if (e.key === 'Enter' || e.key === ' ') setChatsFor(c.key); } : undefined}
                    style={{ flex: 1, padding: '8px 6px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface-2)', textAlign: 'center', cursor: drill ? 'pointer' : undefined }}
                  >
                    <div style={{ fontSize: 17, fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 }}>{n}</div>
                    <div className="small muted" style={{ fontSize: 11, marginTop: 1 }}>{label}</div>
                  </div>
                );
              })}
              {isReplyOnlyProvider(c.key) && (
                <div className="small muted" style={{ flex: 1, padding: '8px 6px', border: '1px dashed var(--border)', borderRadius: 10, textAlign: 'center', alignSelf: 'stretch', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  暂不支持群聊
                </div>
              )}
            </div>

            {/* 智能体 / 指令权限 双栏（Accio 的「智能体 + 准入策略」位）。
                指令权限只做**launcher**不做就地编辑：那套开关在编辑表单里有唯一入口，
                拆到每张卡上就地改，等于同一道闸开六个口子 */}
            <div className="row" style={{ gap: 8, marginTop: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="small muted" style={{ marginBottom: 4 }}>智能体</div>
                {c.first ? (
                  <select
                    className="input"
                    style={{ width: '100%', padding: '6px 8px', fontSize: 13 }}
                    value={c.first.agentTemplateId ?? ''}
                    disabled={pending}
                    onChange={(e) => {
                      const v = e.target.value || null;
                      start(async () => {
                        const r = await actSetBotAgent(c.first!.id, v);
                        if (!r.ok) flash(r.error ?? '保存失败', true);
                        else { flash(v ? '已绑定，该渠道对话将以这个智能体出面' : '已解绑，回到通用助手'); router.refresh(); }
                      });
                    }}
                  >
                    <option value="">通用运营助手（默认）</option>
                    {agentOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                ) : (
                  <div className="small muted" style={{ padding: '6px 8px', border: '1px dashed var(--border)', borderRadius: 8 }}>
                    接入后可选
                  </div>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="small muted" style={{ marginBottom: 4 }}>指令权限</div>
                {c.first ? (
                  <button
                    type="button"
                    className="input row-between"
                    style={{ width: '100%', padding: '6px 8px', fontSize: 13, cursor: 'pointer', textAlign: 'left' }}
                    disabled={pending}
                    onClick={() => openEdit(c.first!)}
                    title="到编辑表单里改（指令开关只有这一个入口）"
                  >
                    <span>{c.first.allowCommands.length === 0 ? '默认集' : `自定义 ${c.first.allowCommands.length} 项`}</span>
                    <span className="muted">›</span>
                  </button>
                ) : (
                  <div className="small muted" style={{ padding: '6px 8px', border: '1px dashed var(--border)', borderRadius: 8 }}>
                    接入后可配
                  </div>
                )}
              </div>
            </div>

            {/* 活动行：它是「这渠道活着吗」的直接证据，Accio 没有但值得有 */}
            {c.first && (
              <div className="row-between small muted" style={{ marginTop: 8, gap: 8 }}>
                <span>最近活动：{ago(c.lastActive) ?? '还没动静'}</span>
                <button
                  type="button"
                  className="small"
                  style={{ color: 'var(--brand)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                  onClick={() => setChatsFor(c.key)}
                >
                  群聊与用户 ›
                </button>
              </div>
            )}

            {/* 通栏主按钮 */}
            <div style={{ marginTop: 10 }}>
              {c.first ? (
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn" style={{ flex: 1 }} onClick={() => openEdit(c.first!)} disabled={pending}>
                    设置机器人
                  </button>
                  <button className="btn btn-ghost" onClick={() => openAddFor(c.key)} disabled={pending} title="同渠道再绑一个群/应用">
                    ＋
                  </button>
                </div>
              ) : (
                <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => openAddFor(c.key)} disabled={pending}>
                  接入
                </button>
              )}
            </div>
          </div>
        ))}

      </div>

      {/* 已配置列表与详细配置信息 */}
      {rows.length > 0 && (
        <div className="stack" style={{ gap: 12 }}>
          {rows.map((r) => (
            <div key={r.id} className="card" style={{ padding: 16, boxShadow: 'none', background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
              <div className="row-between wrap" style={{ gap: 10 }}>
                <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
                  <b style={{ fontSize: 15 }}>{r.label}</b>
                  <span className="badge badge-brand">{BOT_PROVIDERS.find((p) => p.key === r.provider)?.name ?? r.provider}</span>
                  {r.enabled ? <span className="badge badge-green">● 已启用</span> : <span className="badge badge-gray">已停用</span>}
                  {r.provider === 'wechat_kf' ? (
                    <span className="badge badge-blue">官方客服 · 只答不推</span>
                  ) : r.provider === 'wechat' ? (
                    <span className="badge badge-blue" title="微信官方面向智能体的机器人接口">官方 iLink · 只答不推</span>
                  ) : r.inboundKey ? (
                    <span className="badge badge-blue">双向全能 (自建应用)</span>
                  ) : (
                    <span className="badge badge-amber">出站 Webhook</span>
                  )}
                  {r.hasSignSecret && <span className="badge badge-gray">已启加签校验</span>}
                </div>
                <div className="row" style={{ gap: 6 }}>
                  {/* 只答不推的渠道没有「测试发送」（发不出去，只会报一句谜语）；体检是它验证凭据的唯一入口 */}
                  {(r.webhookUrl || r.inboundKey) && !isReplyOnlyProvider(r.provider) && <button className="btn btn-sm btn-primary" onClick={() => test(r.id)} disabled={pending}>测试发送</button>}
                  {(r.webhookUrl || r.inboundKey) && <button className="btn btn-sm btn-ghost" onClick={() => diagnose(r.id)} disabled={pending} title={isReplyOnlyProvider(r.provider) ? '验证凭据、回调/网关是否配通' : '逐步跑一遍出站链路，指出卡在哪一步'}>🩺 体检</button>}
                  <button className="btn btn-sm btn-ghost" onClick={() => openEdit(r)} disabled={pending}>编辑配置</button>
                  <button className="btn btn-sm btn-ghost" onClick={() => toggle(r)} disabled={pending}>{r.enabled ? '停用' : '启用'}</button>
                  <button className="btn btn-sm btn-ghost" onClick={() => remove(r.id)} disabled={pending} style={{ color: 'var(--red)' }}>删除</button>
                </div>
              </div>

              {/* 机器人配置信息展板 */}
              <div className="stack" style={{ gap: 8, marginTop: 12, padding: '10px 12px', background: 'var(--surface)', borderRadius: 8, border: '1px solid var(--border)' }}>
                <div className="row wrap" style={{ gap: 16, fontSize: 13 }}>
                  {isReplyOnlyProvider(r.provider) ? (
                    <div className="muted">无定时推送（这条通道只答不推）</div>
                  ) : (
                    <div>
                      <span className="muted">定时推送节点：</span>
                      <b style={{ color: 'var(--brand)' }}>🕒 每日 {r.pushSchedule || '09:00'}</b>
                    </div>
                  )}
                  {r.inboundKey && r.provider === 'wechat_kf' && (
                    <div>
                      <span className="muted">CorpID：</span>
                      <code className="mono">{r.inboundKey.replace(/_kf$/, '')}</code>
                    </div>
                  )}
                  {r.provider === 'wechat' && (
                    <>
                      <div>
                        <span className="muted">已绑定微信：</span>
                        <b style={{ color: r.ilinkExpired ? 'var(--red)' : undefined }}>
                          {r.ilinkExpired ? '登录态已过期，请重新扫码' : (r.ilinkUserId ?? '已绑定')}
                        </b>
                      </div>
                      {!pollerRuns && (
                        <div style={{ color: 'var(--amber)' }}>⚠ 本机开发模式没有后台进程收微信消息（生产不受影响）</div>
                      )}
                    </>
                  )}
                  {r.inboundKey && !isReplyOnlyProvider(r.provider) && (
                    <div>
                      <span className="muted">App ID：</span>
                      <code className="mono">{r.inboundKey}</code>
                    </div>
                  )}
                  {r.webhookUrl && (
                    <div>
                      <span className="muted">Webhook：</span>
                      <code className="mono">{r.webhookUrl.substring(0, 32)}...</code>
                    </div>
                  )}
                </div>

                {/* 微信客服的回调地址要粘进企微后台——这是用户接线时**必须抄走**的东西，
                    此前只在新建表单里一闪而过，保存后就没地方看了 */}
                {r.inboundKey && r.provider === 'wechat_kf' && (
                  <div className="small" style={{ wordBreak: 'break-all' }}>
                    <span className="muted">企微后台回调 URL：</span>
                    <code className="mono">{`${callbackBase}/api/bot/wechat-kf/events/${r.inboundKey}`}</code>
                  </div>
                )}

                {!isReplyOnlyProvider(r.provider) && (
                <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
                  <span className="small muted" style={{ flexShrink: 0 }}>已订阅事件 ({r.pushEvents.length})：</span>
                  {r.pushEvents.length > 0 ? (
                    r.pushEvents.map((evKey) => {
                      const evObj = PUSH_EVENTS.find((e) => e.key === evKey);
                      return (
                        <span key={evKey} className="badge badge-gray" style={{ fontSize: 11 }}>
                          {evObj?.name ?? evKey}
                        </span>
                      );
                    })
                  ) : (
                    <span className="small muted">暂无订阅事件</span>
                  )}
                </div>
                )}

                {diag?.id === r.id && (
                  <div className="stack" style={{ gap: 8, margin: '10px 0', padding: '12px 14px', background: 'var(--surface)', borderRadius: 8, border: `1px solid ${diag.passed ? 'var(--green)' : 'var(--red)'}` }}>
                    <div className="row-between wrap" style={{ gap: 8, alignItems: 'center' }}>
                      <b className="small" style={{ color: diag.passed ? 'var(--green)' : 'var(--red)' }}>
                        {diag.passed ? '✅ 体检通过，链路是通的' : '❌ 体检卡住了，看下面哪一步是红的'}
                      </b>
                      <button className="btn btn-sm btn-ghost" onClick={() => setDiag(null)}>收起</button>
                    </div>
                    {diag.steps.map((st, i) => (
                      <div key={i} className="stack" style={{ gap: 3, paddingTop: 6, borderTop: i === 0 ? 'none' : '1px dashed var(--border)' }}>
                        <div className="small">
                          <span style={{ color: st.ok ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>{st.ok ? '✓' : '✗'}</span>
                          {' '}<b>{st.name}</b>
                        </div>
                        <div className="small mono muted" style={{ wordBreak: 'break-all', paddingLeft: 16 }}>{st.detail}</div>
                        {!st.ok && st.fix && (
                          <div className="small" style={{ paddingLeft: 16, lineHeight: 1.7, color: 'var(--amber)' }}>
                            👉 {st.fix}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <div className="row wrap small muted" style={{ gap: 14, paddingTop: 4, borderTop: '1px dashed var(--border)' }}>
                  <span>最近推送：{r.lastOutboundAt ? fmtDateTime(r.lastOutboundAt) : '暂无'}</span>
                  <span>最近接收指令：{r.lastInboundAt ? fmtDateTime(r.lastInboundAt) : '暂无'}</span>
                  {r.lastError && <span style={{ color: 'var(--red)' }}>⚠ 上次状态：{r.lastError}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 「群聊与用户」抽屉：某个渠道下所有机器人的群 / 私聊 / 用户列表（会话画像真数） */}
      {chatsFor && (() => {
        const c = channelStat.find((x) => x.key === chatsFor);
        if (!c) return null;
        return (
          <BotChatsDialog
            providerKey={c.key}
            providerName={c.name}
            rows={rows.filter((r) => r.provider === c.key)}
            onClose={() => setChatsFor(null)}
          />
        );
      })()}

      {/* 新增/编辑弹窗（2026-09-01 按用户指定的 Accio 连接弹窗改）：渠道卡点「接入/设置」当场弹出，
          不再把整页往下顶。必须走 Overlay 组件——.card:hover 的 transform 会把就地渲染的
          fixed 遮罩关进卡片（components/Overlay.tsx 文件头那个 602×110 的实测教训）。 */}
      {showForm ? (
        <Overlay label={editing ? '设置机器人' : '连接渠道'} onClose={() => { setShowForm(false); resetForm(); }}>
        <div className="dialog-card" style={{ width: 'min(720px, 94vw)', maxHeight: '86vh', overflowY: 'auto', padding: 18 }}>
          <div className="row" style={{ gap: 10, alignItems: 'center', marginBottom: 12 }}>
            <ChannelLogo provider={provider} size={38} fallback={botProviderName(provider)} />
            <b style={{ fontSize: 16, flex: 1 }}>
              {editing ? `设置机器人 · ${editing.label || botProviderName(provider)}` : `连接 ${botProviderName(provider)}`}
            </b>
            <button className="btn btn-sm btn-ghost" aria-label="关闭" onClick={() => { setShowForm(false); resetForm(); }} disabled={pending}>✕</button>
          </div>
          {/* 微信（iLink）新接入：没有任何要填的，直接扫码；绑定成功后刷新，名称/智能体/指令在「设置」里改 */}
          {provider === 'wechat' && !editing ? (
            <WechatIlinkConnect
              existing={null}
              autoStart
              onDone={() => { router.refresh(); }}
            />
          ) : (
          <div className="stack" style={{ gap: 12 }}>
            {editing && (editing.hasInboundSecrets || editing.hasSignSecret) && (
              <div className="stack" style={{ gap: 8, padding: '12px 14px', background: 'var(--surface-2)', borderRadius: 8, border: '1px solid var(--border)' }}>
                <div className="row-between wrap" style={{ gap: 8, alignItems: 'center' }}>
                  <span className="small" style={{ fontWeight: 700 }}>🔒 已保存的密钥</span>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={toggleReveal} disabled={pending}>
                    {revealed ? '🙈 隐藏' : '👁 显示明文'}
                  </button>
                </div>

                <div className="stack" style={{ gap: 4 }}>
                  {([
                    ['App Secret / AppSecret / Secret', editing.hasAppSecret, editing.maskedAppSecret, 'appSecret'],
                    ['Verification Token / Token', editing.hasVerificationToken, editing.maskedVerificationToken, 'verificationToken'],
                    ['Encrypt Key / EncodingAESKey', editing.hasEncryptKey, editing.maskedEncryptKey, 'encryptKey'],
                    ['出站加签密钥', editing.hasSignSecret, editing.maskedSignSecret, 'signSecret'],
                  ] as const)
                    .filter(([, has]) => has)
                    .map(([name, , masked, field]) => (
                      <div key={field} className="row-between wrap" style={{ gap: 8, alignItems: 'center' }}>
                        <span className="small muted" style={{ minWidth: 180 }}>{name}</span>
                        <code
                          className="small mono"
                          style={{
                            flex: 1, minWidth: 160, wordBreak: 'break-all', padding: '4px 8px', borderRadius: 6,
                            background: 'var(--surface)', border: '1px solid var(--border)',
                            color: revealed ? 'var(--brand)' : 'var(--muted)',
                          }}
                        >
                          {revealed ? (revealed[field] || '(空)') : masked}
                        </code>
                      </div>
                    ))}
                </div>

                <div className="small muted" style={{ lineHeight: 1.7, borderTop: '1px dashed var(--border)', paddingTop: 6 }}>
                  下面的输入框留空是正常的——<b>留空保存即沿用上面这些值</b>，只有要换密钥时才重新填写。
                  {revealed && <span style={{ color: 'var(--amber)' }}>　⚠ 明文已显示，注意别被旁人看到或截图。</span>}
                </div>
              </div>
            )}
            <div className="row wrap" style={{ gap: 10 }}>
              <label className="stack" style={{ gap: 4, flex: 1, minWidth: 160 }}>
                <span className="small muted">平台</span>
                <select className="input" value={provider} onChange={(e) => setProvider(e.target.value)}>
                  {BOT_PROVIDERS.map((p) => (
                    <option key={p.key} value={p.key} disabled={!p.supported}>{p.name}{p.supported ? '' : '（即将支持）'}</option>
                  ))}
                </select>
              </label>
              <label className="stack" style={{ gap: 4, flex: 1, minWidth: 160 }}>
                <span className="small muted">名称（自定义，便于区分多个群）</span>
                <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="如：选题作战群" />
              </label>
            </div>

            {/* 飞书/钉钉/企微：自建应用(方式A)与群Webhook(方式B)切换 */}
            {(provider === 'feishu' || provider === 'dingtalk' || provider === 'wecom') && (
              <div className="stack" style={{ gap: 6 }}>
                <span className="small muted">选择接入模式</span>
                {/* 分段控件的形（Accio 弹窗顶部那对页签）：两条真实接法当页签，不造假的「扫码」页 */}
                <div className="row" style={{ gap: 4, background: 'var(--surface-2)', borderRadius: 12, padding: 4 }}>
                  <button
                    type="button"
                    className={`btn btn-sm ${botMode === 'app' ? 'btn-primary' : 'btn-ghost'}`}
                    style={{ flex: 1, minWidth: 220, padding: '10px 14px', justifyContent: 'flex-start', textAlign: 'left' }}
                    onClick={() => { setBotMode('app'); setWebhookUrl(''); }}
                  >
                    <div>
                      <div style={{ fontWeight: 700 }}>
                        {provider === 'feishu' && '✦ 方式 A：飞书自建应用（双向全能 · 推荐）'}
                        {provider === 'dingtalk' && '✦ 方式 A：钉钉企业内部应用（双向 · 推荐）'}
                        {provider === 'wecom' && '✦ 方式 A：企业微信自建应用（双向 · 推荐）'}
                      </div>
                      <div className="small" style={{ opacity: 0.85, fontWeight: 400, marginTop: 2 }}>
                        {provider === 'feishu' && <>自带出站主动推送 + 群内命令交互，<b>无需</b>单独填 Webhook</>}
                        {provider === 'dingtalk' && <>通过工作通知推送 + 群内命令交互，<b>无需</b>单独填 Webhook</>}
                        {provider === 'wecom' && <>通过应用消息推送 + 群内命令交互，<b>无需</b>单独填 Webhook</>}
                      </div>
                    </div>
                  </button>

                  <button
                    type="button"
                    className={`btn btn-sm ${botMode === 'webhook' ? 'btn-primary' : 'btn-ghost'}`}
                    style={{ flex: 1, minWidth: 220, padding: '10px 14px', justifyContent: 'flex-start', textAlign: 'left' }}
                    onClick={() => { setBotMode('webhook'); setAppId(''); setAppSecret(''); setAgentId(''); }}
                  >
                    <div>
                      <div style={{ fontWeight: 700 }}>✦ 方式 B：群自定义机器人 Webhook（仅出站）</div>
                      <div className="small" style={{ opacity: 0.85, fontWeight: 400, marginTop: 2 }}>
                        粘贴 Webhook 地址即可接收通知，仅出站不收命令
                      </div>
                    </div>
                  </button>
                </div>
              </div>
            )}

            {/* 推送事件（共用）。微信客服整段隐藏：客服消息有 48 小时窗口规则，
                这条通道只能「回复」不能「广播」——摆一排永远不会生效的推送开关是空承诺 */}
            {!isReplyOnlyProvider(provider) && (<>
            <div className="stack" style={{ gap: 6 }}>
              <span className="small muted">推送哪些事件</span>
              <div className="wrap" style={{ gap: 8 }}>
                {PUSH_EVENTS.map((ev) => (
                  <label key={ev.key} className="row" style={{ gap: 6, alignItems: 'center', cursor: 'pointer' }} title={ev.desc}>
                    <input type="checkbox" checked={events.includes(ev.key)} onChange={() => toggleEvent(ev.key)} />
                    <span className="small">{ev.name}</span>
                  </label>
                ))}
              </div>
            </div>
            </>)}

            {/* 入站命令白名单：群里谁都能发消息给机器人，放开哪些由管理员决定。
                ⚠️ 不在上面那个 wechat_kf 隐藏段里：1.3.14 把它和推送开关一起藏了，
                微信客服的管理员从此没有任何地方能改「允许哪些操作」——而它恰恰是对外渠道最该改的一项 */}
            <div className="stack" style={{ gap: 6 }}>
              <span className="small muted">
                {isExternalProvider(provider) ? '允许哪些操作' : '群里允许哪些操作'}
                <span style={{ marginLeft: 6, opacity: 0.75 }}>
                  {isExternalProvider(provider)
                    ? '（拿到二维码 / 加了这个号的任何微信用户都能触发，取消勾选即关闭）'
                    : '（群成员都能触发，取消勾选即在群里关闭）'}
                </span>
              </span>
              <div className="stack" style={{ gap: 4 }}>
                {TOGGLEABLE_COMMANDS.map((c) => (
                  <label
                    key={c.key}
                    className="row"
                    style={{ gap: 8, alignItems: 'flex-start', cursor: 'pointer', lineHeight: 1.5 }}
                  >
                    <input
                      type="checkbox"
                      style={{ marginTop: 3, flexShrink: 0 }}
                      checked={commands.includes(c.key)}
                      onChange={() => toggleCommand(c.key)}
                    />
                    <span className="small">
                      <b>{c.name}</b>
                      <code className="mono" style={{ margin: '0 6px', opacity: 0.8 }}>{c.trigger}</code>
                      <span className="muted">{c.desc}</span>
                      {c.warn && (
                        <span style={{ color: 'var(--amber, #b45309)', marginLeft: 6, fontWeight: 600 }}>⚠ {c.warn}</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
              <span className="small muted">
                全部取消 = 群里只剩 <code className="mono">/帮助</code>（留着它，机器人才不至于变成一个不响的黑箱）。
              </span>
            </div>

            {/* 定时推送时间（只答不推的渠道同样隐藏） */}
            {!isReplyOnlyProvider(provider) && (<>
            <div className="stack" style={{ gap: 6 }}>
              <span className="small muted">每日定时推送时间</span>
              <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
                {['08:30', '09:00', '12:00', '18:00', '21:00'].map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`btn btn-sm ${pushSchedule === t ? 'btn-primary' : 'btn-ghost'}`}
                    onClick={() => setPushSchedule(t)}
                  >
                    {t}
                  </button>
                ))}
                <input
                  className="input"
                  style={{ width: 110, padding: '6px 10px' }}
                  value={pushSchedule}
                  onChange={(e) => setPushSchedule(e.target.value)}
                  placeholder="如 09:00"
                />
                <span className="small muted">（北京时间，每日此时刻自动推送今日精选热点与推荐选题；可填多个，用逗号隔开）</span>
              </div>
            </div>
            </>)}

            {/* 钉钉群 Webhook */}
            {provider === 'dingtalk' && botMode === 'webhook' && (
              <div className="stack" style={{ gap: 8, padding: '12px 14px', background: 'var(--surface-2)', borderRadius: 8 }}>
                <div className="small"><b>钉钉群自定义机器人 Webhook</b>（仅出站推送）</div>
                <div className="small muted">
                  在钉钉群 ➔ 智能群助手 ➔ 添加机器人 ➔ 选择「自定义」，完成安全设置（推荐勾选「加签」），复制 Webhook 粘进来。
                </div>
                <input
                  className="input"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder="https://oapi.dingtalk.com/robot/send?access_token=xxxx"
                />
                <input
                  className="input"
                  value={signSecret}
                  onChange={(e) => setSignSecret(e.target.value)}
                  placeholder={editing?.hasSignSecret ? '加签密钥 SEC...（留空=不改）' : '加签密钥 SEC...（安全设置勾选了「加签」才填，可选）'}
                />
              </div>
            )}

            {/* 钉钉自建应用 */}
            {provider === 'dingtalk' && botMode === 'app' && (
              <div className="stack" style={{ gap: 14, padding: '14px 16px', background: 'var(--surface-2)', borderRadius: 8 }}>
                <div className="alert-gradient-brand" style={{ padding: '10px 14px' }}>
                  <div className="small" style={{ color: 'var(--brand)', fontWeight: 600 }}>
                    💡 已选择钉钉企业内部应用模式：通过工作通知 API 主动推送消息到全员，<b>无需</b>单独配置群自定义机器人 Webhook！
                  </div>
                </div>

                <div className="stack" style={{ gap: 6 }}>
                  <div className="small">
                    <b style={{ color: 'var(--brand)' }}>① 创建钉钉企业内部应用</b>，获取 AppKey / AppSecret / AgentId
                  </div>
                  <a href="https://open-dev.dingtalk.com/fe/app" target="_blank" rel="noreferrer" className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start', color: 'var(--accent)' }}>
                    ↗ 打开钉钉开放平台
                  </a>
                  <input className="input" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="AppKey（用于获取 access_token）" />
                  <input className="input" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder={secretHint(editing?.hasAppSecret, 'AppSecret', 'AppSecret')} />
                  <input className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)} placeholder="AgentId（应用详情页可查，工作通知用）" />
                </div>

                <div className="stack" style={{ gap: 6 }}>
                  <div className="small">
                    <b style={{ color: 'var(--accent)' }}>② 开通权限并发布</b>
                  </div>
                  <div className="small muted" style={{ lineHeight: 1.8, background: 'var(--surface)', padding: '12px 14px', borderRadius: 8, border: '1px solid var(--border)' }}>
                    · 在「权限管理」中开通 <b>「企业内部机器人发送消息」</b> 和 <b>「通讯录个人信息读权限」</b><br />
                    · 在「应用功能」➔「机器人」中启用机器人能力<br />
                    · 在「版本管理与发布」中创建版本并发布，然后将机器人添加到群中
                  </div>
                </div>

                <div className="stack" style={{ gap: 8 }}>
                  <div className="small">
                    <b style={{ color: 'var(--green)' }}>③ 配置机器人消息接收地址（群内 ChatOps 命令）</b>
                  </div>
                  <div className="small muted" style={{ background: 'var(--surface)', padding: '12px 14px', borderRadius: 8, border: '1px solid var(--border)', lineHeight: 1.8 }}>
                    在「应用功能」➔「机器人」➔ <b>「消息接收地址」</b>（HTTP 模式）中粘贴下方地址。
                    配好后在群里 @机器人 即可触发 ChatOps 命令。
                  </div>
                  <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
                    <code className="small mono" style={{ background: 'var(--surface)', padding: '8px 12px', borderRadius: 8, wordBreak: 'break-all', flex: 1, minWidth: 220, border: '1px solid var(--border)' }}>
                      {callbackUrl}
                    </code>
                    <button className="btn btn-sm btn-primary" onClick={copyCallback} disabled={!appId.trim()} title={appId.trim() ? '' : '先填上面的 AppKey'}>
                      {copied ? '已复制地址' : '复制回调地址'}
                    </button>
                  </div>
                </div>

                <div className="small muted" style={{ lineHeight: 1.7, background: 'var(--surface)', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)' }}>
                  <b>推送方式：</b>通过钉钉「工作通知」推送到全员的钉钉消息列表。<br />
                  <b>群内命令：</b>在群里 @机器人 发消息即可触发收录/查询等 ChatOps 指令。
                </div>
              </div>
            )}

            {/* 企业微信群 Webhook */}
            {provider === 'wecom' && botMode === 'webhook' && (
              <div className="stack" style={{ gap: 8, padding: '12px 14px', background: 'var(--surface-2)', borderRadius: 8 }}>
                <div className="small"><b>企业微信群自定义机器人 Webhook</b>（仅出站推送）</div>
                <div className="small muted">
                  在企业微信群 ➔ 右上角「...」 ➔ 添加群机器人 ➔ 新建群机器人，复制 Webhook 地址粘贴进来。
                </div>
                <input
                  className="input"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx"
                />
              </div>
            )}

            {/* 企业微信自建应用 */}
            {provider === 'wecom' && botMode === 'app' && (
              <div className="stack" style={{ gap: 14, padding: '14px 16px', background: 'var(--surface-2)', borderRadius: 8 }}>
                <div className="alert-gradient-brand" style={{ padding: '10px 14px' }}>
                  <div className="small" style={{ color: 'var(--brand)', fontWeight: 600 }}>
                    💡 已选择企业微信自建应用模式：通过应用消息 API 主动推送到全员，<b>无需</b>单独配置群机器人 Webhook！
                  </div>
                </div>

                <div className="stack" style={{ gap: 6 }}>
                  <div className="small">
                    <b style={{ color: 'var(--brand)' }}>① 创建企业微信自建应用</b>，获取 CorpID / AgentID / Secret
                  </div>
                  <a href="https://work.weixin.qq.com/wework_admin/frame#apps/createApiApp" target="_blank" rel="noreferrer" className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start', color: 'var(--accent)' }}>
                    ↗ 打开企业微信管理后台
                  </a>
                  <div className="small muted" style={{ lineHeight: 1.6 }}>
                    · <b>CorpID：</b>在「我的企业」➔「企业信息」底部查看<br />
                    · <b>AgentID / Secret：</b>在「应用管理」➔ 点击你的自建应用查看
                  </div>
                  <input className="input" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="CorpID（企业 ID，如 wwXXXXXXXXXX）" />
                  <input className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)} placeholder="AgentID（应用 ID，如 1000002）" />
                  <input className="input" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder={secretHint(editing?.hasAppSecret, 'Secret', 'Secret（应用的 Secret）')} />
                </div>

                <div className="stack" style={{ gap: 6 }}>
                  <div className="small">
                    <b style={{ color: 'var(--accent)' }}>② 设置可见范围</b>
                  </div>
                  <div className="small muted" style={{ lineHeight: 1.8, background: 'var(--surface)', padding: '12px 14px', borderRadius: 8, border: '1px solid var(--border)' }}>
                    · 在应用详情页设置 <b>「可见范围」</b>：选择哪些部门/人员可以收到消息<br />
                    · 在 <b>「开发者接口」</b> 中确认「发送应用消息」等 API 权限已开通
                  </div>
                </div>

                <div className="stack" style={{ gap: 8 }}>
                  <div className="small">
                    <b style={{ color: 'var(--green)' }}>③ 设置「接收消息」回调（群内 ChatOps 命令）</b>
                  </div>
                  <div className="small muted" style={{ background: 'var(--surface)', padding: '12px 14px', borderRadius: 8, border: '1px solid var(--border)', lineHeight: 1.8 }}>
                    在应用详情 ➔ <b>「开发者接口」➔「接收消息」</b> 中：<br />
                    · 设置 <b>URL</b>（粘贴下方地址）<br />
                    · 随机生成 <b>Token</b> 和 <b>EncodingAESKey</b>，复制填入下方<br />
                    · 点击保存，企微会自动验证 URL 连通性
                  </div>
                  <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
                    <code className="small mono" style={{ background: 'var(--surface)', padding: '8px 12px', borderRadius: 8, wordBreak: 'break-all', flex: 1, minWidth: 220, border: '1px solid var(--border)' }}>
                      {callbackUrl}
                    </code>
                    <button className="btn btn-sm btn-primary" onClick={copyCallback} disabled={!appId.trim() || !agentId.trim()} title={appId.trim() && agentId.trim() ? '' : '先填上面的 CorpID 和 AgentID'}>
                      {copied ? '已复制地址' : '复制回调地址'}
                    </button>
                  </div>
                  <input className="input" value={verificationToken} onChange={(e) => setVerificationToken(e.target.value)} placeholder={secretHint(editing?.hasVerificationToken, 'Token', 'Token（企微后台随机生成，必填）')} />
                  <input className="input" value={encryptKey} onChange={(e) => setEncryptKey(e.target.value)} placeholder={secretHint(editing?.hasEncryptKey, 'EncodingAESKey', 'EncodingAESKey（企微后台随机生成，必填）')} />
                </div>

                <div className="small muted" style={{ lineHeight: 1.7, background: 'var(--surface)', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)' }}>
                  <b>推送方式：</b>通过企业微信「应用消息」推送到全员。<br />
                  <b>ChatOps：</b>用户在应用对话中发消息即可触发收录/查询等指令。
                </div>
              </div>
            )}

            {/* Telegram Bot */}
            {provider === 'telegram' && (
              <div className="stack" style={{ gap: 8, padding: '12px 14px', background: 'var(--surface-2)', borderRadius: 8 }}>
                <div className="small"><b>Telegram Bot API 推送设置</b></div>
                <div className="small muted">
                  向 Telegram 中的 @BotFather 发送 /newbot 创建 Bot 获取 Token，再将 Bot 拉入群组获取 Chat ID，粘贴完整 API URL。
                </div>
                <input
                  className="input"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder="https://api.telegram.org/bot<token>/sendMessage?chat_id=<chat_id>"
                />
              </div>
            )}

            {/* Slack Incoming Webhooks */}
            {provider === 'slack' && (
              <div className="stack" style={{ gap: 8, padding: '12px 14px', background: 'var(--surface-2)', borderRadius: 8 }}>
                <div className="small"><b>Slack Incoming Webhooks 推送设置</b></div>
                <div className="small muted">
                  进入 Slack API Console ➔ Incoming Webhooks ➔ 开启并生成应用 Webhook URL 粘贴进来。
                </div>
                <input
                  className="input"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder="https://hooks.slack.com/services/T.../B.../..."
                />
              </div>
            )}

            {/* 飞书 Webhook */}
            {provider === 'feishu' && botMode === 'webhook' && (
              <div className="stack" style={{ gap: 6, padding: '12px 14px', background: 'var(--surface-2)', borderRadius: 8 }}>
                <span className="small"><b>飞书群自定义机器人 Webhook</b>（仅出站推送）</span>
                <span className="small muted">在飞书群 → 设置 → 群机器人 → 添加「自定义机器人」，复制 Webhook 粘贴进来即可。</span>
                <input className="input" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder="群自定义机器人 webhook：https://open.feishu.cn/open-apis/bot/v2/hook/xxxx" />
                <input className="input" value={signSecret} onChange={(e) => setSignSecret(e.target.value)}
                  placeholder={editing?.hasSignSecret ? '签名密钥（留空=不改）' : '签名密钥（开了「签名校验」才填，可选）'} />
              </div>
            )}

            {/* 微信客服（官方通道）配置分段。字段复用 appId(CorpID)/appSecret(客服Secret)/
                verificationToken/encryptKey 四个既有状态——它们语义完全一致，另起四个状态
                只会让 save 的收口多一倍分支 */}
            {provider === 'wechat_kf' && (
              <div className="stack" style={{ gap: 12, padding: '14px 16px', background: 'var(--surface-2)', borderRadius: 8 }}>
                <div className="alert-gradient-brand" style={{ padding: '10px 14px' }}>
                  <div className="small" style={{ color: 'var(--brand)', fontWeight: 600 }}>
                    💡 官方微信客服通道：微信用户直接和机器人一对一对话（提问、发链接收录、/命令都能用）。
                    没有定时推送——客服消息有 48 小时窗口规则，这条通道只答不推。
                  </div>
                </div>
                <div className="small muted" style={{ lineHeight: 1.7 }}>
                  {/* 两条微信路的分工写在做决定的地方：自己用 → 「微信」卡扫码即绑；对外接客 → 这条客服通道 */}
                  想让<b>自己的微信</b>直接和机器人聊，用旁边的「微信」卡（微信官方 iLink 接口，扫码即绑，什么都不用填）。
                  这条「微信客服」是给<b>对外服务</b>场景的：客户扫你企业的客服码找你，走企业微信。
                </div>
                <div className="small" style={{ lineHeight: 1.7, padding: '8px 12px', background: 'var(--amber-soft, #fff7e6)', borderRadius: 8 }}>
                  ⚠️ 这是<b>对外渠道</b>：拿到客服二维码的任何微信用户都能和机器人对话。所以「登录/绑定」在这条通道上不响应、派任务不可用；
                  新建时下方「允许哪些操作」默认只开对话 / 剪藏 / 收录 / 热榜——账号体检、切换账号、竞对监控、记忆优化这些会外泄账号数据或动租户配置，看清楚再勾。
                </div>
                <details className="stack" style={{ gap: 6 }} open={!editing}>
                  <summary className="small" style={{ cursor: 'pointer' }}>
                    <b style={{ color: 'var(--brand)' }}>如何开通（企业微信管理后台，约 5 分钟）</b>
                    <span className="muted" style={{ marginLeft: 6 }}>（点开看步骤）</span>
                  </summary>
                  <div className="small muted" style={{ lineHeight: 1.9, marginTop: 8, background: 'var(--surface)', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)' }}>
                    ① 企业微信管理后台 ➔ <b>应用管理 ➔ 微信客服</b>，开通并新建一个客服账号（这就是微信用户看到的对话方）<br />
                    ② 在「微信客服 ➔ API」里创建 <b>Secret</b>，把 <b>企业 CorpID</b>（我的企业页可查）和它填到下面<br />
                    ③ 配置回调：URL 填下方地址，<b>Token / EncodingAESKey</b> 点「随机生成」后同步填到下面 ➔ 保存<br />
                    ④ 把客服账号的二维码/链接发给你的微信用户——扫码进入的是<b>官方客服会话</b>，不碰任何个人号
                  </div>
                </details>
                <div className="small">
                  回调 URL（第 ③ 步粘贴）：<code className="mono" style={{ wordBreak: 'break-all' }}>{callbackUrl}</code>
                </div>
                <div className="row wrap" style={{ gap: 8 }}>
                  <input className="input" value={appId} onChange={(e) => setAppId(e.target.value)}
                    placeholder="企业 CorpID（ww 开头）" style={{ minWidth: 220, flex: 1 }} />
                  <input className="input" value={appSecret} onChange={(e) => setAppSecret(e.target.value)}
                    placeholder={editing?.hasAppSecret ? '微信客服 Secret（留空=不改）' : '微信客服 Secret'} style={{ minWidth: 220, flex: 1 }} />
                </div>
                <div className="row wrap" style={{ gap: 8 }}>
                  <input className="input" value={verificationToken} onChange={(e) => setVerificationToken(e.target.value)}
                    placeholder={editing?.hasVerificationToken ? '回调 Token（留空=不改）' : '回调 Token'} style={{ minWidth: 220, flex: 1 }} />
                  <input className="input" value={encryptKey} onChange={(e) => setEncryptKey(e.target.value)}
                    placeholder={editing?.hasEncryptKey ? 'EncodingAESKey（留空=不改）' : 'EncodingAESKey（43 位）'} style={{ minWidth: 220, flex: 1 }} />
                </div>
                {editing?.inboundKey && (
                  <div className="small" style={{ color: editing.lastInboundAt ? 'var(--green)' : 'var(--muted)' }}>
                    {editing.lastInboundAt
                      ? `✅ 通道已通，最近收到微信消息 ${fmtDateTime(editing.lastInboundAt)}`
                      : '⏳ 已保存，等第一条微信消息进来（用微信扫客服账号二维码发句话试试）'}
                  </div>
                )}
              </div>
            )}

            {/* 微信（iLink）编辑态：绑定状态 + 重新扫码。凭据没有可填的——它们全来自扫码 */}
            {provider === 'wechat' && editing && (
              <div className="stack" style={{ gap: 12, padding: '14px 16px', background: 'var(--surface-2)', borderRadius: 8 }}>
                <WechatIlinkConnect
                  existing={{ id: editing.id, ilinkUserId: editing.ilinkUserId, ilinkExpired: editing.ilinkExpired }}
                  onDone={() => { flash('已重新绑定'); router.refresh(); }}
                />
              </div>
            )}

            {/* 方式 A 专属：飞书自建应用入站/出站二合一分步向导 */}
            {provider === 'feishu' && botMode === 'app' && (
              <div className="stack" style={{ gap: 14, padding: '14px 16px', background: 'var(--surface-2)', borderRadius: 8 }}>
                <div className="alert-gradient-brand" style={{ padding: '10px 14px' }}>
                  <div className="small" style={{ color: 'var(--brand)', fontWeight: 600 }}>
                    💡 已选择飞书自建应用模式：自建应用通过飞书 OpenAPI 已原生支持主动推送消息到群里，<b>无需</b>单独设置群自定义机器人 Webhook 地址！
                  </div>
                </div>

                {editing?.inboundKey && (
                  <div className="small" style={{ color: editing.lastInboundAt ? 'var(--green)' : 'var(--amber)' }}>
                    {editing.lastInboundAt
                      ? `✅ 入站与出站已通，最近收到消息 ${fmtDateTime(editing.lastInboundAt)}`
                      : '⏳ 已保存，等飞书发来第一条消息（去群里 @机器人 发「/帮助」试试）'}
                  </div>
                )}

                {/* 步骤 1 */}
                <div className="stack" style={{ gap: 6 }}>
                  <div className="small">
                    <b style={{ color: 'var(--brand)' }}>① 建飞书自建应用</b>，获取 App ID / App Secret
                  </div>
                  <a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer" className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start', color: 'var(--accent)' }}>
                    ↗ 打开飞书开放平台
                  </a>
                  <input className="input" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="App ID（cli_xxx，用于把事件路由到本工作区）" />
                  <input className="input" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder={secretHint(editing?.hasAppSecret, 'App Secret', 'App Secret（机器人回消息用）')} />
                </div>

                {/* 步骤 2 */}
                <div className="stack" style={{ gap: 8 }}>
                  <div className="small">
                    <b style={{ color: 'var(--accent)' }}>② 设置「事件订阅」的 订阅方式 / 回调配置</b>
                  </div>
                  <div className="small muted" style={{ background: 'var(--surface)', padding: '12px 14px', borderRadius: 8, lineHeight: 1.8, border: '1px solid var(--border)' }}>
                    <div style={{ marginBottom: 8 }}>
                      📌 <b>飞书后台路径：</b>
                      <span style={{ color: 'var(--accent)', fontWeight: 700 }}>「开发配置」➔「事件订阅」</span>
                    </div>
                    
                    <div style={{ marginBottom: 10, padding: '8px 10px', background: 'var(--surface-2)', borderRadius: 6 }}>
                      <b>订阅方式选择（页面最上方）：</b><br />
                      <span style={{ color: '#2563eb', fontWeight: 700 }}>✦ 模式 A（推荐 HTTP 回调）：发送事件至开发者服务器</span><br />
                      <span className="small muted" style={{ display: 'block', marginLeft: 14, marginBottom: 4 }}>
                        要在下方<b>「回调配置」</b>标签页填写 HTTP 接收地址。
                      </span>
                      <span style={{ color: '#16a34a', fontWeight: 700 }}>✦ 模式 B（WebSocket 长连接）：使用长连接发送事件至开发者服务器</span><br />
                      <span className="small muted" style={{ display: 'block', marginLeft: 14 }}>
                        勾选此项后免公网 IP 地址，系统将直接通过 Socket 建立长通道拉取事件。
                      </span>
                    </div>

                    <div style={{ marginTop: 6 }}>
                      👉 <b>在「回调配置」标签页填写（模式 A 专属）：</b><br />
                      点击标签页 <span style={{ color: '#2563eb', fontWeight: 700, background: '#e8f0fe', padding: '2px 6px', borderRadius: 4 }}>「回调配置」</span> ➔ 将下方生成的 URL 粘贴至 <b>「请求地址」</b> 栏中。
                    </div>
                  </div>

                  <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
                    <code className="small mono" style={{ background: 'var(--surface)', padding: '8px 12px', borderRadius: 8, wordBreak: 'break-all', flex: 1, minWidth: 220, border: '1px solid var(--border)' }}>
                      {callbackUrl}
                    </code>
                    <button className="btn btn-sm btn-primary" onClick={copyCallback} disabled={!appId.trim()} title={appId.trim() ? '' : '先填上面的 App ID'}>
                      {copied ? '已复制地址' : '复制回调地址'}
                    </button>
                  </div>
                  <div className="small muted">飞书会自动打一次校验，成功后再填入下面飞书给的两项密钥：</div>
                  <input className="input" value={verificationToken} onChange={(e) => setVerificationToken(e.target.value)} placeholder={secretHint(editing?.hasVerificationToken, 'Verification Token', 'Verification Token（校验 Token，必填）')} />
                  <input className="input" value={encryptKey} onChange={(e) => setEncryptKey(e.target.value)} placeholder={secretHint(editing?.hasEncryptKey, 'Encrypt Key', 'Encrypt Key（开了「消息加密」才填，可选）')} />
                </div>

                {/* 步骤 3——纯操作说明折进 details（2026-09-01「不能扫码就清爽」）：
                    首次接入的人点开照做；配好回来编辑的人不用每次隔着一屏说明找按钮 */}
                <details className="stack" style={{ gap: 8 }} open={!editing}>
                  <summary className="small" style={{ cursor: 'pointer' }}>
                    <b style={{ color: 'var(--green)' }}>③ 在「事件配置」标签页添加事件 + 授权发布</b>
                    <span className="muted" style={{ marginLeft: 6 }}>（点开看图文步骤）</span>
                  </summary>
                  <div className="small muted" style={{ lineHeight: 1.8, background: 'var(--surface)', padding: '12px 14px', borderRadius: 8, border: '1px solid var(--border)', marginTop: 8 }}>
                    · 👉 <b>在「事件配置」标签页操作：</b><br />
                    &nbsp;&nbsp;点击标签页 <span style={{ color: '#e8552d', fontWeight: 700, background: '#fdece6', padding: '2px 6px', borderRadius: 4 }}>「事件配置」</span> ➔ 点击 <b>「添加事件」</b> 按钮 ➔ 搜索并添加 <code className="mono" style={{ color: '#e8552d', fontWeight: 700 }}>im.message.receive_v1</code>（接收消息）<br />
                    · <b>开通权限：</b>在 <b>「权限管理」</b> 开启 <b>「获取与发送单聊、群组消息」</b>
                    和 <b>「获取群组信息」</b><code className="mono" style={{ color: '#e8552d', fontWeight: 700 }}>im:chat:readonly</code>
                    <span style={{ color: 'var(--red)' }}>（主动推送必需，缺它会报「机器人未加入任何群聊」）</span><br />
                    · <b>发布机器人：</b>在 <b>「应用功能」</b> 添加 <b>「机器人」</b> ➔ 在 <b>「版本管理与发布」</b> 创建版本发布 ➔ 将机器人拉入飞书群
                  </div>
                </details>

                {/* 💡 飞书权限与事件一键配置 (Manifest JSON 与 手动勾选指南) */}
                <div className="stack" style={{ gap: 10, padding: '14px 16px', background: 'rgba(37, 99, 235, 0.05)', borderRadius: 8, border: '1px solid rgba(37, 99, 235, 0.18)' }}>
                  <div className="row-between wrap" style={{ gap: 8, alignItems: 'center' }}>
                    <span className="small" style={{ color: '#2563eb', fontWeight: 700, fontSize: 13.5 }}>
                      💡 飞书权限与事件配置（支持 App Manifest JSON 一键导入）
                    </span>
                    <button
                      className="btn btn-sm"
                      style={{ background: '#2563eb', color: '#fff', border: 'none' }}
                      onClick={() => {
                        const json = JSON.stringify({
                          manifest_version: "1.0.0",
                          app_config: {
                            scopes: [
                              "im:message",
                              "im:message.group_at_msg:readonly",
                              "im:message.p2p_msg:readonly",
                              "im:message:send_as_bot",
                              // 主动推送要先列出机器人所在群 → 必须有群信息读权限，缺它会报 99991672
                              "im:chat:readonly"
                            ],
                            events: [
                              "im.message.receive_v1"
                            ]
                          }
                        }, null, 2);
                        navigator.clipboard.writeText(json);
                        flash('已复制 Manifest JSON！应用创建或配置时粘贴即可');
                      }}
                    >
                      一键复制 Manifest JSON 配置文件
                    </button>
                  </div>

                  <div className="stack" style={{ gap: 8, fontSize: 12.5, lineHeight: 1.7 }}>
                    <div style={{ background: 'var(--surface)', padding: '10px 12px', borderRadius: 6, border: '1px solid var(--border)' }}>
                      <b style={{ color: '#2563eb' }}>✦ 场景 A：新建应用时（推荐 1 秒配置）：</b><br />
                      进入飞书开放平台 ➔ 点击右上角 <b>「创建应用」➔ 选择「通过 App Manifest 创建」</b> ➔ 粘贴此 JSON，自动建好应用并自动勾选机器人、权限与事件。
                    </div>

                    <div style={{ background: 'var(--surface)', padding: '10px 12px', borderRadius: 6, border: '1px solid var(--border)' }}>
                      <b style={{ color: '#2563eb' }}>✦ 场景 B：已有应用配置：</b><br />
                      <b>方式 1（Manifest 导入）：</b>进入应用 ➔ 点击左侧 <b>「开发配置」➔「应用配置」/「App Manifest」</b> ➔ 粘贴 JSON 保存。<br />
                      <b>方式 2（分步手选点选）：</b>若后台无 Manifest 入口，请手动勾选：
                      <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                        <li><b>权限管理：</b>添加 <code className="mono" style={{ color: '#e8552d' }}>im:message</code>（消息读写）、<code className="mono" style={{ color: '#e8552d' }}>im:message:send_as_bot</code>（以机器人发送）、<code className="mono" style={{ color: '#e8552d' }}>im:chat:readonly</code>（获取群组信息）</li>
                        <li><b>事件订阅：</b>添加 <code className="mono" style={{ color: '#e8552d' }}>im.message.receive_v1</code>（接收消息 v2.0）</li>
                      </ul>
                    </div>
                  </div>
                </div>

                <details className="small muted" style={{ lineHeight: 1.7, background: 'var(--surface)', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)' }}>
                  <summary style={{ cursor: 'pointer' }}><b>装好后在群里怎么用？</b><span style={{ marginLeft: 4, opacity: 0.7 }}>点开看全部玩法与命令</span></summary>
                  <div style={{ marginTop: 6 }}>@它直接问问题=对话（记得住上下文）；发文章链接/粘正文=抓正文存档并出摘要要点；发短文本=收录成选题候选；命令
                  <code className="mono">/分析 [账号名]</code> <code className="mono">/存 链接</code> <code className="mono">/竞对</code> <code className="mono">/拆解 链接</code> <code className="mono">/问 你的问题</code> <code className="mono">/账号 名字</code> <code className="mono">/热点</code> <code className="mono">/选题 关键词</code> <code className="mono">/采集 竞对主页URL</code> <code className="mono">/优化</code> <code className="mono">/帮助</code>。
                  <b>只进候选池、不自动发布，生成仍全程过合规。</b>
                </div>
                </details>
              </div>
            )}

            {/* 渠道默认智能体（对应 Accio 弹窗的「会话默认插件」位）：
                群里 @机器人 的对话以它出面；不选 = 通用运营助手。渠道卡上也能随时改 */}
            <div className="stack" style={{ gap: 6 }}>
              <span className="small muted">渠道默认智能体</span>
              <select className="input" value={agentTpl} onChange={(e) => setAgentTpl(e.target.value)} style={{ maxWidth: 340 }}>
                <option value="">通用运营助手（默认）</option>
                {agentOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>

            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-sm btn-primary" onClick={save} disabled={pending}>{pending ? '保存中…' : '保存'}</button>
              <button className="btn btn-sm btn-ghost" onClick={() => { setShowForm(false); resetForm(); }} disabled={pending}>取消</button>
              {msg && <span className="small" style={{ color: failed ? 'var(--red)' : 'var(--muted)' }}>{msg}</span>}
            </div>
          </div>
          )}
        </div>
        </Overlay>
      ) : (
        <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
          <button className="btn btn-sm btn-primary" onClick={openAdd} disabled={pending}>+ 配置机器人</button>
          {rows.length === 0 && <span className="small muted">支持飞书、钉钉、企业微信——自建应用或群 Webhook 均可</span>}
          {msg && !showForm && <span className="small" style={{ color: failed ? 'var(--red)' : 'var(--muted)' }}>{msg}</span>}
        </div>
      )}
    </div>
  );
}
