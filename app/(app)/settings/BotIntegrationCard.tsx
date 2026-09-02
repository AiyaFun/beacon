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
  const [modalTab, setModalTab] = useState<'basic' | 'commands' | 'push' | 'guide'>('basic');
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
    setModalTab('basic');
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
    setModalTab('basic');
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

      {/* 新增/编辑弹窗：现代大气选项卡设计 */}
      {showForm ? (
        <Overlay label={editing ? '设置机器人' : '连接渠道'} onClose={() => { setShowForm(false); resetForm(); }}>
        <div className="dialog-card" style={{ width: 'min(780px, 95vw)', maxHeight: '88vh', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden', borderRadius: 16, boxShadow: 'var(--shadow-lg)' }}>
          {/* 弹窗头部 */}
          <div style={{ padding: '18px 24px 14px', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
            <div className="row-between" style={{ alignItems: 'center' }}>
              <div className="row" style={{ gap: 12, alignItems: 'center' }}>
                <ChannelLogo provider={provider} size={42} fallback={botProviderName(provider)} />
                <div>
                  <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                    <b style={{ fontSize: 17, fontWeight: 700 }}>
                      {editing ? `设置机器人 · ${editing.label || botProviderName(provider)}` : `连接 ${botProviderName(provider)}`}
                    </b>
                    {(provider === 'feishu' || provider === 'dingtalk' || provider === 'wecom') && (
                      <span className={`badge ${botMode === 'app' ? 'badge-brand' : 'badge-gray'}`} style={{ fontSize: 11, fontWeight: 600 }}>
                        {botMode === 'app' ? '自建应用 · 双向' : 'Webhook · 仅出站'}
                      </span>
                    )}
                    {isReplyOnlyProvider(provider) && (
                      <span className="badge badge-blue" style={{ fontSize: 11 }}>官方通道 · 只答不推</span>
                    )}
                  </div>
                  <div className="small muted" style={{ marginTop: 2 }}>
                    {editing ? '管理该机器人的平台凭据、指令准入范围与定时推送策略' : '完成平台凭据与回调配置，即可在群内使用 AI 助手与接收推送'}
                  </div>
                </div>
              </div>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                style={{ width: 32, height: 32, padding: 0, borderRadius: '50%', fontSize: 16, display: 'grid', placeItems: 'center' }}
                aria-label="关闭"
                onClick={() => { setShowForm(false); resetForm(); }}
                disabled={pending}
              >
                ✕
              </button>
            </div>

            {/* 顶部选项卡导航（微信扫码新接入除外） */}
            {!(provider === 'wechat' && !editing) && (
              <div style={{ display: 'flex', gap: 6, marginTop: 14, background: 'var(--surface-2)', padding: 4, borderRadius: 10 }}>
                <button
                  type="button"
                  className={`btn btn-sm ${modalTab === 'basic' ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ flex: 1, padding: '7px 12px', fontSize: 13, fontWeight: modalTab === 'basic' ? 600 : 500 }}
                  onClick={() => setModalTab('basic')}
                >
                  🔌 基础与连接
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${modalTab === 'commands' ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ flex: 1, padding: '7px 12px', fontSize: 13, fontWeight: modalTab === 'commands' ? 600 : 500 }}
                  onClick={() => setModalTab('commands')}
                >
                  🛡️ 指令权限 <span style={{ opacity: 0.8, fontSize: 11, marginLeft: 4 }}>({commands.length})</span>
                </button>
                {!isReplyOnlyProvider(provider) && (
                  <button
                    type="button"
                    className={`btn btn-sm ${modalTab === 'push' ? 'btn-primary' : 'btn-ghost'}`}
                    style={{ flex: 1, padding: '7px 12px', fontSize: 13, fontWeight: modalTab === 'push' ? 600 : 500 }}
                    onClick={() => setModalTab('push')}
                  >
                    🔔 定时推送 <span style={{ opacity: 0.8, fontSize: 11, marginLeft: 4 }}>({events.length})</span>
                  </button>
                )}
                {(provider === 'feishu' || provider === 'dingtalk' || provider === 'wecom' || provider === 'wechat_kf') && (
                  <button
                    type="button"
                    className={`btn btn-sm ${modalTab === 'guide' ? 'btn-primary' : 'btn-ghost'}`}
                    style={{ flex: 1, padding: '7px 12px', fontSize: 13, fontWeight: modalTab === 'guide' ? 600 : 500 }}
                    onClick={() => setModalTab('guide')}
                  >
                    📖 接入指引 {provider === 'feishu' && <span style={{ color: 'var(--brand)', fontWeight: 700, marginLeft: 2 }}>⚡ 1秒导入</span>}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* 弹窗内容区：独立滚动 */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', background: 'var(--bg)' }}>
            {/* 微信（iLink）新接入：直接扫码 */}
            {provider === 'wechat' && !editing ? (
              <div style={{ background: 'var(--surface)', padding: 24, borderRadius: 12, border: '1px solid var(--border)' }}>
                <WechatIlinkConnect
                  existing={null}
                  autoStart
                  onDone={() => { router.refresh(); }}
                />
              </div>
            ) : (
              <>
                {/* ═══════════════ TAB 1: 基础与连接 ═══════════════ */}
                {modalTab === 'basic' && (
                  <div className="stack" style={{ gap: 16 }}>
                    {/* 已保存密钥提示栏（编辑态） */}
                    {editing && (editing.hasInboundSecrets || editing.hasSignSecret) && (
                      <div style={{ background: 'var(--surface)', padding: '12px 16px', borderRadius: 10, border: '1px solid var(--border)' }}>
                        <div className="row-between" style={{ alignItems: 'center', marginBottom: 8 }}>
                          <span style={{ fontSize: 13, fontWeight: 600 }}>🔒 已加密存储的凭据</span>
                          <button type="button" className="btn btn-sm btn-ghost" onClick={toggleReveal} disabled={pending} style={{ fontSize: 12 }}>
                            {revealed ? '🙈 隐藏明文' : '👁 显示明文'}
                          </button>
                        </div>
                        <div className="stack" style={{ gap: 6 }}>
                          {([
                            ['App Secret / Secret', editing.hasAppSecret, editing.maskedAppSecret, 'appSecret'],
                            ['Verification Token', editing.hasVerificationToken, editing.maskedVerificationToken, 'verificationToken'],
                            ['Encrypt Key', editing.hasEncryptKey, editing.maskedEncryptKey, 'encryptKey'],
                            ['出站加签密钥', editing.hasSignSecret, editing.maskedSignSecret, 'signSecret'],
                          ] as const)
                            .filter(([, has]) => has)
                            .map(([name, , masked, field]) => (
                              <div key={field} className="row-between wrap" style={{ gap: 8, alignItems: 'center', fontSize: 12 }}>
                                <span className="muted" style={{ minWidth: 150 }}>{name}</span>
                                <code
                                  className="mono"
                                  style={{
                                    flex: 1, minWidth: 160, wordBreak: 'break-all', padding: '3px 8px', borderRadius: 6,
                                    background: 'var(--surface-2)', border: '1px solid var(--border)',
                                    color: revealed ? 'var(--brand)' : 'var(--text-2)',
                                  }}
                                >
                                  {revealed ? (revealed[field] || '(空)') : masked}
                                </code>
                              </div>
                            ))}
                        </div>
                        <div className="small muted" style={{ marginTop: 8, paddingTop: 6, borderTop: '1px dashed var(--border)', fontSize: 11 }}>
                          下方输入框留空保存即保持原有密钥不变，仅需更换时重新填写。
                          {revealed && <span style={{ color: 'var(--amber)', fontWeight: 600 }}> ⚠ 明文已展示，请注意保护隐私。</span>}
                        </div>
                      </div>
                    )}

                    {/* 基本信息组合卡 */}
                    <div style={{ background: 'var(--surface)', padding: '16px 18px', borderRadius: 12, border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12, color: 'var(--text)' }}>1. 基础信息</div>
                      <div className="grid grid-3" style={{ gap: 12 }}>
                        <label className="stack" style={{ gap: 4 }}>
                          <span className="small muted">平台类型</span>
                          <select className="input" value={provider} onChange={(e) => setProvider(e.target.value)} style={{ padding: '7px 10px' }}>
                            {BOT_PROVIDERS.map((p) => (
                              <option key={p.key} value={p.key} disabled={!p.supported}>{p.name}{p.supported ? '' : '（即将支持）'}</option>
                            ))}
                          </select>
                        </label>
                        <label className="stack" style={{ gap: 4 }}>
                          <span className="small muted">机器人名称（自定义）</span>
                          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="如：选题作战群" style={{ padding: '7px 10px' }} />
                        </label>
                        <label className="stack" style={{ gap: 4 }}>
                          <span className="small muted">渠道默认智能体</span>
                          <select className="input" value={agentTpl} onChange={(e) => setAgentTpl(e.target.value)} style={{ padding: '7px 10px' }}>
                            <option value="">通用运营助手（默认）</option>
                            {agentOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                          </select>
                        </label>
                      </div>
                    </div>

                    {/* 模式选择（飞书/钉钉/企微） */}
                    {(provider === 'feishu' || provider === 'dingtalk' || provider === 'wecom') && (
                      <div style={{ background: 'var(--surface)', padding: '16px 18px', borderRadius: 12, border: '1px solid var(--border)' }}>
                        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>2. 接入模式</div>
                        <div className="grid grid-2" style={{ gap: 10 }}>
                          <div
                            role="button"
                            tabIndex={0}
                            onClick={() => { setBotMode('app'); setWebhookUrl(''); }}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { setBotMode('app'); setWebhookUrl(''); } }}
                            style={{
                              padding: '12px 14px',
                              borderRadius: 10,
                              cursor: 'pointer',
                              border: botMode === 'app' ? '2px solid var(--brand)' : '1px solid var(--border)',
                              background: botMode === 'app' ? 'var(--brand-soft)' : 'var(--surface-2)',
                              transition: 'all 0.15s ease',
                            }}
                          >
                            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                              <input type="radio" checked={botMode === 'app'} onChange={() => {}} style={{ accentColor: 'var(--brand)' }} />
                              <b style={{ fontSize: 13, color: botMode === 'app' ? 'var(--brand)' : 'var(--text)' }}>
                                方式 A：自建企业应用（推荐）
                              </b>
                            </div>
                            <div className="small muted" style={{ marginTop: 4, paddingLeft: 22, lineHeight: 1.5 }}>
                              支持双向交互（群内 @ 问答、指令收录）与主动推送，无需单独配置 Webhook。
                            </div>
                          </div>

                          <div
                            role="button"
                            tabIndex={0}
                            onClick={() => { setBotMode('webhook'); setAppId(''); setAppSecret(''); setAgentId(''); }}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { setBotMode('webhook'); setAppId(''); setAppSecret(''); setAgentId(''); } }}
                            style={{
                              padding: '12px 14px',
                              borderRadius: 10,
                              cursor: 'pointer',
                              border: botMode === 'webhook' ? '2px solid var(--brand)' : '1px solid var(--border)',
                              background: botMode === 'webhook' ? 'var(--brand-soft)' : 'var(--surface-2)',
                              transition: 'all 0.15s ease',
                            }}
                          >
                            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                              <input type="radio" checked={botMode === 'webhook'} onChange={() => {}} style={{ accentColor: 'var(--brand)' }} />
                              <b style={{ fontSize: 13, color: botMode === 'webhook' ? 'var(--brand)' : 'var(--text)' }}>
                                方式 B：群自定义 Webhook
                              </b>
                            </div>
                            <div className="small muted" style={{ marginTop: 4, paddingLeft: 22, lineHeight: 1.5 }}>
                              粘贴 Webhook 地址即可接收定时推送与告警，仅出站、不支持群内指令交互。
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* 凭据填写与回调区域 */}
                    <div style={{ background: 'var(--surface)', padding: '16px 18px', borderRadius: 12, border: '1px solid var(--border)' }}>
                      <div className="row-between" style={{ alignItems: 'center', marginBottom: 12 }}>
                        <div style={{ fontSize: 13, fontWeight: 700 }}>
                          3. {botMode === 'app' ? '应用凭据与回调配置' : 'Webhook 配置'}
                        </div>
                        {provider === 'feishu' && botMode === 'app' && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            style={{ background: 'var(--accent-soft)', color: 'var(--accent)', border: '1px solid rgba(37,99,235,0.2)', fontSize: 12 }}
                            onClick={() => {
                              const json = JSON.stringify({
                                manifest_version: "1.0.0",
                                app_config: {
                                  scopes: [
                                    "im:message",
                                    "im:message.group_at_msg:readonly",
                                    "im:message.p2p_msg:readonly",
                                    "im:message:send_as_bot",
                                    "im:chat:readonly"
                                  ],
                                  events: ["im.message.receive_v1"]
                                }
                              }, null, 2);
                              navigator.clipboard.writeText(json);
                              flash('✨ 已复制 Manifest JSON！飞书创建应用时一键导入即可');
                            }}
                          >
                            ⚡ 复制 Manifest JSON (一键导入)
                          </button>
                        )}
                      </div>

                      {/* ── 飞书自建应用 ── */}
                      {provider === 'feishu' && botMode === 'app' && (
                        <div className="stack" style={{ gap: 12 }}>
                          <div className="grid grid-2" style={{ gap: 10 }}>
                            <label className="stack" style={{ gap: 4 }}>
                              <span className="small muted">App ID (cli_xxx)</span>
                              <input className="input mono" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="cli_xxxxxxxxxxxx" />
                            </label>
                            <label className="stack" style={{ gap: 4 }}>
                              <span className="small muted">App Secret</span>
                              <input className="input mono" type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder={secretHint(editing?.hasAppSecret, 'App Secret', '在飞书后台「凭证与基础信息」获取')} />
                            </label>
                          </div>

                          {/* 回调地址 */}
                          <div style={{ background: 'var(--surface-2)', padding: '12px 14px', borderRadius: 8, border: '1px solid var(--border)' }}>
                            <div className="row-between" style={{ alignItems: 'center', marginBottom: 6 }}>
                              <span className="small" style={{ fontWeight: 600 }}>📡 事件订阅请求地址 (模式 A · HTTP 回调)</span>
                              <a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer" className="small" style={{ color: 'var(--accent)' }}>
                                ↗ 飞书开放平台
                              </a>
                            </div>
                            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                              <input className="input mono small" readOnly value={callbackUrl} style={{ background: 'var(--surface)', flex: 1 }} />
                              <button type="button" className="btn btn-sm btn-primary" onClick={copyCallback} disabled={!appId.trim()} title={appId.trim() ? '' : '请先填写 App ID'}>
                                {copied ? '✓ 已复制' : '复制地址'}
                              </button>
                            </div>
                            <div className="small muted" style={{ marginTop: 6, fontSize: 11.5 }}>
                              飞书后台路径：<b>「开发配置」➔「事件订阅」➔「回调配置」</b>，粘贴此地址并保存。
                            </div>
                          </div>

                          <div className="grid grid-2" style={{ gap: 10 }}>
                            <label className="stack" style={{ gap: 4 }}>
                              <span className="small muted">Verification Token</span>
                              <input className="input mono" value={verificationToken} onChange={(e) => setVerificationToken(e.target.value)} placeholder={secretHint(editing?.hasVerificationToken, 'Verification Token', '飞书后台事件订阅页提供')} />
                            </label>
                            <label className="stack" style={{ gap: 4 }}>
                              <span className="small muted">Encrypt Key（可选）</span>
                              <input className="input mono" value={encryptKey} onChange={(e) => setEncryptKey(e.target.value)} placeholder={secretHint(editing?.hasEncryptKey, 'Encrypt Key', '开启「消息加密」才需填写')} />
                            </label>
                          </div>
                        </div>
                      )}

                      {/* ── 飞书 Webhook ── */}
                      {provider === 'feishu' && botMode === 'webhook' && (
                        <div className="stack" style={{ gap: 10 }}>
                          <label className="stack" style={{ gap: 4 }}>
                            <span className="small muted">群自定义机器人 Webhook URL</span>
                            <input className="input mono" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxxx" />
                          </label>
                          <label className="stack" style={{ gap: 4 }}>
                            <span className="small muted">签名密钥（可选）</span>
                            <input className="input mono" value={signSecret} onChange={(e) => setSignSecret(e.target.value)} placeholder={editing?.hasSignSecret ? '签名密钥（留空=不改）' : '群机器人安全设置若勾选了「签名校验」请填写'} />
                          </label>
                        </div>
                      )}

                      {/* ── 钉钉自建应用 ── */}
                      {provider === 'dingtalk' && botMode === 'app' && (
                        <div className="stack" style={{ gap: 12 }}>
                          <div className="grid grid-3" style={{ gap: 10 }}>
                            <label className="stack" style={{ gap: 4 }}>
                              <span className="small muted">AppKey</span>
                              <input className="input mono" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="AppKey" />
                            </label>
                            <label className="stack" style={{ gap: 4 }}>
                              <span className="small muted">AppSecret</span>
                              <input className="input mono" type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder={secretHint(editing?.hasAppSecret, 'AppSecret', 'AppSecret')} />
                            </label>
                            <label className="stack" style={{ gap: 4 }}>
                              <span className="small muted">AgentId</span>
                              <input className="input mono" value={agentId} onChange={(e) => setAgentId(e.target.value)} placeholder="工作通知用 AgentId" />
                            </label>
                          </div>
                          <div style={{ background: 'var(--surface-2)', padding: '12px 14px', borderRadius: 8, border: '1px solid var(--border)' }}>
                            <div className="row-between" style={{ alignItems: 'center', marginBottom: 6 }}>
                              <span className="small" style={{ fontWeight: 600 }}>📡 机器人消息接收地址 (HTTP)</span>
                              <a href="https://open-dev.dingtalk.com/fe/app" target="_blank" rel="noreferrer" className="small" style={{ color: 'var(--accent)' }}>
                                ↗ 钉钉开放平台
                              </a>
                            </div>
                            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                              <input className="input mono small" readOnly value={callbackUrl} style={{ background: 'var(--surface)', flex: 1 }} />
                              <button type="button" className="btn btn-sm btn-primary" onClick={copyCallback} disabled={!appId.trim()}>
                                {copied ? '✓ 已复制' : '复制地址'}
                              </button>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* ── 钉钉 Webhook ── */}
                      {provider === 'dingtalk' && botMode === 'webhook' && (
                        <div className="stack" style={{ gap: 10 }}>
                          <label className="stack" style={{ gap: 4 }}>
                            <span className="small muted">Webhook URL</span>
                            <input className="input mono" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://oapi.dingtalk.com/robot/send?access_token=xxxx" />
                          </label>
                          <label className="stack" style={{ gap: 4 }}>
                            <span className="small muted">加签密钥 SEC...（可选）</span>
                            <input className="input mono" value={signSecret} onChange={(e) => setSignSecret(e.target.value)} placeholder={editing?.hasSignSecret ? '加签密钥（留空=不改）' : '安全设置勾选「加签」时填写'} />
                          </label>
                        </div>
                      )}

                      {/* ── 企业微信自建应用 ── */}
                      {provider === 'wecom' && botMode === 'app' && (
                        <div className="stack" style={{ gap: 12 }}>
                          <div className="grid grid-3" style={{ gap: 10 }}>
                            <label className="stack" style={{ gap: 4 }}>
                              <span className="small muted">CorpID (企业 ID)</span>
                              <input className="input mono" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="wwXXXXXXXXXX" />
                            </label>
                            <label className="stack" style={{ gap: 4 }}>
                              <span className="small muted">AgentID</span>
                              <input className="input mono" value={agentId} onChange={(e) => setAgentId(e.target.value)} placeholder="如 1000002" />
                            </label>
                            <label className="stack" style={{ gap: 4 }}>
                              <span className="small muted">Secret</span>
                              <input className="input mono" type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder={secretHint(editing?.hasAppSecret, 'Secret', '应用 Secret')} />
                            </label>
                          </div>
                          <div style={{ background: 'var(--surface-2)', padding: '12px 14px', borderRadius: 8, border: '1px solid var(--border)' }}>
                            <div className="row-between" style={{ alignItems: 'center', marginBottom: 6 }}>
                              <span className="small" style={{ fontWeight: 600 }}>📡 接收消息服务器 URL</span>
                              <a href="https://work.weixin.qq.com/wework_admin/frame#apps/createApiApp" target="_blank" rel="noreferrer" className="small" style={{ color: 'var(--accent)' }}>
                                ↗ 企微管理后台
                              </a>
                            </div>
                            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                              <input className="input mono small" readOnly value={callbackUrl} style={{ background: 'var(--surface)', flex: 1 }} />
                              <button type="button" className="btn btn-sm btn-primary" onClick={copyCallback} disabled={!appId.trim() || !agentId.trim()}>
                                {copied ? '✓ 已复制' : '复制地址'}
                              </button>
                            </div>
                          </div>
                          <div className="grid grid-2" style={{ gap: 10 }}>
                            <label className="stack" style={{ gap: 4 }}>
                              <span className="small muted">Token (企微后台随机生成)</span>
                              <input className="input mono" value={verificationToken} onChange={(e) => setVerificationToken(e.target.value)} placeholder={secretHint(editing?.hasVerificationToken, 'Token', 'Token')} />
                            </label>
                            <label className="stack" style={{ gap: 4 }}>
                              <span className="small muted">EncodingAESKey (企微后台随机生成)</span>
                              <input className="input mono" value={encryptKey} onChange={(e) => setEncryptKey(e.target.value)} placeholder={secretHint(editing?.hasEncryptKey, 'EncodingAESKey', 'EncodingAESKey (43位)')} />
                            </label>
                          </div>
                        </div>
                      )}

                      {/* ── 企业微信 Webhook ── */}
                      {provider === 'wecom' && botMode === 'webhook' && (
                        <div className="stack" style={{ gap: 10 }}>
                          <label className="stack" style={{ gap: 4 }}>
                            <span className="small muted">Webhook URL</span>
                            <input className="input mono" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx" />
                          </label>
                        </div>
                      )}

                      {/* ── 微信客服 ── */}
                      {provider === 'wechat_kf' && (
                        <div className="stack" style={{ gap: 12 }}>
                          <div className="grid grid-2" style={{ gap: 10 }}>
                            <label className="stack" style={{ gap: 4 }}>
                              <span className="small muted">企业 CorpID</span>
                              <input className="input mono" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="wwXXXXXXXXXX" />
                            </label>
                            <label className="stack" style={{ gap: 4 }}>
                              <span className="small muted">微信客服 Secret</span>
                              <input className="input mono" type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder={secretHint(editing?.hasAppSecret, 'Secret', '客服 Secret')} />
                            </label>
                          </div>
                          <div style={{ background: 'var(--surface-2)', padding: '12px 14px', borderRadius: 8, border: '1px solid var(--border)' }}>
                            <div className="row-between" style={{ alignItems: 'center', marginBottom: 6 }}>
                              <span className="small" style={{ fontWeight: 600 }}>📡 微信客服回调 URL</span>
                            </div>
                            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                              <input className="input mono small" readOnly value={callbackUrl} style={{ background: 'var(--surface)', flex: 1 }} />
                              <button type="button" className="btn btn-sm btn-primary" onClick={copyCallback} disabled={!appId.trim()}>
                                {copied ? '✓ 已复制' : '复制地址'}
                              </button>
                            </div>
                          </div>
                          <div className="grid grid-2" style={{ gap: 10 }}>
                            <label className="stack" style={{ gap: 4 }}>
                              <span className="small muted">Token</span>
                              <input className="input mono" value={verificationToken} onChange={(e) => setVerificationToken(e.target.value)} placeholder={secretHint(editing?.hasVerificationToken, 'Token', 'Token')} />
                            </label>
                            <label className="stack" style={{ gap: 4 }}>
                              <span className="small muted">EncodingAESKey</span>
                              <input className="input mono" value={encryptKey} onChange={(e) => setEncryptKey(e.target.value)} placeholder={secretHint(editing?.hasEncryptKey, 'EncodingAESKey', 'EncodingAESKey')} />
                            </label>
                          </div>
                        </div>
                      )}

                      {/* ── Telegram / Slack ── */}
                      {(provider === 'telegram' || provider === 'slack') && (
                        <div className="stack" style={{ gap: 10 }}>
                          <label className="stack" style={{ gap: 4 }}>
                            <span className="small muted">{provider === 'telegram' ? 'Telegram Bot API URL' : 'Slack Webhook URL'}</span>
                            <input
                              className="input mono"
                              value={webhookUrl}
                              onChange={(e) => setWebhookUrl(e.target.value)}
                              placeholder={provider === 'telegram' ? 'https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>' : 'https://hooks.slack.com/services/T.../B...'}
                            />
                          </label>
                        </div>
                      )}

                      {/* 微信 iLink 编辑态 */}
                      {provider === 'wechat' && editing && (
                        <WechatIlinkConnect
                          existing={{ id: editing.id, ilinkUserId: editing.ilinkUserId, ilinkExpired: editing.ilinkExpired }}
                          onDone={() => { flash('已重新绑定'); router.refresh(); }}
                        />
                      )}
                    </div>
                  </div>
                )}

                {/* ═══════════════ TAB 2: 指令权限 (ChatOps) ═══════════════ */}
                {modalTab === 'commands' && (
                  <div className="stack" style={{ gap: 16 }}>
                    {/* 快捷控制栏 */}
                    <div className="row-between wrap" style={{ gap: 10, alignItems: 'center', background: 'var(--surface)', padding: '12px 16px', borderRadius: 12, border: '1px solid var(--border)' }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 700 }}>
                          群内指令准入策略
                        </div>
                        <div className="small muted" style={{ marginTop: 2 }}>
                          已开启 <b style={{ color: 'var(--brand)' }}>{commands.length}</b> / {TOGGLEABLE_COMMANDS.length} 项指令
                          {isExternalProvider(provider) && <span style={{ color: 'var(--amber)', marginLeft: 6 }}>（对外渠道建议仅开启低风险操作）</span>}
                        </div>
                      </div>
                      <div className="row" style={{ gap: 6 }}>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => setCommands(ALL_COMMANDS)}
                          style={{ fontSize: 12 }}
                        >
                          全部开启
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => setCommands([...EXTERNAL_DEFAULT_COMMANDS])}
                          style={{ fontSize: 12 }}
                        >
                          推荐安全集
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => setCommands(['chat'])}
                          style={{ fontSize: 12 }}
                        >
                          仅对话
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => setCommands([])}
                          style={{ fontSize: 12, color: 'var(--muted)' }}
                        >
                          全关
                        </button>
                      </div>
                    </div>

                    {/* 指令分组卡片网格 */}
                    <div className="stack" style={{ gap: 12 }}>
                      {[
                        {
                          groupTitle: '💬 基础对话与问答',
                          keys: ['chat'],
                        },
                        {
                          groupTitle: '📑 内容知识沉淀与剪藏',
                          keys: ['clip', 'topic', 'hot'],
                        },
                        {
                          groupTitle: '🔍 跨平台竞对作战与任务',
                          keys: ['crawl', 'dispatch'],
                        },
                        {
                          groupTitle: '⚙️ 账号诊断与系统管理',
                          keys: ['analyze', 'account', 'optimize'],
                        },
                      ].map((grp) => {
                        const items = TOGGLEABLE_COMMANDS.filter((c) => grp.keys.includes(c.key));
                        if (items.length === 0) return null;
                        return (
                          <div key={grp.groupTitle} style={{ background: 'var(--surface)', padding: '14px 16px', borderRadius: 12, border: '1px solid var(--border)' }}>
                            <div className="small muted" style={{ fontWeight: 700, marginBottom: 10, letterSpacing: 0.2 }}>
                              {grp.groupTitle}
                            </div>
                            <div className="grid grid-2" style={{ gap: 10 }}>
                              {items.map((c) => {
                                const checked = commands.includes(c.key);
                                return (
                                  <div
                                    key={c.key}
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => toggleCommand(c.key)}
                                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleCommand(c.key); }}
                                    style={{
                                      padding: '10px 12px',
                                      borderRadius: 8,
                                      cursor: 'pointer',
                                      border: checked ? '1px solid rgba(232, 85, 45, 0.35)' : '1px solid var(--border)',
                                      background: checked ? 'var(--surface-2)' : 'var(--surface)',
                                      display: 'flex',
                                      alignItems: 'flex-start',
                                      gap: 10,
                                      transition: 'all 0.15s ease',
                                    }}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() => {}}
                                      style={{ marginTop: 2, accentColor: 'var(--brand)', flexShrink: 0 }}
                                    />
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                      <div className="row wrap" style={{ gap: 6, alignItems: 'center' }}>
                                        <b style={{ fontSize: 13, color: checked ? 'var(--text)' : 'var(--text-3)' }}>{c.name}</b>
                                        <code className="mono small" style={{ background: 'var(--surface)', padding: '1px 5px', borderRadius: 4, border: '1px solid var(--border)', fontSize: 11 }}>
                                          {c.trigger}
                                        </code>
                                      </div>
                                      <div className="small muted" style={{ fontSize: 11.5, marginTop: 3, lineHeight: 1.4 }}>
                                        {c.desc}
                                      </div>
                                      {c.warn && (
                                        <div style={{ fontSize: 11, color: 'var(--amber)', marginTop: 4, fontWeight: 500 }}>
                                          ⚠ {c.warn}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* ═══════════════ TAB 3: 定时推送 ═══════════════ */}
                {modalTab === 'push' && !isReplyOnlyProvider(provider) && (<>
                  <div className="stack" style={{ gap: 16 }}>
                    {/* 每日定时推送时间 */}
                    <div style={{ background: 'var(--surface)', padding: '16px 18px', borderRadius: 12, border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>每日定时推送节点</div>
                      <div className="small muted" style={{ marginBottom: 12 }}>
                        到达设定时间自动向该机器人推送今日精选热点与选题建议（北京时间 UTC+8）
                      </div>
                      <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
                        {['08:30', '09:00', '12:00', '18:00', '21:00'].map((t) => (
                          <button
                            key={t}
                            type="button"
                            className={`btn btn-sm ${pushSchedule === t ? 'btn-primary' : 'btn-ghost'}`}
                            onClick={() => setPushSchedule(t)}
                            style={{ minWidth: 64 }}
                          >
                            {t}
                          </button>
                        ))}
                        <input
                          className="input mono"
                          style={{ width: 100, padding: '6px 10px', fontSize: 13 }}
                          value={pushSchedule}
                          onChange={(e) => setPushSchedule(e.target.value)}
                          placeholder="如 09:00"
                        />
                        <span className="small muted">支持多个时段，用逗号隔开</span>
                      </div>
                    </div>

                    {/* 订阅推送事件网格 */}
                    <div style={{ background: 'var(--surface)', padding: '16px 18px', borderRadius: 12, border: '1px solid var(--border)' }}>
                      <div className="row-between" style={{ alignItems: 'center', marginBottom: 12 }}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 700 }}>订阅推送事件类型</div>
                          <div className="small muted" style={{ marginTop: 2 }}>已选 {events.length} 项事件</div>
                        </div>
                        <div className="row" style={{ gap: 6 }}>
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => setEvents(PUSH_EVENTS.map((e) => e.key))}
                            style={{ fontSize: 12 }}
                          >
                            全选
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => setEvents([...DEFAULT_EVENTS])}
                            style={{ fontSize: 12 }}
                          >
                            默认推荐
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => setEvents([])}
                            style={{ fontSize: 12, color: 'var(--muted)' }}
                          >
                            清空
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-2" style={{ gap: 10 }}>
                        {PUSH_EVENTS.map((ev) => {
                          const checked = events.includes(ev.key);
                          return (
                            <div
                              key={ev.key}
                              role="button"
                              tabIndex={0}
                              onClick={() => toggleEvent(ev.key)}
                              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleEvent(ev.key); }}
                              style={{
                                padding: '10px 12px',
                                borderRadius: 8,
                                cursor: 'pointer',
                                border: checked ? '1px solid rgba(232, 85, 45, 0.35)' : '1px solid var(--border)',
                                background: checked ? 'var(--surface-2)' : 'var(--surface)',
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: 10,
                                transition: 'all 0.15s ease',
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => {}}
                                style={{ marginTop: 2, accentColor: 'var(--brand)', flexShrink: 0 }}
                              />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <b style={{ fontSize: 13, color: checked ? 'var(--text)' : 'var(--text-3)' }}>{ev.name}</b>
                                <div className="small muted" style={{ fontSize: 11.5, marginTop: 2, lineHeight: 1.4 }}>
                                  {ev.desc}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </>)}

                {/* ═══════════════ TAB 4: 接入指引 & Manifest ═══════════════ */}
                {modalTab === 'guide' && (
                  <div className="stack" style={{ gap: 16 }}>
                    {/* 飞书专属 Manifest 极速导入卡片 */}
                    {provider === 'feishu' && (
                      <div style={{ background: 'linear-gradient(135deg, rgba(37, 99, 235, 0.08) 0%, rgba(232, 85, 45, 0.08) 100%)', padding: '16px 18px', borderRadius: 12, border: '1px solid rgba(37, 99, 235, 0.2)' }}>
                        <div className="row-between wrap" style={{ gap: 10, alignItems: 'center', marginBottom: 10 }}>
                          <div>
                            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--accent)' }}>
                              ⚡ 飞书应用 Manifest JSON 一键导入 (推荐)
                            </div>
                            <div className="small muted" style={{ marginTop: 2 }}>
                              无需逐项开通权限与订阅事件，粘贴配置文件 1 秒全自动配置完毕
                            </div>
                          </div>
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            onClick={() => {
                              const json = JSON.stringify({
                                manifest_version: "1.0.0",
                                app_config: {
                                  scopes: [
                                    "im:message",
                                    "im:message.group_at_msg:readonly",
                                    "im:message.p2p_msg:readonly",
                                    "im:message:send_as_bot",
                                    "im:chat:readonly"
                                  ],
                                  events: ["im.message.receive_v1"]
                                }
                              }, null, 2);
                              navigator.clipboard.writeText(json);
                              flash('✨ 已复制 Manifest JSON！');
                            }}
                          >
                            复制 Manifest JSON
                          </button>
                        </div>
                        <div className="grid grid-2" style={{ gap: 10, fontSize: 12, marginTop: 10 }}>
                          <div style={{ background: 'var(--surface)', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)' }}>
                            <b style={{ color: 'var(--accent)' }}>✦ 场景 A：新建应用（最省心）</b>
                            <div className="muted" style={{ marginTop: 4, lineHeight: 1.6 }}>
                              进入飞书开放平台 ➔ 点击右上角 <b>「创建应用」➔「通过 App Manifest 创建」</b> ➔ 粘贴此 JSON，自动建好并挂载所有权限。
                            </div>
                          </div>
                          <div style={{ background: 'var(--surface)', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)' }}>
                            <b style={{ color: 'var(--accent)' }}>✦ 场景 B：已有应用补充配置</b>
                            <div className="muted" style={{ marginTop: 4, lineHeight: 1.6 }}>
                              进入应用详情 ➔ 左侧 <b>「开发配置」➔「应用配置」/「App Manifest」</b> ➔ 粘贴 JSON 保存，即可补全消息与事件权限。
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* 分步指引卡 */}
                    <div style={{ background: 'var(--surface)', padding: '16px 18px', borderRadius: 12, border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>分步操作指南</div>
                      <div className="stack" style={{ gap: 12, fontSize: 12.5, lineHeight: 1.7 }}>
                        {provider === 'feishu' && (
                          <>
                            <div className="row" style={{ gap: 10 }}>
                              <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--brand-soft)', color: 'var(--brand)', fontWeight: 700, display: 'grid', placeItems: 'center', fontSize: 11, flexShrink: 0 }}>1</span>
                              <div>
                                <b>创建自建应用并获取凭证：</b><br />
                                <span className="muted">在飞书开放平台创建企业自建应用，在「凭证与基础信息」中复制 App ID 与 App Secret 填入「基础与连接」页。</span>
                              </div>
                            </div>
                            <div className="row" style={{ gap: 10 }}>
                              <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--brand-soft)', color: 'var(--brand)', fontWeight: 700, display: 'grid', placeItems: 'center', fontSize: 11, flexShrink: 0 }}>2</span>
                              <div>
                                <b>配置事件订阅 (HTTP 回调)：</b><br />
                                <span className="muted">在「开发配置」➔「事件订阅」中选择 HTTP 回调模式，将「基础与连接」生成的 URL 粘贴至请求地址，通过连通性校验。</span>
                              </div>
                            </div>
                            <div className="row" style={{ gap: 10 }}>
                              <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--brand-soft)', color: 'var(--brand)', fontWeight: 700, display: 'grid', placeItems: 'center', fontSize: 11, flexShrink: 0 }}>3</span>
                              <div>
                                <b>添加事件与发布机器人：</b><br />
                                <span className="muted">在「事件配置」添加 <code className="mono">im.message.receive_v1</code>，并在「应用功能」启用机器人、发布新版本后拉入飞书群即可。</span>
                              </div>
                            </div>
                          </>
                        )}

                        {provider === 'dingtalk' && (
                          <>
                            <div className="row" style={{ gap: 10 }}>
                              <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--brand-soft)', color: 'var(--brand)', fontWeight: 700, display: 'grid', placeItems: 'center', fontSize: 11, flexShrink: 0 }}>1</span>
                              <div>
                                <b>创建钉钉企业内部应用：</b><br />
                                <span className="muted">在钉钉开放平台创建内部应用，获取 AppKey、AppSecret 与应用详情里的 AgentId。</span>
                              </div>
                            </div>
                            <div className="row" style={{ gap: 10 }}>
                              <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--brand-soft)', color: 'var(--brand)', fontWeight: 700, display: 'grid', placeItems: 'center', fontSize: 11, flexShrink: 0 }}>2</span>
                              <div>
                                <b>启用机器人能力并设置回调：</b><br />
                                <span className="muted">在应用功能 ➔ 机器人中启用机器人，并在「消息接收地址」粘贴本系统生成的 HTTP 回调地址。</span>
                              </div>
                            </div>
                          </>
                        )}

                        {provider === 'wecom' && (
                          <>
                            <div className="row" style={{ gap: 10 }}>
                              <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--brand-soft)', color: 'var(--brand)', fontWeight: 700, display: 'grid', placeItems: 'center', fontSize: 11, flexShrink: 0 }}>1</span>
                              <div>
                                <b>创建企微自建应用：</b><br />
                                <span className="muted">在企业微信管理后台「应用管理」创建自建应用，获取 CorpID、AgentID 与 Secret。</span>
                              </div>
                            </div>
                            <div className="row" style={{ gap: 10 }}>
                              <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--brand-soft)', color: 'var(--brand)', fontWeight: 700, display: 'grid', placeItems: 'center', fontSize: 11, flexShrink: 0 }}>2</span>
                              <div>
                                <b>设置接收消息服务器：</b><br />
                                <span className="muted">在「开发者接口 ➔ 接收消息」粘贴回调 URL，并随机生成 Token 与 EncodingAESKey 同步填回本页面。</span>
                              </div>
                            </div>
                          </>
                        )}

                        {provider === 'wechat_kf' && (
                          <>
                            <div className="row" style={{ gap: 10 }}>
                              <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--brand-soft)', color: 'var(--brand)', fontWeight: 700, display: 'grid', placeItems: 'center', fontSize: 11, flexShrink: 0 }}>1</span>
                              <div>
                                <b>开通微信客服并新建客服账号：</b><br />
                                <span className="muted">在企微后台「应用管理 ➔ 微信客服」创建客服账号，并在「API」中创建 Secret。</span>
                              </div>
                            </div>
                            <div className="row" style={{ gap: 10 }}>
                              <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--brand-soft)', color: 'var(--brand)', fontWeight: 700, display: 'grid', placeItems: 'center', fontSize: 11, flexShrink: 0 }}>2</span>
                              <div>
                                <b>配置回调并将客服码发给用户：</b><br />
                                <span className="muted">配置回调 URL、Token 与 EncodingAESKey，保存后将客服二维码发给微信用户，即可实现官方一对一客服对话。</span>
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    </div>

                    {/* 群内玩法速查 */}
                    <div style={{ background: 'var(--surface)', padding: '14px 16px', borderRadius: 12, border: '1px solid var(--border)', fontSize: 12 }}>
                      <b style={{ color: 'var(--text)' }}>💡 群内指令与玩法速查</b>
                      <div className="muted" style={{ marginTop: 6, lineHeight: 1.8 }}>
                        • <b>自然对话：</b>直接 @机器人 发送问题，支持多轮上下文理解。<br />
                        • <b>链接剪藏：</b>向群内直接发送文章链接，自动抓取正文、生成摘要与对本账号的价值分析。<br />
                        • <b>快捷指令：</b>
                        <code className="mono" style={{ margin: '0 4px' }}>/热点</code>（查热榜）
                        <code className="mono" style={{ margin: '0 4px' }}>/选题 [关键词]</code>（收录候选）
                        <code className="mono" style={{ margin: '0 4px' }}>/分析 [账号]</code>（账号体检）
                        <code className="mono" style={{ margin: '0 4px' }}>/拆解 [链接]</code>（爆款分析）
                        <code className="mono" style={{ margin: '0 4px' }}>/帮助</code>（查看说明）
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* 弹窗底部固定操作栏 */}
          <div style={{ padding: '14px 24px', borderTop: '1px solid var(--border)', background: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div className="small" style={{ color: failed ? 'var(--red)' : 'var(--green)', fontWeight: 500 }}>
              {msg || (editing?.lastInboundAt ? `✓ 机器人连接正常 (最近交互 ${fmtDateTime(editing.lastInboundAt)})` : '')}
            </div>
            <div className="row" style={{ gap: 10, alignItems: 'center' }}>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => { setShowForm(false); resetForm(); }}
                disabled={pending}
                style={{ padding: '8px 18px' }}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={save}
                disabled={pending}
                style={{ padding: '8px 24px', fontWeight: 600, boxShadow: '0 2px 8px rgba(232, 85, 45, 0.25)' }}
              >
                {pending ? '保存中…' : '保存配置'}
              </button>
            </div>
          </div>
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
