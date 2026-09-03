import { prisma } from '../db';
import { HOT_SOURCES } from '../constants';
import { parseJson } from '../json';
import { BOT_COMMANDS, TOGGLEABLE_COMMANDS, isCommandAllowed, isExternalProvider, type BotCommandKey } from './types';
import { beaconUrl } from './index';
import { ingestTopic, ingestCompetitor, extractUrl } from './ingest';
import { classifyIntent, matchAgentSwitch, type Intent } from './intent';
import {
  loadConversation, appendTurns, bindConversationAccount, bindConversationAgent, resetConversation, touchConversation,
  type ChatKey, type ConversationState,
} from './conversation';
import { buildDailyBrief } from '../topic/brief';
import { briefTopicsFor } from '../topic/brief-topics';
import { resolveAccount, listActiveAccounts, accountLine } from './accounts';
import { botChat } from './chat';
import { analyzeAccount } from './analyze';
import { fmtDate } from '../format';
import { bindOaByCode, issueOaLoginTicket, type OaProvider } from '@/lib/auth/oa';
import { siteUrl } from '@/lib/site-url';

// 入站命令路由（需求④）：把一条群消息 → 内容引擎的一次操作，返回给用户的回执文本。
// 红线：所有操作只「收录/查询/采集/分析/派任务」，**不触发任何发布**；生成走既有管线时仍全程过合规。
// 派任务（/派 /执行）是唯一会真实执行的通道，它的边界写在 lib/bot/dispatch.ts 文件头：
// 仅绑定身份的成员可用、可在设置里关掉、确认类操作（发布/定时/长期记忆）永远回站内点头——
// 所以「不触发发布」在派任务通道上依然成立：发布类工具必然停在 awaiting_confirm，群里无法确认。
//
// 三种进入方式，落到同一批实现上：
//   · 斜杠命令（/热点 /选题 /分析 …）—— 确定性解析，行为永不受 LLM 影响
//   · 自然语言（「今天有什么热点」「我这条为什么没火」）—— 经 lib/bot/intent 识别
//   · 都不像 —— 按老规矩收录成选题候选（唯一无副作用的兜底）

// 帮助文本按白名单裁剪：只列这个群真的能用的。
// 列出用不了的指令 = 教用户去撞一堵墙，比不列更糟。
// 多长算「整篇文章被粘进来了」。低于它按老规矩当选题标题收录（选题标题本来就只留 120 字）。
const LONG_TEXT_CHARS = 300;

const HELP_LINES: { cmd: BotCommandKey; line: string }[] = [
  { cmd: 'chat', line: '· 直接 @我 问问题 → 聊（记得住上下文，接着问「那第二条呢」也行）' },
  { cmd: 'clip', line: '· 发文章链接 / 粘一整篇正文 → 抓正文存档 + 摘要 + 要点 + 结合你账号的用处' },
  { cmd: 'topic', line: '· 直接发短文本 → 收录成选题候选' },
  { cmd: 'analyze', line: '· /分析 [账号名] → 给这个账号做一次数据体检并给反馈' },
  { cmd: 'chat', line: '· /问 你的问题 → 明确要对话（不想被收录成选题时用）' },
  { cmd: 'clip', line: '· /存 链接或正文 → 明确要剪藏（不想被当成选题时用）' },
  { cmd: 'account', line: '· /账号 [名字] → 看/切换本群当前账号' },
  { cmd: 'hot', line: '· /热点 → 看当前热榜 Top' },
  { cmd: 'topic', line: '· /晨报 → 看本群账号今天的选题推荐（也可以直接说「给我今天的选题」）' },
  { cmd: 'topic', line: '· /选题 关键词 → 把关键词收录成选题候选' },
  { cmd: 'crawl', line: '· /采集 竞对主页URL → 加入竞对监控并试采一次' },
  { cmd: 'crawl', line: '· /竞对 [名字] → 看监控中的竞对近期高热作品（带链接）' },
  { cmd: 'clip', line: '· /拆解 竞对作品链接 → 它凭什么跑起来 + 你能借鉴什么' },
  { cmd: 'optimize', line: '· /优化 → 触发一次记忆学习优化' },
  { cmd: 'dispatch', line: '· /派 [卡名] → 派一张一键任务卡真去干（授权按卡上存的）' },
  { cmd: 'dispatch', line: '· /执行 你要做的事 → 一句话派给 AI 执行器（要点头的操作会等你去网页确认）' },
  { cmd: 'dispatch', line: '· /任务 → 看本群派出的任务进度；/终止 → 停掉还在跑的那条' },
  { cmd: 'chat', line: '· /智能体 [名字|默认] → 看有哪些智能体 / 让某个智能体在本群出面（也可以说「换成 XX」）' },
  { cmd: 'chat', line: '· /重置 → 清掉当前对话上下文，重开一轮' },
];

function helpText(allow: string[]): string {
  const lines = HELP_LINES.filter((h) => isCommandAllowed(h.cmd, allow)).map((h) => h.line);
  const off = TOGGLEABLE_COMMANDS.filter((c) => !isCommandAllowed(c.key, allow));
  return [
    '烽火台机器人 · 可用指令：',
    ...lines,
    '· /帮助 → 看这份说明',
    '',
    isCommandAllowed('chat', allow) || isCommandAllowed('topic', allow)
      ? `也可以直接说人话，比如「给我今天的选题」「今天有什么热点」「我的账号最近怎么样」${isCommandAllowed('dispatch', allow) ? '「帮我写一篇秋季穿搭的笔记」（会真去做）' : ''}。`
      : '',
    off.length ? `（管理员在本群关闭了：${off.map((c) => c.name).join('、')}）` : '',
  ].filter(Boolean).join('\n');
}

// 被关掉时的回执。说清楚「谁能开、去哪开」——否则用户只会觉得机器人坏了。
function denied(cmd: BotCommandKey, allow: string[]): string {
  const name = BOT_COMMANDS.find((c) => c.key === cmd)?.name ?? cmd;
  const hint = cmd === 'topic' && isCommandAllowed('chat', allow) ? '想问我问题的话用「/问 …」。' : '';
  return [
    `「${name}」在这个群没有开。`,
    '管理员可到 烽火台 → 工具 → 机器人与通知 → 编辑这个机器人 →「群里允许哪些操作」里开启。',
    hint,
  ].filter(Boolean).join('\n');
}

// 这个机器人开了哪些命令。
// 故意在路由内部查，而不是让三个 endpoint 各自传进来——传参会漏，漏了就是白名单被静默绕过。
// 无 integrationId（单测直调 / 尚未接入的渠道）→ 空数组 = 默认全开，与本功能上线前行为一致。
async function loadAllowCommands(integrationId?: string): Promise<string[]> {
  if (!integrationId) return [];
  const it = await prisma.botIntegration
    .findUnique({ where: { id: integrationId }, select: { allowCommands: true } })
    .catch(() => null);
  return parseJson<string[]>(it?.allowCommands ?? '[]', []);
}

function firstArg(text: string, cmd: string): string {
  return text.slice(cmd.length).trim();
}

// 入站上下文：谁、在哪个会话里说的。缺 integrationId/chatId 时一切照常，只是不记上下文。
export type InboundCtx = {
  provider?: string;
  integrationId?: string;
  chatId?: string;
  senderId?: string;
  /** 这条消息是不是在群里说的。登录/绑定类指令只在**私聊**里响应，见下面 handleInbound。 */
  isGroup?: boolean;
  /** 发消息人的显示名：「加入」时给新成员起名、会话画像里显示是谁在说话。取不到就用兜底名。 */
  senderName?: string;
  /** 群名/对话名（钉钉回调自带 conversationTitle；飞书事件里没有，靠同步补）。会话画像用。 */
  chatName?: string;
};

// ── 各指令的实现（斜杠与自然语言共用）──

async function cmdHot(): Promise<string> {
  const items = await prisma.hotItem.findMany({
    orderBy: [{ heat: 'desc' }, { fetchedAt: 'desc' }],
    take: 8,
    select: { title: true, source: true, isMock: true },
  });
  if (items.length === 0) return '暂无热榜数据（可能还没跑首次采集）。';
  const sourceName = (k: string) => HOT_SOURCES.find((h) => h.key === k)?.name ?? k;
  const lines = items.map((it, i) => `${i + 1}. ${it.title}　—${sourceName(it.source)}${it.isMock ? '（示例）' : ''}`);
  return ['🔥 当前热榜 Top8：', ...lines, `\n看全部 → ${beaconUrl('/hotlists')}`].join('\n');
}

async function cmdTopic(workspaceId: string, kw: string, sourceRef: string, accountId: string | null): Promise<string> {
  if (!kw) return '用法：/选题 你的关键词或标题';
  const r = await ingestTopic(workspaceId, kw, { sourceRef, accountId });
  if (!r.ok) return `收录失败：${r.error ?? ''}`;
  return r.existed
    ? `已存在同名选题（账号：${r.accountName}），未重复添加。`
    : `✅ 已收录成选题候选（账号：${r.accountName}），去引擎里精排 → ${beaconUrl('/topics')}`;
}

async function cmdCrawl(workspaceId: string, raw: string): Promise<string> {
  const url = extractUrl(raw) ?? raw;
  if (!url) return '用法：/采集 竞对主页链接（B站空间/抖音用户/小红书用户页）';
  const r = await ingestCompetitor(workspaceId, url);
  if (!r.ok) return `采集失败：${r.error ?? ''}`;
  return `✅ 已加入竞对监控：${r.name}（${r.platform}）${r.degraded ? '，试采走了降级/示例数据' : `，试采到 ${r.posts} 条`}。查看 → ${beaconUrl('/competitors')}`;
}

// /存：文章剪藏。链接 → 抓正文；纯文本 → 直接当正文。
// 回执刻意「摘要在前、要点其次、分析最后」：群里只瞄一眼的人看第一段就够了。
async function cmdClip(
  workspaceId: string,
  raw: string,
  boundId: string | null,
  opts: { note?: string; mode?: 'note' | 'rival' } = {},
): Promise<string> {
  const acct = await resolveAccount(workspaceId, { boundId });
  const account = acct.ok ? acct.account : null;
  const url = extractUrl(raw);
  // 这条链接是不是监控中竞对的作品？是就换成「爆款拆解」的读法——
  // 同一篇文章，「我该学什么」和「它凭什么火」问的不是一件事，答案也不该一样。
  const rival = url ? await rivalOfUrl(workspaceId, url) : null;
  const mode = opts.mode ?? (rival ? 'rival' : 'note');
  const { clipUrl, clipText } = await import('../clip');
  const common = {
    workspaceId,
    accountId: account?.id,
    accountName: account?.name,
    mode,
    rivalName: rival?.name ?? null,
    // handle+platform 一起传下去：拆解时要按它查这个竞对名下的读者提问（rival-comment 的
    // author 存的是 handle 不是昵称，光有 name 查不到）。
    rivalHandle: rival?.handle ?? null,
    rivalPlatform: rival?.platform ?? null,
  };
  const r = url
    ? await clipUrl({ ...common, url, note: opts.note })
    : await clipText({ ...common, text: raw, note: opts.note });
  return describeClip(r);
}

/** URL 属于本工作区监控中的哪个竞对（不属于返回 null）。按作品链接精确匹配，其次按主页域名/handle。 */
async function rivalOfUrl(
  workspaceId: string,
  url: string,
): Promise<{ name: string; handle: string; platform: string } | null> {
  const watch = await prisma.watchlistItem.findMany({
    where: { workspaceId },
    select: { competitorId: true, competitor: { select: { name: true, handle: true, platform: true } } },
  });
  if (watch.length === 0) return null;
  const hit = await prisma.crawledPost.findFirst({
    where: { url, competitorId: { in: watch.map((w) => w.competitorId) } },
    select: { competitorId: true },
  });
  if (hit) {
    const c = watch.find((w) => w.competitorId === hit.competitorId)?.competitor;
    return c ? { name: c.name, handle: c.handle, platform: c.platform } : null;
  }
  // 作品还没被采到，但链接里带着竞对 handle（如 /@MrBeast/…）也算
  const w = watch.find((x) => x.competitor.handle && url.includes(x.competitor.handle.replace(/^@/, '')));
  return w ? { name: w.competitor.name, handle: w.competitor.handle, platform: w.competitor.platform } : null;
}

export function describeClip(r: Awaited<ReturnType<typeof import('../clip').clipUrl>>): string {
  if (!r.ok) return `剪藏失败：${r.error}`;
  const isRival = r.mode === 'rival';
  const lines = [
    `${isRival ? '🔍 竞对作品拆解' : '📄 已存入收集箱'}${r.duplicate ? '（同链接已存在，已更新）' : ''}：${r.title}`,
    isRival && r.rivalName ? `来自竞对：${r.rivalName}` : r.author ? `作者：${r.author}` : '',
    r.summary ? `\n【${isRival ? '它讲了什么' : '摘要'}】${r.summary}` : '\n（AI 摘要没生成，正文已存好，可去收集箱里再看）',
    r.points.length ? `【${isRival ? '它凭什么跑起来' : '要点'}】\n${r.points.map((p, i) => `${i + 1}. ${p}`).join('\n')}` : '',
    r.analysis ? `【${r.accountName ? `「${r.accountName}」` : '你'}${isRival ? '能借鉴什么' : '的用处'}】${r.analysis}` : '',
    r.degraded ? '\n⚠️ AI 当前降级，上面这段是示例文本，别当结论用。' : '',
    `\n原文 ${r.chars} 字已存档 → ${beaconUrl('/topics?view=inspiration')}`,
    '（存的是他人作品，仅供你分析参考，别直接复用其文字）',
  ];
  return lines.filter(Boolean).join('\n');
}

// /竞对 [名字]：把监控中的竞对最近跑得好的作品端到群里。
//
// 【为什么必须带链接】群里看到「某条播放 12 万」之后，下一个动作一定是「那我看看它写了啥」。
// 没有链接，用户得回网页端翻——多一步就没人做了。带上链接，他直接把链接甩回群里
// 就走剪藏（抓正文 + 拆解），两条命令接成一条动作链。
async function cmdCompetitor(workspaceId: string, name: string): Promise<string> {
  const watch = await prisma.watchlistItem.findMany({
    where: { workspaceId },
    select: { competitor: { select: { id: true, name: true, platform: true, handle: true } } },
  });
  if (watch.length === 0) {
    return `还没有监控任何竞对。发「/采集 竞对主页链接」加一个 → ${beaconUrl('/competitors')}`;
  }
  const all = watch.map((w) => w.competitor);
  const picked = name ? all.filter((c) => c.name.includes(name) || (c.handle ?? '').includes(name)) : all;
  if (picked.length === 0) {
    return `没找到叫「${name}」的竞对。当前监控：${all.map((c) => c.name).join('、')}`;
  }

  const posts = await prisma.crawledPost.findMany({
    where: { competitorId: { in: picked.map((c) => c.id) } },
    orderBy: [{ hotScore: 'desc' }, { publishedAt: 'desc' }],
    take: 8,
    select: { title: true, url: true, hotScore: true, metrics: true, publishedAt: true, competitorId: true },
  });
  if (posts.length === 0) {
    return `${picked.map((c) => c.name).join('、')} 还没有采到作品。去竞对页点一次「刷新」→ ${beaconUrl('/competitors')}`;
  }

  const byId = new Map(picked.map((c) => [c.id, c]));
  const lines = posts.map((p, i) => {
    const views = parseJson<{ views?: number }>(p.metrics, {}).views;
    const who = byId.get(p.competitorId)?.name ?? '';
    const day = p.publishedAt ? fmtDate(p.publishedAt) : '';
    return [
      `${i + 1}. ${p.title.slice(0, 40)}`,
      `   —${who}${day ? ` ${day}` : ''}${views ? ` · ${views}` : ''}${p.hotScore ? ` · 热度${Math.round(p.hotScore)}` : ''}`,
      p.url ? `   ${p.url}` : '',
    ].filter(Boolean).join('\n');
  });
  return [
    `🔭 监控中的竞对近期高热作品（共 ${picked.length} 个号）：`,
    ...lines,
    '',
    '想拆解哪条，把它的链接发给我（或「/拆解 链接」），我抓正文出摘要、爆点和你能借鉴的地方。',
    `全部竞对 → ${beaconUrl('/competitors')}`,
  ].join('\n');
}

// /优化：触发记忆学习优化。真实实现由 lib/memory/optimize（P4）接入。
async function cmdOptimize(workspaceId: string): Promise<string> {
  const { optimizeWorkspaceMemory } = await import('../memory/optimize');
  const r = await optimizeWorkspaceMemory(workspaceId);
  return `🧠 记忆优化完成：\n${r.summaryText}\n人设与记忆 → ${beaconUrl('/persona?tab=memory')}`;
}

// /分析 [账号名]：账号体检。归属必须在回执里说清楚——群里没人知道机器人心里选了哪个号。
async function cmdAnalyze(workspaceId: string, name: string, boundId: string | null): Promise<string> {
  const r = await resolveAccount(workspaceId, { name, boundId });
  if (!r.ok) return r.message;
  return analyzeAccount({ workspaceId, accountId: r.account.id });
}

// /账号 [名字]：看/切换本群当前账号。不传名字=只看现状。
async function cmdAccount(workspaceId: string, name: string, key: ChatKey, boundId: string | null): Promise<string> {
  const accounts = await listActiveAccounts(workspaceId);
  if (accounts.length === 0) return '这个工作区还没有创作者账号，先去烽火台建一个。';

  if (!name) {
    const current = accounts.find((a) => a.id === boundId);
    let head: string;
    if (current) head = `本群当前账号：${accountLine(current)}`;
    else if (accounts.length === 1) head = `本群还没绑定账号，默认用唯一账号 ${accountLine(accounts[0])}`;
    else head = '本群还没绑定账号，多账号情况下我不会替你猜。';
    return [head, `工作区里的账号：${accounts.map(accountLine).join('、')}`, '切换：/账号 名字'].join('\n');
  }

  const r = await resolveAccount(workspaceId, { name });
  if (!r.ok) return r.message;
  const saved = await bindConversationAccount(key, r.account.id);
  if (!saved) return `这个渠道记不住绑定（缺会话信息）。本次可用「/分析 ${r.account.name}」直接指定。`;
  return `✅ 本群当前账号已切到 ${accountLine(r.account)}。之后的对话、体检、收录都记到它名下。`;
}

// /晨报：本群账号今天的选题推荐。与定时推的那份是同一个渲染（lib/topic/brief.ts），只是这次是他要的。
async function cmdBrief(workspaceId: string, boundId: string | null): Promise<string> {
  const r = await resolveAccount(workspaceId, { boundId });
  if (!r.ok) return r.message;
  const brief = buildDailyBrief(r.account.name, await briefTopicsFor(r.account.id));
  if (!brief) {
    return `「${r.account.name}」今天还没有推荐选题（每天 05:00 生成，也可能是账号还没有可推的候选）。去引擎里看看 → ${beaconUrl('/topics')}`;
  }
  // 群消息不渲染 Markdown：把 **加粗** 与 `分数` 的记号去掉，星号原样露出来很难看
  const plain = (line: string) => line.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`(.+?)`/g, '$1');
  return [plain(brief.title), ...brief.lines.map(plain), '', `全部与推荐依据 → ${beaconUrl('/topics')}`].join('\n');
}

// ── 智能体：本会话由谁出面（2026-09-02，一个机器人可以切不同的智能体）──
//
// 优先级：本会话选的（/智能体 X、「换成 X」）→ 渠道默认（设置页绑的）→ 通用运营助手。
// 查不到（模板被删/被卸载）按未选处理——机器人不该因此哑火。
type BotAgent = { id: string; name: string; persona: string };

async function agentById(id: string | null | undefined): Promise<BotAgent | null> {
  if (!id) return null;
  const tpl = await prisma.workflowTemplate.findUnique({ where: { id }, select: { id: true, name: true, persona: true } }).catch(() => null);
  return tpl ? { id: tpl.id, name: tpl.name, persona: tpl.persona || '（未填写职责说明）' } : null;
}

async function currentAgent(integrationId: string | undefined, state: ConversationState): Promise<BotAgent | null> {
  const chosen = await agentById(state.agentTemplateId);
  if (chosen) return chosen;
  if (!integrationId) return null;
  const it = await prisma.botIntegration.findUnique({ where: { id: integrationId }, select: { agentTemplateId: true } }).catch(() => null);
  return agentById(it?.agentTemplateId);
}

/** 这个工作区能派上用场的智能体：已装的内置 + 自建的。 */
async function usableAgents(workspaceId: string): Promise<BotAgent[]> {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { tenantId: true } });
  if (!ws) return [];
  const { listTemplates } = await import('../workflow/market');
  const all = await listTemplates(ws.tenantId);
  return all.filter((t) => t.installed).map((t) => ({ id: t.id, name: t.name, persona: t.persona || '（未填写职责说明）' }));
}

/** 按名字找智能体：全等优先，其次包含；多于一个不猜。 */
function pickAgent(agents: BotAgent[], name: string): { hit: BotAgent } | { hits: BotAgent[] } {
  const exact = agents.filter((a) => a.name === name);
  const hits = exact.length ? exact : agents.filter((a) => a.name.includes(name) || name.includes(a.name));
  return hits.length === 1 ? { hit: hits[0] } : { hits };
}

/** /智能体 [名字|默认]：无参数=列出并标出当前；有名字=切换本会话由它出面；「默认」=回到渠道默认。 */
async function cmdAgent(workspaceId: string, name: string, key: ChatKey, state: ConversationState, integrationId?: string): Promise<string> {
  const agents = await usableAgents(workspaceId);
  const now = await currentAgent(integrationId, state);
  if (!name) {
    if (agents.length === 0) {
      return `这个工作区还没有装任何智能体。去「技能 · 连接器 → 智能体」装一个或自己拼一个 → ${beaconUrl('/workflows')}`;
    }
    return [
      `本群现在由「${now?.name ?? '通用运营助手'}」出面${state.agentTemplateId ? '（本群自己选的）' : now ? '（渠道默认）' : ''}。`,
      '可以切换的智能体：',
      ...agents.map((a, i) => `${i + 1}. ${a.name}${now?.id === a.id ? '（当前）' : ''} — ${a.persona.slice(0, 40)}`),
      '',
      '切换：/智能体 名字（或直接说「换成 名字」）；回到渠道默认：/智能体 默认',
    ].join('\n');
  }
  if (/^(默认|重置|通用|取消)$/.test(name)) {
    const ok = await bindConversationAgent(key, null);
    if (!ok) return '这个渠道记不住选择（缺会话信息）。';
    const back = await currentAgent(integrationId, { ...state, agentTemplateId: null });
    return `✅ 本群回到渠道默认：由「${back?.name ?? '通用运营助手'}」出面。`;
  }
  const picked = pickAgent(agents, name);
  if (!('hit' in picked)) {
    return picked.hits.length === 0
      ? `没有叫「${name}」的智能体。现在有：${agents.map((a) => a.name).join('、') || '（一个都没装）'}`
      : `「${name}」匹配到多个：${picked.hits.map((a) => a.name).join('、')}。请写全名。`;
  }
  const ok = await bindConversationAgent(key, picked.hit.id);
  if (!ok) return `这个渠道记不住选择（缺会话信息）。本次可用「/派」或「/执行」直接派。`;
  return `✅ 本群之后由「${picked.hit.name}」出面：${picked.hit.persona.slice(0, 80)}\n之后的对话按它的职责回答，派活也交给它。换回来：/智能体 默认`;
}

// 自由对话。历史轮次来自本会话，回答完把这一轮追加回去。
async function cmdChat(
  workspaceId: string,
  question: string,
  key: ChatKey,
  state: ConversationState,
  integrationId?: string,
): Promise<string> {
  if (!question) return '想问什么？直接 @我 说就行，比如「我这条视频为什么没起量」。';
  // 账号解析不出来（多账号未绑定）不该挡住对话：没有账号上下文也能聊，只是少了个性化那部分
  const r = await resolveAccount(workspaceId, { boundId: state.accountId });
  const account = r.ok ? r.account : null;

  // 本会话选的智能体 → 渠道默认 → 通用助手。查不到（模板被删/被卸载）按未绑定处理——机器人不该因此哑火
  const agent = await currentAgent(integrationId, state);

  const res = await botChat({
    workspaceId,
    accountId: account?.id ?? null,
    accountName: account?.name ?? null,
    question,
    turns: state.turns,
    agent,
  });
  await appendTurns(key, [{ role: 'user', content: question }, { role: 'assistant', content: res.text }], state.turns);
  return res.text;
}

// 返回给用户的回执文本。回复的发送由 endpoint 负责。
//
// 同一个会话（integrationId+chatId）串行处理：并发跑会让两次 appendTurns 后写覆盖前写，
// 丢一轮上下文（router.ts:424 读 → :407 写之间没有锁）。没有会话 key 的（无状态模式）照常并发。
export async function handleInbound(workspaceId: string, rawText: string, ctx: InboundCtx = {}): Promise<string> {
  if (ctx.integrationId && ctx.chatId) {
    const { runSerialized } = await import('./serialize');
    return runSerialized(`${ctx.integrationId}:${ctx.chatId}`, () => handleInboundNow(workspaceId, rawText, ctx));
  }
  return handleInboundNow(workspaceId, rawText, ctx);
}

async function handleInboundNow(workspaceId: string, rawText: string, ctx: InboundCtx = {}): Promise<string> {
  const text = (rawText || '').trim();
  const provider = ctx.provider ?? 'feishu';
  const key: ChatKey = { workspaceId, integrationId: ctx.integrationId, chatId: ctx.chatId };
  // 会话画像：所有渠道都从这里过，在这一处 touch（类型/群名/发言人/计数），别在各 route 里各记各的
  await touchConversation(key, {
    chatType: ctx.isGroup === undefined ? 'unknown' : ctx.isGroup ? 'group' : 'p2p',
    chatName: ctx.chatName,
    senderId: ctx.senderId,
    senderName: ctx.senderName,
  });
  // 会话状态与白名单各查一次，贯穿全程：本群绑的哪个账号、之前聊到哪儿、管理员开了哪些操作
  const [state, allow] = await Promise.all([loadConversation(key), loadAllowCommands(ctx.integrationId)]);
  const boundId = state.accountId;
  const can = (cmd: BotCommandKey) => isCommandAllowed(cmd, allow);
  if (!text) return helpText(allow);

  // ── 身份指令：登录 / 绑定 / 加入 ───────────────────────────────────────
  //
  // 排在 allowCommands 白名单**之前**，因为它们不是「操作」而是「进门」——
  // 被白名单挡掉的话，企业版会出现「没人能登录，所以没人能去改白名单」的死锁。
  //
  // 🔒 只在私聊里响应。群里发一条登录链接 = 群里任何人点开都能拿到这个人的会话；
  //    绑定码同理（别人抢先绑上去就顶替了本人的身份）。
  //    群里说这些词时明确回一句「私聊我」，而不是静默——静默会让人以为机器人坏了。
  const authCmd = text.match(/^\/?(登录|登陆|绑定)(?=\s|$)/);
  if (authCmd) {
    // 🔒 对外渠道（微信客服/扫码）一律不响应。lib/auth/oa.ts「敢自动加入」的前提是「能私聊到机器人的人
    //    已经过了公司的 OA 认证」——微信这边谁扫码都能聊，这个前提不成立；不拦的话任何微信用户说一声
    //    「登录」就被 autoJoin 收成成员并拿到一次性登录链接（senderId 还会被冒充成 feishu 身份存进 Member）。
    // 微信 iLink：扫码绑定时人就是登录着的（byok.manage 才能绑），这里没有「登录」要做，也不发链接
    if (provider === 'wechat') {
      return '这条通道不用登录：你扫码绑定它的时候已经是登录状态，网页直接打开就行。这里不发登录链接。';
    }
    if (isExternalProvider(provider)) {
      return '这个渠道不支持登录/绑定：微信这边的发送者不是企业应用认证过的成员，烽火台不会凭一条微信消息把人收成成员。要登录请在飞书/钉钉/企微机器人里私聊说「登录」，或直接打开网页登录。';
    }
    if (ctx.isGroup) return '这条要私聊我说——登录链接和绑定码只对你一个人有效，发在群里等于给了所有人。';
    if (!ctx.senderId) return '取不到你的企业应用账号，无法完成身份操作。';
    const oaProvider = (provider === 'dingtalk' || provider === 'wecom' ? provider : 'feishu') as OaProvider;
    const arg = text.replace(/^\/?(登录|登陆|绑定)\s*/, '').trim();

    // 绑定：只有装机管理员会用一次（把 /setup 建的那个账号和自己的企业应用账号接上）
    if (authCmd[1] === '绑定') {
      if (!arg) return '用法：绑定 <6 位绑定码>。码在网页「设置 → 账号与安全 → 绑定企业应用」里拿。';
      return (await bindOaByCode(arg, oaProvider, ctx.senderId)).message;
    }

    // 登录：员工只需要记住这一个词。不是成员的会当场加入（见 lib/auth/oa.ts 文件头）
    const t = await issueOaLoginTicket(oaProvider, ctx.senderId, ctx.senderName);
    if (!t.ok) return t.message;
    const link = `${siteUrl()}/api/auth/oa/magic?t=${t.ticket}`;
    // 新人第一次进来要说清楚"你现在是什么身份"，不能让人以为自己只是拿了条链接
    return t.joined
      ? `欢迎，${t.memberName}！已经把你加进来了，身份是「${t.roleLabel}」。\n点这条链接进入（5 分钟内有效，只能用一次）：\n${link}`
      : `点这条链接登录（5 分钟内有效，只能用一次）：\n${link}`;
  }

  // ── 斜杠指令 ──（注意：\b 是 ASCII 词边界，跟在中文后不成立，故用 (?=\s|$) 收尾）
  if (/^\/(帮助|help)(?=\s|$)/i.test(text)) return helpText(allow);
  if (/^\/热点(?=\s|$)/.test(text)) return can('hot') ? cmdHot() : denied('hot', allow);
  if (/^\/(晨报|今日选题)(?=\s|$)/.test(text)) return can('topic') ? cmdBrief(workspaceId, boundId) : denied('topic', allow);
  if (/^\/智能体(?=\s|$)/.test(text)) {
    return can('chat') ? cmdAgent(workspaceId, firstArg(text, '/智能体'), key, state, ctx.integrationId) : denied('chat', allow);
  }
  if (/^\/选题(?=\s|$)/.test(text)) {
    return can('topic')
      ? cmdTopic(workspaceId, firstArg(text, '/选题'), `bot:${provider}:/选题`, boundId)
      : denied('topic', allow);
  }
  if (/^\/采集(?=\s|$)/.test(text)) {
    return can('crawl') ? cmdCrawl(workspaceId, firstArg(text, '/采集')) : denied('crawl', allow);
  }
  if (/^\/优化(?=\s|$)/.test(text)) return can('optimize') ? cmdOptimize(workspaceId) : denied('optimize', allow);
  const analyzeCmd = text.match(/^\/(分析|体检)(?=\s|$)/);
  if (analyzeCmd) {
    return can('analyze') ? cmdAnalyze(workspaceId, firstArg(text, analyzeCmd[0]), boundId) : denied('analyze', allow);
  }
  if (/^\/账号(?=\s|$)/.test(text)) {
    return can('account') ? cmdAccount(workspaceId, firstArg(text, '/账号'), key, boundId) : denied('account', allow);
  }
  const chatCmd = text.match(/^\/(问|聊)(?=\s|$)/);
  if (chatCmd) {
    return can('chat') ? cmdChat(workspaceId, firstArg(text, chatCmd[0]), key, state, ctx.integrationId) : denied('chat', allow);
  }
  if (/^\/竞对(?=\s|$)/.test(text)) {
    return can('crawl') ? cmdCompetitor(workspaceId, firstArg(text, '/竞对')) : denied('crawl', allow);
  }
  const rivalCmd = text.match(/^\/(拆解|拆)(?=\s|$)/);
  if (rivalCmd) {
    if (!can('clip')) return denied('clip', allow);
    const body = firstArg(text, rivalCmd[0]);
    return body ? cmdClip(workspaceId, body, boundId, { mode: 'rival' }) : '用法：/拆解 竞对作品链接';
  }
  const clipCmd = text.match(/^\/(存|剪藏|收藏)(?=\s|$)/);
  if (clipCmd) {
    if (!can('clip')) return denied('clip', allow);
    const body = firstArg(text, clipCmd[0]);
    return body ? cmdClip(workspaceId, body, boundId) : '用法：/存 文章链接（或直接把正文粘过来）';
  }
  if (/^\/重置(?=\s|$)/.test(text)) {
    if (!can('chat')) return denied('chat', allow);
    await resetConversation(key);
    return '已清掉对话上下文，接下来是全新一轮。（账号绑定保留）';
  }

  // ── 派任务（dispatch）：唯一会真实执行的通道，09-02 起默认开（可在设置里取消勾选），身份闸在 lib/bot/dispatch.ts ──
  if (/^\/派(?=\s|$)/.test(text)) {
    if (!can('dispatch')) return denied('dispatch', allow);
    const { cmdDispatchPreset } = await import('./dispatch');
    return cmdDispatchPreset(workspaceId, ctx, firstArg(text, '/派'), boundId);
  }
  if (/^\/执行(?=\s|$)/.test(text)) {
    if (!can('dispatch')) return denied('dispatch', allow);
    const { cmdDispatchGoal } = await import('./dispatch');
    return cmdDispatchGoal(workspaceId, ctx, firstArg(text, '/执行'), boundId, await currentAgent(ctx.integrationId, state));
  }
  if (/^\/任务(?=\s|$)/.test(text)) {
    if (!can('dispatch')) return denied('dispatch', allow);
    const { cmdChatTasks } = await import('./dispatch');
    return cmdChatTasks(workspaceId, ctx);
  }
  if (/^\/终止(?=\s|$)/.test(text)) {
    if (!can('dispatch')) return denied('dispatch', allow);
    const { cmdStopChatRun } = await import('./dispatch');
    return cmdStopChatRun(workspaceId, ctx, boundId);
  }

  // ── 带链接：优先按链接处理，语义最明确，不必过 LLM ──
  const url = extractUrl(text);
  if (url) {
    // 竞对主页链接 → 直接进竞对监控；文章链接 → 抓正文剪藏；都不成才退回收录成选题。
    // 关了竞对监控就不试采，直接往下走——**不是**静默降级：这条链接照样有归宿，且回执说的是实话
    const asCompetitor = can('crawl') ? await ingestCompetitor(workspaceId, url).catch(() => null) : null;
    if (asCompetitor?.ok) {
      return `✅ 识别为竞对主页，已加入监控：${asCompetitor.name}（${asCompetitor.platform}）→ ${beaconUrl('/competitors')}`;
    }
    // 文章链接：抓正文 + 摘要 + 结合账号分析。抓不到（登录墙/纯视频页/反爬）就退回选题收录，
    // 不让一条链接因为抓取失败就什么都没留下。
    let clipFailure = '';
    if (can('clip')) {
      const note = text.replace(url, '').trim() || undefined;
      const clipped = await cmdClip(workspaceId, url, boundId, { note }).catch(() => null);
      if (clipped && !clipped.startsWith('剪藏失败')) return clipped;
      // 抓不到正文不是「什么都没发生」：把原因说出来，再退回收录。
      // 只回「已收录成选题候选」是静默降级——用户根本不知道摘要为什么没来、下一步该做什么。
      clipFailure = clipped ? clipped.replace(/^剪藏失败：/, '') : '';
      if (!can('topic')) return clipped ?? denied('clip', allow);
    }
    if (!can('topic')) return denied('topic', allow);
    const title = text.replace(url, '').trim() || url;
    const r = await ingestTopic(workspaceId, title, { angle: `来源链接：${url}`, sourceRef: `bot:${provider}:link`, accountId: boundId });
    if (!r.ok) return `收录失败：${r.error ?? ''}`;
    const head = clipFailure ? `⚠️ 没能抓到正文：${clipFailure}\n\n` : '';
    return r.existed
      ? `${head}已存在同名选题，未重复添加。`
      : `${head}✅ 已先把链接收录成选题候选（账号：${r.accountName}）→ ${beaconUrl('/topics')}`;
  }

  // ── 长正文（没有链接）：整篇文章被直接粘进群，收录成 120 字的选题标题等于把它扔了 ──
  if (text.length >= LONG_TEXT_CHARS && can('clip')) {
    return cmdClip(workspaceId, text, boundId);
  }

  // ── 「换成 X」「切换到 X 智能体」：名字在已装智能体里查得到才算切换，查不到照常往下走 ──
  const switchName = can('chat') ? matchAgentSwitch(text) : null;
  if (switchName) {
    const agents = await usableAgents(workspaceId);
    if ('hit' in pickAgent(agents, switchName)) return cmdAgent(workspaceId, switchName, key, state, ctx.integrationId);
  }

  // ── 纯文本：先试着听懂意图，听不懂就按老规矩收录成选题 ──
  // 开了派任务的群，「帮我写一篇…」这种让它去做的句子直接派给执行器（与 /执行 同权、同一道身份闸）
  const intent = await classifyIntent(workspaceId, text, { canRun: can('dispatch') }).catch((): Intent => ({ cmd: 'ingest' }));
  if (intent.cmd === 'chat') {
    // 对话不加「听懂为」前缀，那会让每句回答都像机器人
    if (!can('chat')) return denied('chat', allow);
    const answer = await cmdChat(workspaceId, text, key, state, ctx.integrationId);
    // 这句话像是让它去做、但本群没开派任务：答归答，得告诉他为什么只是「说」没有「做」
    const { looksActionable, wantsExecution } = await import('../agent/intent');
    if (!can('dispatch') && (wantsExecution(text) || looksActionable(text))) {
      return `${answer}\n\n（要我真去做的话，管理员需在 烽火台 → 工具 → 机器人与通知 → 编辑这个机器人 里开启「派任务」）`;
    }
    return answer;
  }
  if (intent.cmd === 'run') {
    if (!can('dispatch')) return denied('dispatch', allow);
    const { cmdDispatchGoal } = await import('./dispatch');
    const body = await cmdDispatchGoal(workspaceId, ctx, text, boundId, await currentAgent(ctx.integrationId, state));
    return `（听懂为：派给 AI 执行器去做，不对的话用「/问」改成提问）\n${body}`;
  }
  if (intent.cmd === 'agent') {
    if (!can('chat')) return denied('chat', allow);
    return cmdAgent(workspaceId, intent.arg, key, state, ctx.integrationId);
  }
  if (intent.cmd !== 'ingest') {
    const body = await runIntent(workspaceId, intent, provider, boundId, allow);
    // 明说是「猜」出来的，猜错时用户立刻知道该改用斜杠指令，而不是以为机器人坏了
    return `（听懂为：${INTENT_LABEL[intent.cmd]}，不对的话请用斜杠指令）\n${body}`;
  }

  if (!can('topic')) return denied('topic', allow);
  const r = await ingestTopic(workspaceId, text, { sourceRef: `bot:${provider}:text`, accountId: boundId });
  if (!r.ok) return `收录失败：${r.error ?? ''}`;
  return r.existed
    ? '已存在同名选题，未重复添加。'
    : `✅ 已收录成选题候选（账号：${r.accountName}）→ ${beaconUrl('/topics')}\n（想问我问题的话，用「/问 …」或直接说「我…吗」，我就不当选题收了）`;
}

const INTENT_LABEL: Record<Exclude<Intent['cmd'], 'ingest' | 'chat' | 'run' | 'agent'>, string> = {
  help: '查看帮助',
  hot: '查看热榜',
  topic: '收录选题',
  crawl: '添加竞对监控',
  optimize: '触发记忆优化',
  analyze: '账号体检',
  brief: '今日选题晨报',
  competitor: '看竞对动态',
};

// chat 在调用方已单独处理（它要带会话上下文），这里不会收到。
// 白名单同样要卡：自然语言认出来的命令和斜杠敲出来的是同一件事，不能从这条路绕过去。
async function runIntent(
  workspaceId: string,
  intent: Intent,
  provider: string,
  boundId: string | null,
  allow: string[],
): Promise<string> {
  const gate = (cmd: BotCommandKey, run: () => Promise<string> | string) =>
    isCommandAllowed(cmd, allow) ? run() : denied(cmd, allow);
  switch (intent.cmd) {
    case 'help': return helpText(allow);
    case 'hot': return gate('hot', cmdHot);
    case 'topic': return gate('topic', () => cmdTopic(workspaceId, intent.arg, `bot:${provider}:nl`, boundId));
    case 'crawl': return gate('crawl', () => cmdCrawl(workspaceId, intent.arg));
    case 'optimize': return gate('optimize', () => cmdOptimize(workspaceId));
    case 'analyze': return gate('analyze', () => cmdAnalyze(workspaceId, intent.arg, boundId));
    case 'brief': return gate('topic', () => cmdBrief(workspaceId, boundId));
    case 'competitor': return gate('crawl', () => cmdCompetitor(workspaceId, intent.arg));
    default: return helpText(allow);
  }
}
