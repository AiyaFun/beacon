import { prisma } from '../db';
import { toJson, parseJson } from '../json';
import { log } from '../logger';
import { llmComplete } from '../llm/gateway';
import { buildAccountContext } from '../account-context';
import { safeFetch, type FetchPage } from '../web/fetch';
import { extractArticle, type ExtractedArticle } from './extract';
import { platformOfLink, storablePlatform } from './platform';
import { pruneInspiration } from '../ingest/inspiration';

// 文章剪藏：群里发一条链接或一段长正文 → 抓正文 → 摘要 + 要点 + 结合本账号的分析 → 存进收集箱。
//
// ⚠️【这里存的是他人作品的正文，与收集箱原先「只存标题+链接」的口径不同】
// 那条口径写在 lib/ingest/inspiration.ts 顶部，理由是「正文是搬运」。2026-07-29 按需求放开，
// 但必须同时立三条护栏，缺一条这功能就从「学习工具」变成「洗稿工具」：
//   ① 只落到用户自己工作区（InspirationItem.workspaceId + RLS），不共享、不对外提供；
//   ② **绝不进入生成语料池**——「像我一样写」的原句样本只取
//      Material(type='sample') / PublishRecord.contentText / DraftVersion(human) 三处，
//      剪藏正文一条都不在其中，且有测试钉死（tests/clip/never-in-exemplar.test.ts）；
//   ③ 产出以摘要/要点/分析为主，回执与页面都标注来源和「勿直接复用文字」。
// 用途落在「为个人学习、研究使用他人已发表作品」的范围内；越过这条线的是「拿正文去生成近似内容」，
// 那件事这个模块不做，也不给任何人做的入口。

const MAX_STORE_CHARS = 20_000; // 落库正文上限
const MAX_LLM_CHARS = 8_000; // 送进模型的正文上限
const MIN_CHARS = 120; // 少于这个字数不算解析出正文

export type ClipResult =
  | {
      ok: true;
      id: string;
      title: string;
      author: string;
      url: string | null;
      summary: string;
      points: string[];
      analysis: string;
      chars: number;
      mode: ClipMode;
      rivalName: string | null;
      duplicate: boolean;
      degraded: boolean; // AI 降级/Mock：摘要不可当结论
      accountName: string | null;
    }
  | { ok: false; error: string };

// 两种读法，产出结构一样、提问角度不同：
//   note  学习笔记 —— 这篇讲了什么、对我有什么用（默认）
//   rival 爆款拆解 —— 它凭什么跑起来、我能借鉴哪一层（发的是监控中竞对的作品时自动切到这个）
export type ClipMode = 'note' | 'rival';

type Common = {
  workspaceId: string;
  accountId?: string | null;
  accountName?: string | null;
  mode?: ClipMode;
  /** 竞对拆解时带上是谁的作品，让分析能说「他这条 vs 你的基线」 */
  rivalName?: string | null;
};

/** 链接 → 剪藏。fetchPage 可注入，单测不碰网络。 */
export async function clipUrl(
  params: Common & { url: string; note?: string; fetchPage?: FetchPage },
): Promise<ClipResult> {
  // 已知服务器抓不到的平台：不空跑一次抓取再报错——那要等 10 秒且看起来像 bug。
  // （fetchPage 注入时不走这条：单测要能验解析逻辑本身。）
  const plat = platformOfLink(params.url);
  if (!params.fetchPage && !plat.canFetch) {
    return { ok: false, error: `${plat.name}：${plat.hint ?? '服务器抓不到这个平台的正文。'}` };
  }

  let page;
  try {
    page = await (params.fetchPage ?? ((u: string) => safeFetch(u)))(params.url);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '抓取失败' };
  }
  const wall = detectWall(page.finalUrl.toString(), page.text);
  if (wall) return { ok: false, error: wall };

  const looksHtml = /html/i.test(page.contentType) || /^\s*</.test(page.text);
  const article: ExtractedArticle = looksHtml
    ? extractArticle(page.text, { maxChars: MAX_STORE_CHARS })
    : { title: '', author: '', siteName: '', publishedAt: '', text: page.text.slice(0, MAX_STORE_CHARS), chars: Math.min(page.text.length, MAX_STORE_CHARS) };

  if (article.text.length < MIN_CHARS) {
    return { ok: false, error: '这个链接没解析出正文（可能需要登录、是纯视频页，或站点做了反爬）。可以把正文直接粘到群里发给我。' };
  }
  return summarizeAndStore(params, article, page.finalUrl.toString(), params.note);
}

// ── 抓取墙识别 ────────────────────────────────────────────
//
// 【为什么要单独识别，而不是笼统报「没解析出正文」】
// 服务器 IP 去抓这些站，多数会被挡在门外——但每家挡的方式不同，用户能做的事也不同。
// 一句「解析失败」等于让他去猜；说清「微信对服务器访问返回验证页，你把正文粘进来就行」，
// 他 10 秒就能继续。**这类失败是常态不是异常**，文案质量决定这个功能好不好用。
//
// 🔒 一条不做的事：**不绕过任何反爬**（不伪装 UA/Referer、不打码、不走住宅代理）。
// 那是项目既定红线「不碰灰色」的一部分；能抓就抓，抓不到就如实说并给合法路径。
const WALLS: { name: string; hit: (url: string, html: string) => boolean; msg: string }[] = [
  {
    name: 'wechat-captcha',
    hit: (u) => /wappoc_appmsgcaptcha|appmsgcaptcha/.test(u),
    msg: '微信对服务器直接访问返回了验证页（反爬），我不绕过它。把正文直接粘到群里发我即可，或用采集助手在浏览器里打开文章后一键存入资讯库。',
  },
  {
    name: 'wechat-env',
    hit: (_u, h) => /<title[^>]*>\s*(未知错误|环境异常)/.test(h) || /请在微信客户端打开/.test(h),
    msg: '微信要求在客户端内打开这篇文章，服务器取不到正文。把正文粘到群里发我，或用采集助手在浏览器里存。',
  },
  {
    name: 'login-wall',
    hit: (_u, h) => /(请先登录|登录后查看|需要登录后|Sign in to continue|Log in to continue)/i.test(h) && h.length < 60_000,
    msg: '这个页面要登录才看得到正文，服务器没有你的登录态。用采集助手在浏览器里打开它再存，或把正文粘给我。',
  },
  {
    name: 'js-rendered',
    // 抖音/小红书这类：返回的是空壳 HTML，正文全靠 JS 渲染，服务端抓到的只有骨架
    hit: (_u, h) => h.length > 0 && h.length < 8000 && /__NEXT_DATA__|__INITIAL_STATE__|<div id="root"><\/div>/.test(h),
    msg: '这个站的正文是浏览器里跑 JS 才渲染出来的，服务器抓到的是空壳。用采集助手在页面上一键存入资讯库最稳。',
  },
];

function detectWall(url: string, html: string): string | null {
  for (const w of WALLS) {
    try {
      if (w.hit(url, html)) return w.msg;
    } catch {
      // 单条规则出错不影响其它规则
    }
  }
  return null;
}

/**
 * 插件在浏览器里抓到的正文 → 资讯库。
 *
 * 【为什么必须有这条通道】服务器 IP 去抓小红书/抖音/X/公众号，拿到的不是验证页就是 JS 空壳
 * （见 lib/clip/platform.ts 的 canFetch 表）。而插件跑在用户自己的浏览器里，页面**已经渲染好、
 * 登录态也在**——同一篇内容，那边随手可得。这不是绕过反爬：读的是用户自己眼睛看得到的那一页。
 */
export async function clipCaptured(
  params: Common & {
    text: string;
    title?: string;
    url?: string | null;
    author?: string | null;
    platform?: string | null;
    note?: string;
  },
): Promise<ClipResult> {
  const text = params.text.trim().slice(0, MAX_STORE_CHARS);
  if (text.length < MIN_CHARS) return { ok: false, error: '这一页没抓到足够的正文' };
  const article: ExtractedArticle = {
    title: (params.title || text.split('\n')[0]).trim().slice(0, 200),
    author: (params.author ?? '').slice(0, 80),
    siteName: '',
    publishedAt: '',
    text,
    chars: text.length,
  };
  return summarizeAndStore(params, article, params.url ?? null, params.note, params.platform ?? null);
}

/** 直接粘正文 → 剪藏（没有链接时走这条）。 */
export async function clipText(params: Common & { text: string; title?: string; note?: string }): Promise<ClipResult> {
  const text = params.text.trim().slice(0, MAX_STORE_CHARS);
  if (text.length < MIN_CHARS) return { ok: false, error: '正文太短，没必要剪藏' };
  const firstLine = text.split('\n')[0].trim();
  const article: ExtractedArticle = {
    title: (params.title || firstLine).slice(0, 120),
    author: '',
    siteName: '',
    publishedAt: '',
    text,
    chars: text.length,
  };
  return summarizeAndStore(params, article, null, params.note);
}

// 摘要 + 要点 + 结合账号的分析 → 落库
async function summarizeAndStore(
  params: Common,
  article: ExtractedArticle,
  url: string | null,
  note?: string,
  platformOverride?: string | null,
): Promise<ClipResult> {
  const { workspaceId, accountId } = params;
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { tenantId: true } });
  if (!ws) return { ok: false, error: '工作区不存在' };

  // 账号上下文：让「这篇对我有什么用」不是泛泛而谈。没有账号也照做，只是少了这一层。
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

  let summary = '';
  let points: string[] = [];
  let analysis = '';
  let degraded = false;

  const mode: ClipMode = params.mode ?? 'note';
  const rival = params.rivalName;

  try {
    const res = await llmComplete(ws.tenantId, 'generation', [
      {
        role: 'system',
        content: (mode === 'rival'
          ? [
              `你在帮一位内容创作者拆解**同行${rival ? `「${rival}」` : ''}的一篇作品**。基于给定正文输出拆解结论。`,
              '硬要求：',
              '1. 只根据正文写，正文里没有的信息一个字都不许加；拿不准就不写。',
              '2. summary：120 字以内说清这篇讲了什么。',
              '3. points：3–5 条「它凭什么能跑起来」——选题角度、标题钩子、开头怎么抓人、结构怎么排、',
              '   情绪或利益点在哪。每条 30 字以内，要指出**具体做法**，不要「内容优质」这种废话。',
              '4. takeaway：结合下面这个账号，说「这一层他能不能借鉴、怎么借鉴」。',
              '   **只借鉴方法，不搬文字**——照抄原文是洗稿，明确不要建议那么做。80 字以内。',
            ]
          : [
              '你在帮一位内容创作者读一篇文章。基于**给定正文**输出结构化笔记。',
              '硬要求：',
              '1. 只根据正文写，正文里没有的信息一个字都不许加；拿不准就不写。',
              '2. summary：120 字以内说清这篇讲了什么、结论是什么。',
              '3. points：3–5 条要点，每条 30 字以内，要具体（含数字/案例/方法名就带上）。',
              '4. takeaway：结合下面这个账号，说「这篇对他有什么用」——可切入的角度、可借鉴的结构、或明确说「跟他的方向关系不大」。',
              '   不要建议照抄原文文字，那是洗稿；说的是思路层面怎么用。80 字以内。',
            ]
        ).concat([
          ctxText ? `\n【这个账号是谁】\n${ctxText}` : '',
          '严格输出 JSON：{"summary":"","points":["",""],"takeaway":""}',
        ]).filter(Boolean).join('\n'),
      },
      {
        role: 'user',
        content: `标题：${article.title || '(无标题)'}\n${article.author ? `作者：${article.author}\n` : ''}正文：\n${article.text.slice(0, MAX_LLM_CHARS)}`,
      },
    ], { json: true, temperature: 0.3 });

    degraded = !!res.mocked || !!res.degraded;
    const parsed = parseJson<{ summary?: string; points?: string[]; takeaway?: string }>(res.text, {});
    summary = String(parsed.summary ?? '').slice(0, 300);
    points = (parsed.points ?? []).filter(Boolean).map((x) => String(x).slice(0, 60)).slice(0, 5);
    analysis = String(parsed.takeaway ?? '').slice(0, 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    // 配额/演示态：正文照存，摘要留空并说明——存下来的东西不该因为 AI 不可用就丢了
    degraded = true;
    if (!/配额|quota|演示/.test(msg)) log.warn('剪藏摘要失败', { workspaceId, err: e });
    summary = '';
  }

  // 落库：同工作区同 URL 视为同一条（重复发就更新，不堆重复）
  const existing = url ? await prisma.inspirationItem.findFirst({ where: { workspaceId, url }, select: { id: true } }) : null;
  const data = {
    title: (article.title || summary.slice(0, 40) || '未命名剪藏').slice(0, 200),
    url,
    // 插件知道自己在哪个站上，比从 URL 猜准；没给才回退到按域名推断
    platform: platformOverride ?? (url ? storablePlatform(url) : null),
    author: article.author || null,
    note: note ?? null,
    source: 'clip',
    content: article.text,
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
      data: { workspaceId, accountId: accountId ?? null, ...data, tags: '[]' },
      select: { id: true },
    });
    id = created.id;
    await pruneInspiration(workspaceId).catch(() => {});
  }

  return {
    ok: true,
    id,
    title: data.title,
    author: article.author,
    url,
    summary,
    points,
    analysis,
    chars: article.chars,
    mode,
    rivalName: rival ?? null,
    duplicate: !!existing,
    degraded,
    accountName: params.accountName ?? null,
  };
}
