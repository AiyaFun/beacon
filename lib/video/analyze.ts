import { prisma } from '../db';
import { toJson, parseJson } from '../json';
import { log } from '../logger';
import { llmVideo, llmVision, llmComplete } from '../llm/gateway';
import { videoPart, type VideoSource } from '../llm/ark';
import { buildAccountContext } from '../account-context';
import { platformOfLink } from '../clip/platform';
import { pruneInspiration } from '../ingest/inspiration';
import type { ChatMessage } from '../llm/types';

// 视频理解：一条视频 → 结构化拆解（钩子 / 节奏时间线 / 爆点 / 对本账号的用处）→ 存进资讯库。
//
// 【为什么它是剪藏的第四条入口，而不是一个新模块】
// 剪藏解决的是「这条内容讲了什么、对我有什么用」，视频拆解回答的是同一个问题，只是载体不同。
// 所以它复用 InspirationItem 已有的 content/summary/points/analysis 四列（零 schema 变更）、
// 复用 /library 页面、复用「勿直接复用其文字」的标注。三条护栏（见 lib/clip/index.ts 顶部）
// 原样适用，其中第二条尤其重要：**产物绝不进入生成语料池**，有测试钉死。
//
// 【一条比剪藏更干净的地方】剪藏 content 存的是**他人作品的正文**（搬运争议的来源）；
// 视频拆解 content 存的是**我们自己生成的分析**，原视频一个字节都不留。
//
// 🔒 一条不做的事：**服务端绝不去任何平台下载视频**。
// 视频由用户自己提供（本地文件，或他自己放在公网直链上的文件）。抖音/B站/小红书/视频号的
// 播放地址带签名 + 防盗链 + 时效，我们不去解、不去绕——那是「不碰灰色」红线的一部分，
// 与 lib/clip/index.ts 里「不绕过任何反爬」是同一条线。

/** self：分析我自己的作品（可借鉴到语料/复盘）；rival：拆解别人的作品（只学方法，不搬文字）。 */
export type VideoMode = 'self' | 'rival';

/**
 * 三条分析通道，按「手上有什么」自动降级，产出结构与落库完全一样。
 *
 *   video  用户提供了视频文件/直链   → 火山方舟视频理解（最完整：画面 + 口播 + 节奏）
 *   cover  只有封面图 + 文案         → 视觉模型读封面（插件一键分析走这条）
 *   text   只有文案                  → 纯文本模型
 *
 * 【为什么插件一键分析只能到 cover 这一档】作品页上的 <video> 基本都是 blob: 的 MSE 流，
 * 就算偶尔是直链也带防盗链——插件拿不到视频文件本身。而**自动去下载竞对视频这件事本身
 * 就不做**（那是「视频要用户自行下载上传」这条产品规矩的另一面）。所以插件读的仍然是
 * 「用户自己眼睛看得到的那一页」：标题、文案、封面、指标。想要画面级拆解，走上传。
 */
export type AnalyzeChannel = 'video' | 'cover' | 'text';

/** 字幕轨的一行：秒 + 那句话。 */
export type TranscriptLine = { at: number; text: string };

export type VideoAnalyzeParams = {
  workspaceId: string;
  accountId?: string | null;
  mode?: VideoMode;
  /** 视频源：用户本地文件（内联）或他自己的公网直链。有它就走最完整的 video 通道 */
  source?: VideoSource | null;
  /**
   * 封面图，**data: URI**（不是外链）。理由与截图一致：不为了让模型能取，
   * 先把用户/他人的素材挂到公网地址上。插件在页面里把已经加载好的封面转成 data URI 传来。
   */
  coverDataUri?: string | null;
  /** 文案 / 简介——有多少给多少 */
  text?: string | null;
  /**
   * 带时间戳的字幕文字稿（插件从平台自己的字幕轨取回来的）。
   *
   * 【为什么它比让模型"听"更值钱】方舟视频理解只抽帧读画面、收不到音轨（2026-07-31 真机实测），
   * 所以口播这一半本来是丢的。而平台的字幕轨是**精确文本 + 精确时间戳**，比任何 ASR 都准。
   * 有它在，连没有视频文件的封面档都能分析口播结构——这是补齐能力最便宜的一条路。
   *
   * ⚠️ 只有插件拿得到：YouTube 的 timedtext 服务端取回 200 但 0 字节（PO token 门禁），
   * B站的字幕列表未登录恒空。浏览器里带着用户自己的登录态才有。
   */
  transcript?: TranscriptLine[] | null;
  /** 页面上的公开指标（播放/点赞/评论…），让「它凭什么跑起来」有个量级参照 */
  metrics?: Record<string, number> | null;
  /** 用户给的标题；不给就用模型产出的一句话结论兜底 */
  title?: string;
  /** 作品页链接——**只作出处记录**，绝不用它去取视频 */
  originUrl?: string | null;
  /** 拆解别人时带上是谁，让「他这条 vs 你的基线」说得出口 */
  rivalName?: string | null;
  note?: string;
  /** 抽帧频率，长视频调低省 token */
  fps?: number;
};

export type VideoAnalyzeResult =
  | {
      ok: true;
      id: string;
      title: string;
      summary: string;
      points: string[];
      analysis: string;
      report: string;
      model: string;
      /** 这次实际走的是哪一档——回执里要说破，用户才知道「为什么没讲画面」 */
      channel: AnalyzeChannel;
    }
  | { ok: false; error: string };

// 模型吐回来的结构。Markdown 报告由代码渲染，不让模型在 JSON 里塞一大坨长文本——
// 那是 json 模式下最容易解析失败的形状（换行/引号/代码块三重雷）。
type VideoBrief = {
  summary?: string;
  hook?: string;
  beats?: { at?: string; what?: string }[];
  points?: string[];
  uncertain?: string[];
  takeaway?: string;
};

const MAX_BEATS = 12;
const MAX_POINTS = 6;

/**
 * 用户贴的这条 URL 能不能当视频源。
 *
 * 【为什么要专门挡一道】用户第一反应一定是把抖音/B站的作品链接贴进来——那是**网页不是视频文件**，
 * 而且带鉴权，方舟一样取不到。不挡的话用户等 90 秒拿到一句看不懂的方舟报错，
 * 然后合理地以为「这功能坏了」。挡在这里，他 5 秒就知道该怎么做。
 */
export function checkVideoUrl(url: string): { ok: true } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: '这不是一个合法的链接。' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, error: '只支持 http/https 链接。' };
  }
  const plat = platformOfLink(url);
  if (plat.key || !plat.canFetch) {
    return {
      ok: false,
      error: `这是${plat.name}的作品页链接，不是视频文件——平台的播放地址带鉴权和防盗链，我们不去解也不去绕。请把视频下载到本地后上传，或改贴一个能直接播放的 .mp4 直链。`,
    };
  }
  // 直链的判据是「路径看起来是个视频文件」。判不准也放行——真取不到方舟会说，
  // 我们没必要为了拦一个可能的误判，把一批能用的直链（带签名参数的 CDN 地址）一起拦掉。
  return { ok: true };
}

/**
 * 手上这些材料该走哪一档。
 *
 * 注意字幕轨**单独就够格**走 text 档：一条没有封面、文案也只有几个字的视频，
 * 只要拿到了字幕轨，口播结构照样拆得出来——那恰恰是最值钱的一半。
 */
export function pickChannel(
  params: Pick<VideoAnalyzeParams, 'source' | 'coverDataUri' | 'text' | 'transcript'>,
): AnalyzeChannel | null {
  if (params.source) return 'video';
  if (params.coverDataUri) return 'cover';
  if ((params.text ?? '').trim().length >= 20) return 'text';
  if ((params.transcript ?? []).length >= 2) return 'text';
  return null; // 什么都没有——没得分析，别硬跑一次模型
}

/** 分析主流程（视频 / 封面 / 纯文本三档共用）。 */
export async function analyzeVideo(params: VideoAnalyzeParams): Promise<VideoAnalyzeResult> {
  const { workspaceId, accountId } = params;
  const mode: VideoMode = params.mode ?? 'rival';
  const channel = pickChannel(params);
  if (!channel) {
    return { ok: false, error: '这条作品没读到可分析的东西（没有视频、没有封面、也没有文案）。' };
  }
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { tenantId: true } });
  if (!ws) return { ok: false, error: '工作区不存在' };

  // 账号上下文：让「这条对我有什么用」不是泛泛而谈（与剪藏同一套 block 组合）
  let ctxText = '';
  if (accountId) {
    const ctx = await buildAccountContext({
      workspaceId,
      accountId,
      blocks: ['persona', 'fingerprint', 'baseline'],
      maxChars: 1500,
    }).catch(() => null);
    ctxText = ctx?.text ?? '';
  }

  const transcript = normalizeTranscript(params.transcript);

  // 用户侧材料（三档共用的那段文字），按「有什么给什么」拼
  const facts = [
    params.title ? `标题：${params.title}` : '',
    params.rivalName ? `作者：${params.rivalName}` : '',
    params.metrics && Object.keys(params.metrics).length ? `页面上的公开数据：${formatMetrics(params.metrics)}` : '',
    (params.text ?? '').trim() ? `文案/简介：\n${params.text!.trim().slice(0, MAX_TEXT_CHARS)}` : '',
    transcript.length ? `字幕文字稿（平台字幕轨，时间戳精确）：\n${formatTranscript(transcript)}` : '',
    params.note ? `用户想重点看的：${params.note}` : '',
    `请按系统提示的 JSON 结构输出拆解。`,
  ]
    .filter(Boolean)
    .join('\n');

  const system: ChatMessage = {
    role: 'system',
    content: systemPrompt(mode, channel, params.rivalName ?? null, ctxText, transcript.length > 0),
  };

  // 三档各自送进模型的东西不同，但产出结构、解析、落库完全共用
  const res = await runChannel(ws.tenantId, channel, system, facts, params);

  // 【绝不静默降级】分析失败就是失败，不能像剪藏那样「正文照存、摘要留空」——
  // 这条链路上除了分析没有别的产物，存一条空壳只会让用户以为成功了。
  if (!res.ok) return { ok: false, error: res.error };

  const brief = parseJson<VideoBrief>(res.text, {});
  const summary = String(brief.summary ?? '').trim().slice(0, 300);
  const points = (brief.points ?? []).filter(Boolean).map((x) => String(x).slice(0, 80)).slice(0, MAX_POINTS);
  const analysis = String(brief.takeaway ?? '').trim().slice(0, 300);

  if (!summary && !points.length) {
    // 模型返回了合法 JSON 但什么都没说——video 档多半是取不到视频（方舟拉不动那个 URL）。
    // 存一条空壳比报错糟糕得多。
    return {
      ok: false,
      error:
        channel === 'video'
          ? '模型没能读出这条视频的内容。如果用的是链接，多半是方舟那边取不到它；换成本地文件上传更稳。'
          : '模型没能从这条作品里读出可用的信息。',
    };
  }

  const report = renderReport(brief, {
    mode,
    channel,
    rivalName: params.rivalName ?? null,
    model: res.model,
    hasTranscript: transcript.length > 0,
    transcript,
    // checked 取的是**原始入参**是不是数组：清洗后的 transcript 分不出「没查过」和「查过是空的」
    textCarrier: textCarrierState({
      originUrl: params.originUrl,
      checked: Array.isArray(params.transcript),
      hasTranscript: transcript.length > 0,
    }),
  });
  const title = (params.title || summary.slice(0, 40) || '作品拆解').slice(0, 200);

  // 落库：同工作区同出处链接视为同一条（重复分析就更新，不堆重复）
  const originUrl = params.originUrl ?? null;
  const existing = originUrl
    ? await prisma.inspirationItem.findFirst({ where: { workspaceId, url: originUrl }, select: { id: true } })
    : null;

  const data = {
    title,
    url: originUrl,
    platform: originUrl ? platformOfLink(originUrl).key : null,
    author: params.rivalName ?? null,
    note: params.note ?? null,
    source: 'clip', // 与剪藏同属资讯库（/library 按 source='clip' 取），共用一条出口
    content: report,
    summary: summary || null,
    points: toJson(points),
    analysis: analysis || null,
    clippedAt: new Date(),
    state: 'open',
  };

  let id: string;
  if (existing) {
    await prisma.inspirationItem.update({ where: { id: existing.id }, data });
    id = existing.id;
  } else {
    const created = await prisma.inspirationItem.create({
      data: { workspaceId, accountId: accountId ?? null, ...data, tags: toJson([CHANNEL_TAG[channel]]) },
      select: { id: true },
    });
    id = created.id;
    await pruneInspiration(workspaceId).catch(() => {});
  }

  log.info('作品分析完成', { workspaceId, id, mode, channel, model: res.model, points: points.length });
  return { ok: true, id, title, summary, points, analysis, report, model: res.model, channel };
}

const CHANNEL_TAG: Record<AnalyzeChannel, string> = {
  video: '视频拆解',
  cover: '封面拆解',
  text: '文案拆解',
};

/**
 * 报告里「这份结论是看着什么得出的」那一行。三处（报告 / 接口回执 / 插件通知）共用一份，
 * 避免各写一句不一样的——用户在哪儿看到的都得是同一个口径。
 * 故意写成**纯文本**（不带 markdown 强调符）：Chrome 通知里 `**` 会原样显示成星号。
 */
export const CHANNEL_BASIS: Record<AnalyzeChannel, string> = {
  // ⚠️ 这里**故意不写「口播」**。2026-07-31 真机实测：方舟视频理解是按 fps 抽帧读画面的，
  // doubao-seed-evolving 对一条明确带旁白的视频直接回「无音轨」——它听不见声音。
  // 写「画面 + 口播 + 字幕」等于我们自己在夸大依据，正是这行字本来要防的事。
  // 口播能不能被读到，取决于视频有没有**硬字幕**（烧进画面的字幕能被逐帧读出来）。
  video: '完整视频的逐帧画面 + 画面内字幕（按抽帧读画面，不含音轨；口播要靠硬字幕才读得到）',
  cover: '封面图 + 标题文案 —— 没有看视频内容，想要画面级拆解请下载视频后上传',
  text: '标题与文案 —— 没有画面，想要画面级拆解请下载视频后上传',
};

const MAX_TEXT_CHARS = 6_000;

const MAX_TRANSCRIPT_LINES = 400;
/** 报告里最多列多少句字幕。全列会把一页 200 条的资讯库列表拖垮，且扫读价值递减。 */
const TRANSCRIPT_RENDER_LINES = 60;

/** 字幕轨清洗：丢掉空行、按时间排序、截断。插件那头各平台格式不一，统一在这里收口。 */
export function normalizeTranscript(raw: TranscriptLine[] | null | undefined): TranscriptLine[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((l) => l && typeof l.at === 'number' && Number.isFinite(l.at) && l.at >= 0 && String(l.text ?? '').trim())
    .map((l) => ({ at: Math.round(l.at), text: String(l.text).replace(/\s+/g, ' ').trim().slice(0, 200) }))
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX_TRANSCRIPT_LINES);
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function formatTranscript(lines: TranscriptLine[]): string {
  return lines.map((l) => `[${mmss(l.at)}] ${l.text}`).join('\n');
}

/**
 * 这份报告的依据。带字幕轨时要**额外说一句**——否则用户看到「不含音轨」会以为口播没被读到，
 * 而实际上字幕轨给的口播文本比听音轨还准。
 */
export function basisOf(channel: AnalyzeChannel, hasTranscript: boolean): string {
  const base = CHANNEL_BASIS[channel];
  return hasTranscript ? `${base}；另有平台字幕轨的完整文字稿（口播内容精确到时间点）` : base;
}

// ── 文本载体体检（确定性判断，不过模型） ────────────────────────────
//
// 【这条提示在说什么】视频的口播是声音，声音不是文本。平台站内搜索、外部搜索引擎、
// AI 检索读的都是文本——标题、简介、字幕。一条纯口播、不写字幕的视频，
// 说过的话在检索侧**根本不存在**。这是「有没有文本载体」的事实判断，
// 不是内容质量判断，所以在代码里算，一分配额都不烧（与 review.ts「确定性判定在代码算」同一条）。
//
// ⚠️ 措辞上有两件事不许做：
//   ① 不许暗示我们听到了音轨——我们没有，方舟只抽帧读画面（见 CHANNEL_BASIS.video 的注释）。
//      提示里反而要把这一点再说一遍：我们和检索引擎一样，读不到那半份内容。
//   ② 不许承诺「上了字幕就会被引用」。我们知道的只有「没有文本载体 → 读不到」这一半。

/** 文本载体三档。`unknown` 是这里最要紧的一档，理由见 TRANSCRIPT_SOURCE_PLATFORMS。 */
export type TextCarrierState = 'ok' | 'missing' | 'unknown';

/**
 * 插件真的会去要字幕轨的平台——**只有这两家**（唯一事实来源：extension/content/work.js 的 transcript()）。
 *
 * 【为什么必须列白名单，而不是「transcript 空 = 这条没字幕」】
 * 抖音/小红书/TikTok/X 我们**压根没去要过**字幕：那是我们取不到，不是用户没上。
 * 对着这些平台报「你这条没字幕」，就是把 unknown 印成 no——与 lib/insight/platform-metrics.ts
 * 顶部那条口径是同一件事，也是这个库反复踩过的坑。
 *
 * isVideoUrl 再挡一道形态：B站专栏 /read/cv…、YouTube 频道页 /@xxx 根本没有口播这回事，
 * 对着一篇图文说「你没上字幕」是纯粹的胡说。判不准就退回 unknown，宁可不提示。
 */
export const TRANSCRIPT_SOURCE_PLATFORMS: Record<string, { name: string; isVideoUrl: (u: URL) => boolean }> = {
  youtube: {
    name: 'YouTube',
    // youtu.be/<id> 只会是视频；youtube.com 得看路径
    isVideoUrl: (u) =>
      /(^|\.)youtu\.be$/.test(u.hostname)
        ? u.pathname.length > 1
        : /^\/(watch|shorts\/|live\/|embed\/)/.test(u.pathname),
  },
  // b23.tv 短链背后可能是专栏/直播，展不开就不猜（插件读的是展开后的真实地址，这里不亏）
  bilibili: { name: 'B站', isVideoUrl: (u) => /^\/video\//.test(u.pathname) },
};

function transcriptSourceOf(url: string | null | undefined): string | null {
  if (!url) return null;
  const entry = TRANSCRIPT_SOURCE_PLATFORMS[platformOfLink(url).key ?? ''];
  if (!entry) return null;
  try {
    return entry.isVideoUrl(new URL(url)) ? entry.name : null;
  } catch {
    return null;
  }
}

/**
 * 这条视频的口播有没有文本载体。
 *
 * 三档分别是：
 *   ok       拿到了字幕文字稿 —— 什么都不用说（有字幕是常态，夸一句是废话）
 *   missing  去要过、确实是空的，且这个平台我们要得到 —— 出提示
 *   unknown  没去要过 / 这个平台要不到 / 这个链接不是视频页 —— **闭嘴**
 */
export function textCarrierState(opts: {
  originUrl?: string | null;
  /**
   * 这条链路有没有真的去要过字幕轨。
   *
   * ⚠️ **不许用清洗后的数组反推**：normalizeTranscript(null) 也返回 []，一反推就把
   * 「没人查过」抹成「查过、没有」。/api/video/analyze 的上传档从不传 transcript 字段，
   * 靠这个布尔量才没被误报成「你没上字幕」。这就是「缺席不许当 0」在这条链路上的样子。
   */
  checked: boolean;
  hasTranscript: boolean;
}): { state: TextCarrierState; platform: string | null } {
  if (opts.hasTranscript) return { state: 'ok', platform: null };
  const platform = transcriptSourceOf(opts.originUrl);
  if (!opts.checked || !platform) return { state: 'unknown', platform: null };
  return { state: 'missing', platform };
}

/** 提示的小标题。报告与用例引用同一份，不许两处各写一遍。 */
export const TEXT_CARRIER_HEADING = '检索可见性：没有取到字幕文字稿';

/** missing 档的正文。只陈述「文本载体缺失 → 检索读不到」，不承诺补了就会被引用。 */
export function textCarrierLines(platform: string): string[] {
  return [
    `## ${TEXT_CARRIER_HEADING}`,
    '- 这条视频里说了什么，现在没有文本载体：平台站内搜索、AI 检索能读到的只有标题、简介这类文字，' +
      '口播内容不在其中（我们这边同样读不到——视频理解只抽帧看画面，听不见声音）。',
    '- 可做的：把核心结论落进标题/简介，或在评论区置顶一条文字版要点，或给这条视频上字幕。',
    `- 依据：插件在你的浏览器里向${platform}要过这条视频的字幕轨，回来是空的。` +
      '登录态或风控也可能让它回空，拿不准就去作品页自己看一眼。',
    '',
  ];
}

function formatMetrics(m: Record<string, number>): string {
  const NAMES: Record<string, string> = {
    views: '播放', likes: '点赞', comments: '评论', collects: '收藏',
    shares: '转发', danmaku: '弹幕', coins: '投币', reads: '阅读',
  };
  return Object.entries(m)
    .filter(([, v]) => typeof v === 'number' && v > 0)
    .map(([k, v]) => `${NAMES[k] ?? k} ${v}`)
    .join('、');
}

/**
 * 按通道把材料送进对应的模型。
 *
 * ⚠️ 三条链路的失败语义**故意不一样**：
 *   video/cover 用 llmVideo/llmVision —— 这两条**绝不降级 Mock**（产物是要当结论看的，
 *       编出来的画面描述比没有更糟）；
 *   text 用 llmComplete —— 它会降级 Mock，所以要把 degraded 也当失败处理，
 *       否则用户会拿到一份「示例」拆解却看不出来。
 */
async function runChannel(
  tenantId: string,
  channel: AnalyzeChannel,
  system: ChatMessage,
  facts: string,
  params: VideoAnalyzeParams,
): Promise<{ ok: true; text: string; model: string } | { ok: false; error: string }> {
  if (channel === 'video') {
    return llmVideo(
      tenantId,
      [system, { role: 'user', content: [videoPart(params.source!, params.fps), { type: 'text', text: facts }] }],
      { json: true, temperature: 0.3 },
    );
  }
  if (channel === 'cover') {
    return llmVision(
      tenantId,
      [system, { role: 'user', content: [{ type: 'image_url', image_url: { url: params.coverDataUri! } }, { type: 'text', text: facts }] }],
      { json: true, temperature: 0.3 },
    );
  }
  const res = await llmComplete(tenantId, 'generation', [system, { role: 'user', content: facts }], {
    json: true,
    temperature: 0.3,
  });
  if (res.mocked || res.degraded) {
    return { ok: false, error: 'AI 服务当前不可用，这次没有生成真实拆解（不给你存示例内容）。稍后再试。' };
  }
  return { ok: true, text: res.text, model: res.model };
}

// ── prompt ────────────────────────────────────────────────
//
// 【三分法：画面证据 / 口播字幕 / 推断】
// 这是这条链路里唯一真正的正确性护栏。视觉模型最擅长的失败方式是「把看着像的说成事实」——
// 报价、参数、型号、日期，编起来毫无破绽。而这些产物是要进用户的资讯库、被当结论用的。
// 所以：说不清的必须进 uncertain，而不是猜一个填进 points。
// 这与复盘里 causes[{evidence:'data'|'guess'}] 的标注体系是同一条口径（见 lib/insight/review.ts）。
function systemPrompt(
  mode: VideoMode,
  channel: AnalyzeChannel,
  rivalName: string | null,
  ctxText: string,
  hasTranscript: boolean,
): string {
  const who = mode === 'self' ? '**这位创作者自己的作品**' : `**同行${rivalName ? `「${rivalName}」` : ''}的作品**`;
  // 每档「看得见什么」不同，必须说清楚——否则模型会拿封面图当整条视频编时间线。
  // ⚠️ video 档**不能说「你能听到口播/音效」**。真机实测（2026-07-31）方舟是按 fps 抽帧读画面的，
  // 模型收不到音轨。说它能听，它就会顺着编出「旁白说了什么」——和编造分镜时间线一样骗人。
  const material = {
    video: '你能看到这条视频的**逐帧画面**（含烧录在画面里的字幕）。你**听不到任何声音**：没有音轨、没有口播、没有音效——这些一律不许臆测。',
    cover: '你只能看到**封面图**和文字信息，**看不到视频内容本身**。',
    text: '你只能看到**文字信息**，看不到任何画面。',
  }[channel];

  // 有字幕轨时：口播内容是**已知的精确文本**，不再是「不许臆测」的东西。
  // 但必须同时说死一件事——字幕给的是「说了什么」，不是「画面上发生了什么」，
  // 两者不能混着写，否则 cover 档会拿字幕去编画面。
  const transcriptNote = hasTranscript
    ? channel === 'video'
      ? '\n另外你拿到了**平台字幕轨的完整文字稿**（带精确时间戳）：口播说了什么以它为准，不要凭画面猜。画面看到的和字幕说到的要分开写。'
      : '\n另外你拿到了**平台字幕轨的完整文字稿**（带精确时间戳）：这条视频的口播内容以它为准，可以据此分析开场怎么说、信息怎么铺、结尾怎么收。' +
        '但字幕只告诉你**说了什么**，**没有告诉你画面上发生了什么**——不许据此描述任何画面、镜头或分镜。'
    : '';

  const rules = [
    '1. **只说材料里真实出现的东西**。没看到、没写到的，一个字都不许加。',
    '2. 价格、参数、型号、日期、数据这类**具体数字，看不清就不要写**，放进 uncertain 说明「未明确」。',
    '   编一个看起来合理的数字，比留空糟糕得多——用户会拿它当事实用。',
    '3. 分不清是看到的还是推断的时候，按推断处理，放进 uncertain。',
  ];

  if (channel === 'video') {
    rules.push(
      '4. beats 是节奏时间线：这条视频**在什么时间点做了什么**（画面切了什么、口播说到哪、字幕打了什么）。',
      `   最多 ${MAX_BEATS} 段，at 用 "0:00-0:05" 这种格式，what 一句话说清那几秒发生了什么。`,
      '5. hook：前 3 秒具体用什么抓人（悬念？冲突？结果前置？数字？），要说**做法**不要说「开头吸引人」。',
    );
  } else {
    // ⚠️ 没有视频却让它填 beats，模型一定会顺着编一条时间线出来——这是本链路最容易
    // 骗过用户的失败形态（编得有鼻子有眼，还带时间戳）。所以显式禁止。
    rules.push(
      '4. **beats 必须是空数组 []**。你没看到视频，不许编造任何时间线或分镜。',
      channel === 'cover'
        ? '5. hook：只根据**封面图和标题**说它用什么抓人（画面主体、大字、表情、对比、悬念文案）。不要猜视频里怎么开头。'
        : '5. hook：只根据**标题和文案**说它用什么抓人。不要猜画面。',
    );
  }

  rules.push(
    `6. points：${MAX_POINTS} 条以内「它凭什么能跑起来」，每条要指出具体做法（选题角度、信息密度、`,
    '   情绪节奏、画面呈现、字幕/音效运用、结尾引导）。「内容优质」「制作精良」这种话一条都不要。',
    mode === 'self'
      ? '7. takeaway：结合下面这个账号，说这条**下次可以怎么改进**——具体到某一段、某个做法。'
      : '7. takeaway：结合下面这个账号，说这一层**他能不能借鉴、怎么借鉴**。只借鉴方法，不搬文字与画面；照抄是洗稿，明确不要那么建议。',
  );

  return [
    `你在帮一位内容创作者拆解一条作品。这是${who}。${material}${transcriptNote}`,
    '',
    '硬要求（违反任何一条这次输出就是废的）：',
    ...rules,
    ctxText ? `\n【这个账号是谁】\n${ctxText}` : '',
    '',
    '严格输出 JSON（不要 markdown 代码块）：',
    '{"summary":"","hook":"","beats":[{"at":"0:00-0:05","what":""}],"points":[""],"uncertain":[""],"takeaway":""}',
  ]
    .filter(Boolean)
    .join('\n');
}

// ── 报告渲染 ────────────────────────────────────────────────
// Markdown 由代码拼，不由模型生成：结构固定的部分交给代码，模型只负责填内容。
// 好处是报告形态永远一致（用户能扫读），且不会因为模型少写一个 ## 就排版崩掉。
function renderReport(
  brief: VideoBrief,
  meta: {
    mode: VideoMode;
    channel: AnalyzeChannel;
    rivalName: string | null;
    model: string;
    hasTranscript: boolean;
    transcript?: TranscriptLine[];
    textCarrier?: { state: TextCarrierState; platform: string | null };
  },
): string {
  const lines: string[] = [];
  // 只有真看了视频才允许有**画面**时间线。prompt 里已经禁止过一次，这里再挡一道：
  // 提示词只降低概率，代码才是保证——编造的分镜带着时间戳，用户几乎不可能识别出来。
  // ⚠️ 有字幕轨**也不放开这一条**：字幕说的是「说了什么」，不是「画面上发生了什么」。
  const beats = meta.channel === 'video' ? (brief.beats ?? []).slice(0, MAX_BEATS).filter((b) => b?.what) : [];
  const uncertain = (brief.uncertain ?? []).filter(Boolean).map(String);

  lines.push(meta.mode === 'self' ? '# 自有作品拆解' : `# 竞对作品拆解${meta.rivalName ? `：${meta.rivalName}` : ''}`);
  lines.push('');
  // 依据说破：用户必须一眼看到这份报告是「看了视频」还是「只看了封面」得出的，
  // 否则封面档的结论会被当成视频级结论用。
  lines.push(`> 分析依据：${basisOf(meta.channel, meta.hasTranscript)}`);
  lines.push('');
  if (brief.summary) lines.push(String(brief.summary), '');
  if (brief.hook) lines.push('## 开头钩子', String(brief.hook), '');

  if (beats.length) {
    lines.push('## 节奏时间线（画面）');
    for (const b of beats) lines.push(`- \`${String(b.at ?? '').slice(0, 20) || '—'}\` ${String(b.what).slice(0, 200)}`);
    lines.push('');
  }

  // 口播时间线**由代码直接从字幕轨渲染，不经模型**。
  // 让模型转述一遍只会引入漂移（漏句、改写、时间戳对不上），而这份数据本身就是精确的——
  // 凡是已经精确的东西，就不该再过一次模型。这与 review.ts「确定性判定在代码算」是同一条原则。
  const tr = meta.transcript ?? [];
  if (tr.length) {
    lines.push('## 口播时间线（平台字幕轨原文）');
    for (const l of tr.slice(0, TRANSCRIPT_RENDER_LINES)) lines.push(`- \`${mmss(l.at)}\` ${l.text}`);
    if (tr.length > TRANSCRIPT_RENDER_LINES) lines.push(`- …（共 ${tr.length} 句，此处只列前 ${TRANSCRIPT_RENDER_LINES} 句）`);
    lines.push('');
  }

  const points = (brief.points ?? []).filter(Boolean).slice(0, MAX_POINTS);
  if (points.length) {
    lines.push(meta.mode === 'self' ? '## 这条做对了什么' : '## 它凭什么跑起来');
    for (const p of points) lines.push(`- ${String(p).slice(0, 200)}`);
    lines.push('');
  }

  if (brief.takeaway) {
    lines.push(meta.mode === 'self' ? '## 下次可以怎么改' : '## 你能借鉴哪一层');
    lines.push(String(brief.takeaway), '');
  }

  // 文本载体体检：**只有 missing 才出声**。
  // ok 档出一句「你有字幕，很好」是纯废话；unknown 档出任何话都会被读成结论，
  // 而我们那时手里什么结论都没有（见 textCarrierState 的三档注释）。
  const tc = meta.textCarrier;
  if (tc?.state === 'missing' && tc.platform) lines.push(...textCarrierLines(tc.platform));

  // uncertain 必须显式渲染出来，哪怕是空的也说一句「无」——
  // 「模型说不准的东西」是这份报告最需要被看见的部分，藏起来等于默认它全是事实。
  lines.push('## 视频里没说清的（需人工复核）');
  if (uncertain.length) for (const u of uncertain) lines.push(`- ${u.slice(0, 200)}`);
  else lines.push('- （模型未标注存疑项，但仍建议对具体数字自行复核）');
  lines.push('');

  lines.push('---');
  lines.push(`> 由 \`${meta.model}\` 生成，仅供你自己分析参考。原作品内容归原作者所有，请勿直接复用其文字或画面。`);
  return lines.join('\n');
}
