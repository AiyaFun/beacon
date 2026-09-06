'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { requireRole } from '@/lib/rbac';
import { toJson } from '@/lib/json';
import { readPersona, sanitizePersonaCard, type PersonaCard } from '@/lib/persona';
import { cookies } from 'next/headers';
import { PLATFORMS, platformName } from '@/lib/constants';
import { ACCOUNT_COOKIE } from '@/lib/auth-constants';
import { parseCompetitorUrl } from '@/lib/competitor-url';
import { crawlOneCompetitor } from '@/lib/pipeline';
import { hasCollector, enqueueBrowserTask } from '@/lib/browser-task';
import { vetBrowserTaskArgs } from '@/lib/browser-task/vet';
import { loadReadiness } from '@/lib/topic/readiness';
import { recordFunnelOnce } from '@/lib/growth/funnel';
import { actSavePersona } from '@/app/(app)/persona/actions';
import { actGenerateRecommendations } from '@/app/(app)/actions';
import { normalizeNiche } from '@/lib/topic/niches';

// 十分钟开场向导（2026-09-05 增长缺口整改）。
//
// 【它要解决的】lib/topic/readiness.ts 文件头写着：新用户第一天八个候选源只有三个出货，看到的是
// 「热榜 + 万年历」。原对策是一张「哪几个源沉默、去哪解锁」的清单——把作业推回给用户。
// 这里把清单变成系统自己做：一次表单 → 建人设 → 订同行 → 派采集 → 当场跑一次推荐 → 回报点亮了几个源。
//
// 【三条红线】
// ① 不编造：人设里只放用户说过的（赛道、平台、一句话）；没说的字段留空，让 /persona 那条 AI 追问路去补。
// ② 不假装采到了：能派的就派（服务端通道 / 在线的执行器），派不出去的平台如实说要装客户端或插件。
// ③ 复用已有动作：保存人设走 actSavePersona（预装技能那套一起带上），生成推荐走 actGenerateRecommendations。

type UrlResult = { url: string; ok: boolean; note: string };

export async function actOnboardingProfile(input: {
  niche: string;
  platforms: string[];
  sentence?: string;
  profileUrl?: string;
}): Promise<{ ok: true; persona: PersonaCard; profile: UrlResult | null } | { ok: false; error: string }> {
  const s = await getSession();
  requireRole(s, 'persona.edit');

  const niche = normalizeNiche(input.niche, '');
  if (!niche) return { ok: false, error: '赛道词要 2 到 20 个字，比如「职场成长」「家常菜」' };
  const platforms = [...new Set((input.platforms ?? []).filter((p) => p in PLATFORMS))].slice(0, 5);
  if (platforms.length === 0) return { ok: false, error: '至少选一个主战平台——「抢跑窗口」要知道话题还没到哪儿' };
  const sentence = (input.sentence ?? '').trim().slice(0, 200);

  const account = await prisma.creatorAccount.findUnique({ where: { id: s.accountId }, select: { personaCard: true, platform: true, handle: true } });
  const existing = readPersona(account?.personaCard ?? '{}');
  // 只写用户给的：identity 用他那句话；没说就用一句只含赛道词的中性表述，UI 上标「待完善」
  const card: PersonaCard = sanitizePersonaCard({
    ...existing,
    niche,
    platforms,
    identity: sentence || existing.identity || `做${niche}内容的创作者`,
  });
  const saved = await actSavePersona(toJson(card));
  if (!saved.ok) return { ok: false, error: saved.error ?? '保存人设失败' };

  // 主页链接 → 「自己的账号」。
  //
  // 【2026-09-06 用户原话「新注册的账号，没有增加一个自己的账号？」】注册时建的是一条名叫
  // 「我的账号」、platform=multi、没有 handle 的占位行；这一步原先只往占位行上写 platform/handle，
  // 名字一动不动——顶栏和「账号管理」看到的仍是「我的账号 · 多平台」，用户当然觉得没加。
  // 没贴链接时更是什么都不动，连他刚选的主战平台都不落到账号上。现在：
  //   · 认出链接 → 占位行变成真账号（名字带平台与 ID）；占位行已被别的平台占了就另建一条并切过去
  //   · 没贴链接 → 只选了一个主战平台时把占位行标成那个平台（这是他自己选的，不是猜）；并如实说「还没记下账号」
  //   · 没认出链接 → 说清支持哪些形态，别让人以为记上了
  let profile: UrlResult | null = null;
  const url = (input.profileUrl ?? '').trim();
  const parsed = url ? parseCompetitorUrl(url) : null;
  // 链接为空或认不出：至少把他明选的唯一主战平台落到占位账号上（选了多个就不猜，仍是 multi）
  if (!parsed && account && account.platform === 'multi' && !account.handle && platforms.length === 1) {
    await prisma.creatorAccount.update({ where: { id: s.accountId }, data: { platform: platforms[0] } });
  }
  if (url && !parsed) {
    profile = {
      url,
      ok: false,
      note: '没认出是哪个平台的主页链接（认得：douyin.com/user/…、xiaohongshu.com/user/profile/…、x.com/用户名、tiktok.com/@…、space.bilibili.com/数字、youtube.com/@…；短链认不出）。先跳过，之后可在「记忆与人设 → 账号管理」里填',
    };
  } else if (parsed) {
    const own = await claimOwnAccount({ workspaceId: s.workspaceId, currentId: s.accountId, parsed, personaCard: toJson(card) });
    const label = `${platformName(parsed.platform)} @${parsed.handle}`;
    const verdict = await vetBrowserTaskArgs(s.workspaceId, { kind: 'collect_self_profile', platform: parsed.platform }, { preferAccountId: own.id });
    if (verdict.ok && !('local' in verdict && verdict.local)) {
      const q = await enqueueBrowserTask({ workspaceId: s.workspaceId, accountId: own.id, payload: verdict.payload, origin: 'user', createdBy: s.memberId });
      profile = q.ok
        ? { url, ok: true, note: `已记下你的账号「${label}」，并派了一次「回填我的主页」——客户端或插件领到后几分钟内数据回来` }
        : { url, ok: true, note: `已记下你的账号「${label}」；派采集没成功：${q.error}` };
    } else {
      profile = {
        url,
        ok: true,
        note: verdict.ok
          ? `已记下你的账号「${label}」，本机浏览器会当场去采`
          : `已记下你的账号「${label}」。${verdict.error}`,
      };
    }
  } else {
    profile = {
      url: '',
      ok: false,
      note: '还没记下你自己的主页——你的数据要回流到哪个账号得靠它。之后去「记忆与人设 → 账号管理」贴主页链接或填 ID 就行',
    };
  }
  revalidatePath('/', 'layout'); // 顶栏账号名变了，只刷页面不够
  revalidatePath('/persona');
  return { ok: true, persona: card, profile };
}

const DEFAULT_ACCOUNT_NAME = '我的账号'; // 与 lib/auth.ts 注册时建的占位行同名

/**
 * 把「认出的主页」落成一条真正属于用户的 CreatorAccount，返回它。
 *   · 当前账号还没 handle（注册占位行，或用户手建的空账号）→ 就地升级：platform/handle 写上，
 *     名字还是缺省「我的账号」的话改成「平台 @ID」，顶栏一眼能看出是自己的号
 *   · 当前账号已是同一平台同一 ID → 幂等，什么都不动（重跑向导）
 *   · 当前账号已被别的平台/ID 占了 → 同工作区找一条同平台同 ID 的，没有就新建（带上刚存的人设卡），
 *     并把当前账号 cookie 切过去，后面订同行、跑推荐都记到这条上
 */
async function claimOwnAccount(args: { workspaceId: string; currentId: string; parsed: { platform: string; handle: string }; personaCard: string }) {
  const { workspaceId, currentId, parsed, personaCard } = args;
  const cur = await prisma.creatorAccount.findFirst({ where: { id: currentId, workspaceId }, select: { id: true, name: true, platform: true, handle: true } });
  const label = `${platformName(parsed.platform)} @${parsed.handle}`;
  if (cur && cur.platform === parsed.platform && cur.handle === parsed.handle) return cur;
  if (cur && !cur.handle) {
    return prisma.creatorAccount.update({
      where: { id: cur.id },
      data: { platform: parsed.platform, handle: parsed.handle, ...(cur.name === DEFAULT_ACCOUNT_NAME ? { name: label } : {}) },
      select: { id: true, name: true, platform: true, handle: true },
    });
  }
  const existing = await prisma.creatorAccount.findFirst({
    where: { workspaceId, platform: parsed.platform, handle: parsed.handle, status: 'active' },
    select: { id: true, name: true, platform: true, handle: true },
  });
  const target = existing ?? (await prisma.creatorAccount.create({
    data: { workspaceId, name: label, platform: parsed.platform, handle: parsed.handle, personaCard, styleFingerprint: toJson({ voice: [], format: [], topic: [] }) },
    select: { id: true, name: true, platform: true, handle: true },
  }));
  const store = await cookies();
  store.set(ACCOUNT_COOKIE, target.id, { httpOnly: true, sameSite: 'lax', maxAge: 180 * 24 * 3600, path: '/' });
  return target;
}

/** 库里已经有作品、且作品标题里出现过这个赛道词的同行——给用户挑，不是替他决定。 */
export async function actOnboardingSuggest(nicheRaw: string): Promise<{ id: string; platform: string; name: string; handle: string; posts: number }[]> {
  const s = await getSession();
  requireRole(s, 'competitor.manage');
  const niche = normalizeNiche(nicheRaw, '');
  if (!niche) return [];
  const rows = await prisma.crawledPost.findMany({
    where: { title: { contains: niche } },
    select: { competitorId: true },
    take: 300,
    orderBy: { publishedAt: 'desc' },
  });
  const count = new Map<string, number>();
  for (const r of rows) count.set(r.competitorId, (count.get(r.competitorId) ?? 0) + 1);
  const ids = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id]) => id);
  if (ids.length === 0) return [];
  const already = new Set((await prisma.watchlistItem.findMany({ where: { workspaceId: s.workspaceId, competitorId: { in: ids } }, select: { competitorId: true } })).map((w) => w.competitorId));
  const comps = await prisma.competitorAccount.findMany({ where: { id: { in: ids } }, select: { id: true, platform: true, name: true, handle: true } });
  return comps.filter((c) => !already.has(c.id)).map((c) => ({ ...c, posts: count.get(c.id) ?? 0 }));
}

/** 订同行：贴的链接 + 挑中的库内账号。订完立刻试采一次；服务端没通道且有执行器在线就派给执行器。 */
export async function actOnboardingCompetitors(input: { urls: string[]; competitorIds: string[] }): Promise<{ ok: true; results: UrlResult[]; subscribed: number } | { ok: false; error: string }> {
  const s = await getSession();
  requireRole(s, 'competitor.manage');
  const results: UrlResult[] = [];
  const ids: { id: string; label: string }[] = [];

  for (const raw of (input.urls ?? []).map((x) => x.trim()).filter(Boolean).slice(0, 5)) {
    const parsed = parseCompetitorUrl(raw);
    if (!parsed) {
      results.push({ url: raw, ok: false, note: '没认出是哪个平台的主页链接' });
      continue;
    }
    const comp = await prisma.competitorAccount.upsert({
      where: { platform_handle: { platform: parsed.platform, handle: parsed.handle } },
      update: {},
      create: { platform: parsed.platform, handle: parsed.handle, name: parsed.handle },
    });
    ids.push({ id: comp.id, label: raw });
  }
  for (const id of (input.competitorIds ?? []).slice(0, 6)) {
    const comp = await prisma.competitorAccount.findUnique({ where: { id }, select: { id: true, name: true } });
    if (comp) ids.push({ id: comp.id, label: comp.name });
  }
  if (ids.length === 0) return { ok: true, results, subscribed: 0 };

  const collector = await hasCollector(s.workspaceId);
  for (const { id, label } of ids) {
    await prisma.watchlistItem.upsert({
      where: { workspaceId_competitorId: { workspaceId: s.workspaceId, competitorId: id } },
      update: {},
      create: { workspaceId: s.workspaceId, competitorId: id },
    });
    let note = '已订阅';
    try {
      const r = await crawlOneCompetitor(id, { workspaceId: s.workspaceId, channel: 'manual' });
      if (r.posts > 0) note = `已订阅，服务端刚采到 ${r.posts} 条`;
      else if (collector) {
        const verdict = await vetBrowserTaskArgs(s.workspaceId, { kind: 'collect_competitor', competitorId: id, limit: 20 });
        if (verdict.ok && !('local' in verdict && verdict.local)) {
          const q = await enqueueBrowserTask({ workspaceId: s.workspaceId, payload: verdict.payload, origin: 'user', createdBy: s.memberId });
          note = q.ok ? '已订阅，已派给你的采集器（客户端 / 插件），几分钟内作品回来' : `已订阅；派采集没成功：${q.error}`;
        } else note = `已订阅；${verdict.ok ? '本机浏览器会当场去采' : verdict.error}`;
      } else note = '已订阅；这个平台没有服务端通道，装桌面客户端或插件后会自动补采';
    } catch (e) {
      note = `已订阅；试采失败：${(e as Error).message.slice(0, 60)}`;
    }
    results.push({ url: label, ok: true, note });
  }
  revalidatePath('/competitors');
  revalidatePath('/topics');
  return { ok: true, results, subscribed: ids.length };
}

/** 当场跑一次推荐（热榜 → 竞对 → 精排），与首页按钮同一条链路。 */
export async function actOnboardingGenerate(): Promise<{ ok: true; created: number } | { ok: false; error: string }> {
  const r = await actGenerateRecommendations();
  if ('ok' in r && r.ok === false) return { ok: false, error: r.error };
  return { ok: true, created: (r as { created: number }).created };
}

/** 八源就绪度 + 记一次「跑完向导」。 */
export async function actOnboardingReadiness(): Promise<{ active: number; total: number; sources: { key: string; name: string; state: 'active' | 'dormant'; reason: string; action?: { text: string; href: string } }[] }> {
  const s = await getSession();
  const r = await loadReadiness(s.workspaceId, s.accountId);
  void recordFunnelOnce({ name: 'onboarding_done', tenantId: s.tenantId }).catch(() => undefined);
  revalidatePath('/');
  return { active: r.active, total: r.total, sources: r.sources.map((x) => ({ key: x.key, name: x.name, state: x.state, reason: x.reason, action: x.action })) };
}
