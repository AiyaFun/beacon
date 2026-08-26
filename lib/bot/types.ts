// 机器人集成——共享类型与 provider 注册表（需求③④）。
// feishu 先落地；其它 provider 标 supported:false，加 adapter 时打开即可，UI/数据层不用改。

export type BotProvider = 'feishu' | 'dingtalk' | 'wecom' | 'telegram' | 'slack';

export const BOT_PROVIDERS: { key: BotProvider; name: string; supported: boolean; hint: string }[] = [
  { key: 'feishu', name: '飞书 / Lark', supported: true, hint: '自建应用（双向全能） / 群 Webhook（仅出站）' },
  { key: 'dingtalk', name: '钉钉', supported: true, hint: '群自定义机器人 Webhook（支持 HMAC 加签）' },
  { key: 'wecom', name: '企业微信', supported: true, hint: '群自定义机器人 Webhook（支持图文/Markdown）' },
  // Telegram/Slack 目前只有出站推送，没有入站事件路由（app/api/bot/ 下只有飞书/钉钉/企微三条）——
  // 标成「仅出站」而不是笼统的 supported，免得用户以为能在群里对话。
  { key: 'telegram', name: 'Telegram', supported: true, hint: 'Bot API 推送（仅出站，暂不支持群内对话）' },
  { key: 'slack', name: 'Slack', supported: true, hint: 'Incoming Webhooks（仅出站，暂不支持群内对话）' },
];

export function botProviderName(key: string): string {
  return BOT_PROVIDERS.find((p) => p.key === key)?.name ?? key;
}

// 加密存储的密钥集合（明文不落库，整体 encryptKey 成 secretsEnc）。
export type BotSecrets = {
  signSecret?: string; // 出站 webhook 签名密钥（飞书群机器人「签名校验」）
  appSecret?: string; // 入站自建应用 App Secret / 钉钉 AppSecret / 企微 Secret
  verificationToken?: string; // 入站事件订阅 Verification Token（飞书/企微）
  encryptKey?: string; // 入站事件订阅 Encrypt Key（飞书/企微 EncodingAESKey）
  corpId?: string; // 企微 Corp ID
  agentId?: string; // 钉钉 AgentId（工作通知用）/ 企微 AgentID
};

// ── 入站命令白名单（BotIntegration.allowCommands，管理员在设置页勾选）──
//
// 为什么要有它：机器人装在群里，群里可能有实习生、外包、客户。`/分析` 会把粉丝数、播放量、
// 环比涨跌直接摊在群消息里；`/问` 会烧租户的 AI 配额。这些该由管理员决定放不放开，
// 而不是「装了机器人 = 群里所有人自动拥有」。权限与密钥同级（byok.manage，仅 owner/admin）。

export type BotCommandKey = 'chat' | 'analyze' | 'clip' | 'topic' | 'crawl' | 'hot' | 'optimize' | 'account' | 'help';

export const BOT_COMMANDS: {
  key: BotCommandKey;
  name: string;
  trigger: string;
  desc: string;
  /** 需要管理员知情的副作用（会外泄什么 / 会花什么）。有值时设置页高亮显示。 */
  warn?: string;
}[] = [
  { key: 'chat', name: '群内对话', trigger: '@机器人 / /问', desc: '带账号人设与真实数据回答提问，多轮上下文', warn: '会消耗 AI 额度' },
  { key: 'analyze', name: '账号体检', trigger: '/分析', desc: '把账号近 30 天数据与诊断反馈发到群里', warn: '会把粉丝数、播放量发到群里' },
  { key: 'clip', name: '文章剪藏', trigger: '发链接/正文 / /存', desc: '抓取文章正文存档，出摘要、要点与「对本账号的用处」', warn: '会由服务器访问该链接并存下正文' },
  { key: 'topic', name: '收录选题', trigger: '直接发短文本 / /选题', desc: '把消息收录成选题候选（只进候选池，不发布）' },
  { key: 'crawl', name: '竞对监控', trigger: '发主页链接 / /采集', desc: '把竞对主页加入监控并试采一次' },
  { key: 'hot', name: '查热榜', trigger: '/热点', desc: '返回当前热榜 Top8' },
  { key: 'optimize', name: '记忆优化', trigger: '/优化', desc: '触发一次记忆学习优化并回小结' },
  { key: 'account', name: '切换账号', trigger: '/账号', desc: '查看/切换本群对应的创作者账号', warn: '会列出工作区里的账号名' },
  // help 不出现在勾选项里：全关时机器人至少还能自报家门，否则它就是个不响的黑箱
];

/** 可勾选的命令（help 恒开，不给开关）。 */
export const TOGGLEABLE_COMMANDS = BOT_COMMANDS.filter((c) => c.key !== 'help');

const COMMAND_KEYS = new Set<string>([...BOT_COMMANDS.map((c) => c.key), 'help']);

/**
 * 这条命令在这个机器人上开着吗。
 *
 * ⚠️ **空数组 = 从未配置 = 默认全开**，不是「全关」。线上老数据的 allowCommands 全是 `"[]"`，
 * 把空当成全关会让所有已装机器人在一次发版后集体哑掉，而且没有任何报错。
 * 管理员保存时前端会**永远至少写入 `help`**（见 actSaveBot），所以「配过」的记录必然非空，
 * 全部取消勾选存下来的是 `["help"]` —— 与「没配过」区分得开。
 */
export function isCommandAllowed(cmd: BotCommandKey, allow: string[] | null | undefined): boolean {
  if (cmd === 'help') return true;
  if (!allow || allow.length === 0) return true;
  return allow.includes(cmd);
}

export function sanitizeAllowCommands(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const picked = input.map(String).filter((k) => COMMAND_KEYS.has(k));
  return [...new Set(picked)];
}

// ── 出站推送事件 ──
export type PushEventType =
  | 'hot_ready'
  | 'daily_recommend'
  | 'refresh_reminder'
  | 'compliance_alert'
  | 'learning_summary'
  | 'performance_alert'
  | 'review_ready'
  | 'plan_expiry'
  | 'agent_done';

export const PUSH_EVENTS: { key: PushEventType; name: string; desc: string }[] = [
  { key: 'daily_recommend', name: '每日选题推荐', desc: '每天推荐生成后，把今日 Top 选题推到群' },
  { key: 'hot_ready', name: '热点刷新', desc: '热榜聚类完成后推送新上榜的高相关热点' },
  { key: 'refresh_reminder', name: '竞对待刷新提醒', desc: '每天提醒有多少竞对档案待刷新' },
  { key: 'compliance_alert', name: '合规拦截告警', desc: '内容被合规红线拦截时即时告警' },
  { key: 'learning_summary', name: '学习小结', desc: '记忆优化后推送「本轮系统学到了什么」' },
  { key: 'performance_alert', name: '爆款/异常预警', desc: '发布后数据增速显著高于或低于你的基线时提醒' },
  { key: 'review_ready', name: 'AI 复盘就绪', desc: '单篇复盘或周度复盘生成后推送要点' },
  // 计费类提醒**默认订阅也该保留**：手动续费模式下，漏看到期 = 第二天自动化任务全停。
  { key: 'plan_expiry', name: '到期与续费提醒', desc: '套餐/试用到期前 7、3、1 天与到期当天各提醒一次' },
  // 定时智能体是**用户不在场时**跑的：不推的话他第二天得自己想起来去翻运行中心，
  // 那这个功能的价值就少了一半（「早上打开手机就看到稿子备好了」才是它的样子）
  { key: 'agent_done', name: '定时智能体跑完', desc: '定时计划跑完后把结果推到群（失败与自动停用也推）' },
];

// ── 推送消息（provider 无关，adapter 各自渲染成平台格式）──
export type PushMessage =
  | { kind: 'text'; text: string }
  | { kind: 'card'; title: string; lines: string[]; link?: { text: string; url: string } };

// ── 归一化入站消息（各 provider adapter 把原始 payload 转成这个）──
export type InboundMessage = {
  provider: BotProvider;
  workspaceId: string;
  senderId?: string; // provider 内的发送者 id（用于回执/审计）
  text: string; // 纯文本消息体（已去 @机器人 等噪声）
  messageId?: string; // 去重用
  raw?: unknown;
};

export type SendResult = { ok: boolean; error?: string };
