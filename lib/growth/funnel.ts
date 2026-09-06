import { prisma } from '../db';
import { beijingDayKey } from '../beijing';
import { createLogger } from '../logger';

// 漏斗事件（2026-09-05 增长缺口整改）。
//
// 【它回答的唯一问题】陌生人从「看到首页」到「装上客户端 / 第一次有数据回流」，走到了哪一步、
// 在哪一步走掉的。此前全站没有一行访问埋点，这个问题只能猜——包括 09-05 那份增长报告本身。
//
// 【三条不许违反的】与 lib/geo/crawler-log.ts 同一套：
// ① 绝不抛：挂在真实请求路径上，统计写失败不能连累页面/动作。
// ② 绝不阻塞：调用方 fire-and-forget（用 recordFunnelEventAsync）。
// ③ 不记身份：不存 IP、不存 UA、不存查询串。visitorId 是浏览器里随机生成的匿名串，
//    只用来把同一个人的几步串起来算转化率。

const log = createLogger({ module: 'funnel' });

/**
 * 八个漏斗事件 + 三个补充。白名单：/api/track 只收这些名字，别的一律 400。
 *
 *   landing_view          看到公开首页
 *   demo_click            点了「免注册体验」
 *   code_sent             发出了一条登录验证码（服务端记）
 *   register_ok           新租户建成（服务端记，带 tenantId）
 *   persona_created       人设从空白变成非空（服务端记）
 *   first_recommendation  第一次生成出选题推荐（服务端记）
 *   download_click        点了下载按钮，meta = mac / win / ext-store / ext-zip
 *   first_ingest          第一次有采集数据回到工作区（服务端记）
 *   pricing_view          看了价格页
 *   onboarding_done       冷启动向导跑完
 *   invite_accept         通过邀请码注册（服务端记）
 */
export const FUNNEL_EVENTS = [
  'landing_view',
  'demo_click',
  'code_sent',
  'register_ok',
  'persona_created',
  'first_recommendation',
  'download_click',
  'first_ingest',
  'pricing_view',
  'onboarding_done',
  'invite_accept',
] as const;
export type FunnelEventName = (typeof FUNNEL_EVENTS)[number];

/** 漏斗主干的顺序：运维台按这个顺序算「上一步 → 这一步」的转化率。 */
export const FUNNEL_ORDER: readonly FunnelEventName[] = [
  'landing_view', 'demo_click', 'code_sent', 'register_ok', 'persona_created', 'first_recommendation', 'download_click', 'first_ingest',
];

export const FUNNEL_LABEL: Record<FunnelEventName, string> = {
  landing_view: '看到首页',
  demo_click: '点免注册体验',
  code_sent: '发验证码',
  register_ok: '注册成功',
  persona_created: '建好人设',
  first_recommendation: '首次出推荐',
  download_click: '点下载',
  first_ingest: '首次数据回流',
  pricing_view: '看价格页',
  onboarding_done: '跑完冷启动向导',
  invite_accept: '凭邀请码注册',
};

export const FUNNEL_LABEL_EN: Record<FunnelEventName, string> = {
  landing_view: 'View Landing Page',
  demo_click: 'Click Try Demo',
  code_sent: 'Send SMS Code',
  register_ok: 'Registered Successfully',
  persona_created: 'Create Persona',
  first_recommendation: 'First Recommendation',
  download_click: 'Click Download',
  first_ingest: 'First Ingestion',
  pricing_view: 'View Pricing Page',
  onboarding_done: 'Complete Onboarding',
  invite_accept: 'Register via Invite Code',
};

export function isFunnelEvent(x: unknown): x is FunnelEventName {
  return typeof x === 'string' && (FUNNEL_EVENTS as readonly string[]).includes(x);
}

const MAX_PATH = 200;
const MAX_META = 60;
const MAX_VISITOR = 64;

/** 路径归一化：去查询串、去锚、去尾斜杠、截断（查询串里可能有我们不想留的东西）。 */
export function normalizeFunnelPath(raw: unknown): string {
  const p = String(raw ?? '').split('?')[0].split('#')[0];
  const trimmed = p.length > 1 ? p.replace(/\/+$/, '') : p;
  return trimmed.slice(0, MAX_PATH);
}

/** visitorId 只认「字母数字-_」且 ≤64：它是我们自己生成的随机串，别的形状一律丢掉。 */
export function normalizeVisitorId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v.slice(0, MAX_VISITOR) : null;
}

export type FunnelInput = {
  name: FunnelEventName;
  path?: string;
  meta?: string;
  visitorId?: string | null;
  tenantId?: string | null;
};

/** 记一笔。不抛；写失败只打 warn。 */
export async function recordFunnelEvent(input: FunnelInput, now: Date = new Date()): Promise<boolean> {
  if (!isFunnelEvent(input.name)) return false;
  try {
    await prisma.funnelEvent.create({
      data: {
        name: input.name,
        path: normalizeFunnelPath(input.path ?? ''),
        meta: String(input.meta ?? '').slice(0, MAX_META),
        visitorId: normalizeVisitorId(input.visitorId),
        tenantId: input.tenantId ?? null,
        day: beijingDayKey(now),
        createdAt: now,
      },
    });
    return true;
  } catch (e) {
    log.warn('漏斗事件写入失败（不影响主流程）', { name: input.name, error: (e as Error).message });
    return false;
  }
}

/** fire-and-forget 版：不 await 到响应里去。 */
export function recordFunnelEventAsync(input: FunnelInput): void {
  void recordFunnelEvent(input).catch(() => undefined);
}

/**
 * 「某租户是不是第一次发生某事」——服务端事件（首次推荐 / 首次回流）要靠它判断只记一次。
 * 查的是本表：一次 count，比在业务表上数便宜且与业务口径解耦。
 */
export async function tenantHasEvent(tenantId: string, name: FunnelEventName): Promise<boolean> {
  try {
    return (await prisma.funnelEvent.count({ where: { tenantId, name } })) > 0;
  } catch {
    return true; // 查不到就当已记过：宁可少记一条，不重复记
  }
}

/** 只在这个租户还没发生过时记一次。 */
export async function recordFunnelOnce(input: FunnelInput & { tenantId: string }): Promise<boolean> {
  if (await tenantHasEvent(input.tenantId, input.name)) return false;
  return recordFunnelEvent(input);
}

export type FunnelStep = { name: FunnelEventName; label: string; count: number; visitors: number; fromPrevPct: number | null };
export type FunnelSummary = {
  days: number;
  steps: FunnelStep[];
  downloads: { meta: string; count: number }[];
  extras: { name: FunnelEventName; label: string; count: number }[];
};

/**
 * 运维台用的汇总：最近 N 天每一步的次数、独立访客数、相对上一步的转化率。
 *
 * 【转化率口径】用**独立访客/租户数**比，不用次数比：同一个人刷十次首页不该算十个人。
 * 服务端事件没有 visitorId，按 tenantId 去重；两者都没有的行按次数算。
 * 分母为 0 时给 null（页面显示「—」），不显示 0%——那会被当成「转化为零」的真值。
 */
export async function funnelSummary(days = 7, now: Date = new Date()): Promise<FunnelSummary> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const rows = await prisma.funnelEvent.findMany({
    where: { createdAt: { gte: since } },
    select: { name: true, meta: true, visitorId: true, tenantId: true },
  });
  const byName = new Map<string, { count: number; ids: Set<string> }>();
  for (const r of rows) {
    const b = byName.get(r.name) ?? { count: 0, ids: new Set<string>() };
    b.count += 1;
    const id = r.visitorId ?? (r.tenantId ? `t:${r.tenantId}` : null);
    b.ids.add(id ?? `n:${b.count}`);
    byName.set(r.name, b);
  }
  const steps: FunnelStep[] = [];
  let prev: number | null = null;
  for (const name of FUNNEL_ORDER) {
    const b = byName.get(name);
    const visitors = b?.ids.size ?? 0;
    const pct = prev === null || prev === 0 ? null : Math.round((visitors / prev) * 1000) / 10;
    steps.push({ name, label: FUNNEL_LABEL[name], count: b?.count ?? 0, visitors, fromPrevPct: pct });
    prev = visitors;
  }
  const dl = new Map<string, number>();
  for (const r of rows) if (r.name === 'download_click') dl.set(r.meta || '(未标)', (dl.get(r.meta || '(未标)') ?? 0) + 1);
  const extras = (['pricing_view', 'onboarding_done', 'invite_accept'] as FunnelEventName[]).map((name) => ({
    name, label: FUNNEL_LABEL[name], count: byName.get(name)?.count ?? 0,
  }));
  return {
    days,
    steps,
    downloads: [...dl.entries()].map(([meta, count]) => ({ meta, count })).sort((a, b) => b.count - a.count),
    extras,
  };
}
