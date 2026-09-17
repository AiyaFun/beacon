// 页面直读：模型从页面可见文字里读出作品与数字（2026-09-16）。
//
// 【它是什么】用户原话「直接在网页上读取对应的信息」——他指着 Gemini 的自动浏览：打开网页，
// 读页面上写着的东西，总结出来。手写解析器与配方是结构化的路，准、稳、不烧额度；但它们认不出的页面
// （站点改版了、配方还在学、平台没有解析器）不该停在一句「解析器没认出」——页面就在那儿，人读得到，
// 模型也读得到。执行器把页面可见文字与链接带回（PAGE_READ_FN），这里让模型把它读成结构化数据。
//
// 【它绝不能是什么】不能是「模型说了算」。这个项目里每一条入库的数字都有出处（缺席不许当成 0、
// Mock 数据绝不落库、指标串台事故…），模型直读最容易出的事就是把没有的数字编出来、把隔壁作品的数字
// 挂错。所以三道机器闸，与配方学习那条「模型只许提候选、逐 token 对骨架」同一个思路：
//   ① 作品 ID **只从链接里抠**（parsePublishUrl / platformItemIdFrom），模型只能引用页面上真实存在的
//      链接编号，编不出 ID 就没有这条作品；
//   ② 每个数字必须**在页面文字里原样出现**（「1.2万」就得有「1.2万」），不在就丢掉这个指标；
//   ③ 数字按 parseHumanCount 解析，解析不出就缺席，绝不写 0。
// 这条路的产出在回执与台账里都标成「模型直读」，用户看得出这份数据是怎么来的。
import { llmComplete } from '../llm/gateway';
import { parsePublishUrl } from '../publish/parse-url';
import { parseHumanCount, parseLooseDate, platformItemIdFrom } from '../scrape/platform-map';
import { isRecipePlatform } from '../scrape/platform-recipes';
import type { PageRead } from './local-collect';

export type ExtractedPost = {
  platformItemId: string;
  url: string;
  title?: string;
  publishedAt?: string;
  metrics: Record<string, number>;
};

export type ExtractedPage = {
  profile: { name?: string; followers?: number };
  posts: ExtractedPost[];
  /** 模型给了、但被闸挡掉的作品数（回执里说破，别让「读出 3 条」看着像全部） */
  dropped: number;
  /** 页面上能认出作品 ID 的链接数——为 0 时模型直读根本无从下手 */
  candidates: number;
};

export type ExtractResult = { ok: true; data: ExtractedPage } | { ok: false; error: string };

/** 页面文字最多喂模型多少字。主页的作品列表几乎总在前半段；喂太多既慢又贵。 */
export const MAX_EXTRACT_TEXT_CHARS = 14_000;
/** 最多给模型多少条候选链接（每条都是认得出作品 ID 的）。 */
export const MAX_EXTRACT_LINKS = 60;

const METRIC_KEYS = ['views', 'likes', 'comments', 'shares', 'collects'] as const;

/** 从一条链接里抠作品 ID：六个手写平台走 parsePublishUrl，五个配方平台走 platformItemIdFrom。平台对不上就不算。 */
export function itemIdFromLink(platform: string, href: string): string | null {
  if (isRecipePlatform(platform)) return platformItemIdFrom(platform, href);
  const r = parsePublishUrl(href);
  return r.ok && r.platform === platform ? r.platformItemId : null;
}

/** 页面上认得出作品 ID 的链接（去重、封顶）。 */
export function candidateLinks(platform: string, read: PageRead): { id: string; href: string; text: string }[] {
  const out: { id: string; href: string; text: string }[] = [];
  const seen = new Set<string>();
  for (const l of read.links ?? []) {
    const id = itemIdFromLink(platform, l.href);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, href: l.href, text: l.text });
    if (out.length >= MAX_EXTRACT_LINKS) break;
  }
  return out;
}

/** 闸 ②：这串数字（模型原样抄的）在页面文字里出现过吗。空白与逗号不算差异。 */
export function appearsInText(raw: string, text: string): boolean {
  const norm = (s: string) => s.replace(/[\s,，]/g, '');
  const r = norm(raw);
  if (!r) return false;
  return norm(text).includes(r);
}

function readMetric(raw: unknown, text: string): number | undefined {
  if (raw == null) return undefined;
  const s = String(raw).trim();
  if (!s || !appearsInText(s, text)) return undefined;
  return parseHumanCount(s);
}

export function buildExtractPrompt(platform: string, read: PageRead, links: { id: string; href: string; text: string }[]): string {
  const list = links.map((l, i) => `[${i}] ${l.text || '（无文字）'} → ${l.href}`).join('\n');
  return [
    `下面是一个${platform}平台页面上**可见的文字**与**页内作品链接清单**。请只根据页面文字，读出账号信息与每条作品的数据，输出 JSON。`,
    '规则（违反任何一条这份结果都会被丢弃）：',
    '1. 只能引用链接清单里的编号（link 字段填编号数字），不能凭空造作品；',
    '2. 数字一律**原样抄页面上的写法**（如 "1.2万"、"3,456"、"12k"），不要换算，页面上没写的字段直接省略；',
    '3. 每条作品的数字必须是页面上紧挨着这条作品标题/封面的那组数字，拿不准就省略，不要猜；',
    '4. 输出严格 JSON：{"profile":{"name":"账号昵称","followers":"粉丝数原样"},"posts":[{"link":0,"title":"标题","publishedAt":"发布时间原样","views":"播放/阅读","likes":"点赞","comments":"评论","shares":"转发/分享","collects":"收藏"}]}',
    '',
    '【作品链接清单】',
    list || '（无）',
    '',
    '【页面文字】',
    read.text.slice(0, MAX_EXTRACT_TEXT_CHARS),
  ].join('\n');
}

/**
 * 让模型从页面内容里读出作品与数字，并过三道闸。
 * tenantId 为 null 时按平台垫付路由（llmComplete 的既有语义）。
 */
export async function extractPostsFromPage(input: { tenantId: string | null; platform: string; read: PageRead }): Promise<ExtractResult> {
  const { platform, read } = input;
  const links = candidateLinks(platform, read);
  if (links.length === 0 && !read.text.trim()) return { ok: false, error: '页面上既没有可读的文字，也没有认得出作品 ID 的链接' };

  let raw: { profile?: { name?: unknown; followers?: unknown }; posts?: unknown[] } = {};
  try {
    const r = await llmComplete(input.tenantId, 'agent', [{ role: 'user', content: buildExtractPrompt(platform, read, links) }], { json: true, temperature: 0 });
    if (r.mocked) return { ok: false, error: '示例模型不能直读页面，请先配好模型渠道' };
    raw = JSON.parse((r.text ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '')) as typeof raw;
  } catch (e) {
    return { ok: false, error: `模型没给出可用的结果：${e instanceof Error ? e.message : String(e)}` };
  }

  const profile: ExtractedPage['profile'] = {};
  const name = typeof raw.profile?.name === 'string' ? raw.profile.name.trim().slice(0, 100) : '';
  if (name && read.text.includes(name)) profile.name = name;
  const followers = readMetric(raw.profile?.followers, read.text);
  if (followers !== undefined) profile.followers = followers;

  const posts: ExtractedPost[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const item of Array.isArray(raw.posts) ? raw.posts : []) {
    const p = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const idx = typeof p.link === 'number' ? p.link : Number(p.link);
    const link = Number.isInteger(idx) ? links[idx] : undefined;
    if (!link || seen.has(link.id)) { dropped += 1; continue; }
    const metrics: Record<string, number> = {};
    for (const k of METRIC_KEYS) {
      const v = readMetric(p[k], read.text);
      if (v !== undefined) metrics[k] = v;
    }
    // 一个数都没读到的作品不入库（与后台解析器同一条：空记录会进基线/榜单/喂模型，比 0 条更糟）
    if (Object.keys(metrics).length === 0) { dropped += 1; continue; }
    seen.add(link.id);
    const title = typeof p.title === 'string' ? p.title.trim().slice(0, 300) : '';
    const at = typeof p.publishedAt === 'string' && appearsInText(p.publishedAt, read.text) ? parseLooseDate(p.publishedAt) : undefined;
    posts.push({
      platformItemId: link.id,
      url: link.href,
      ...(title ? { title } : {}),
      ...(at ? { publishedAt: at.toISOString() } : {}),
      metrics,
    });
    if (posts.length >= 50) break;
  }
  return { ok: true, data: { profile, posts, dropped, candidates: links.length } };
}
